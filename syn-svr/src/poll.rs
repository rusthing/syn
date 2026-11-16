//! # 数据抽取入口（sql 快照 / sql 游标 / http 分页）
//!
//! 「poll 入口」是一个 **HTTP 端点**：`POST /syn/source/{id}/pull`。调度不属于 syn ——
//! 按 `doc/syn-通用同步模型.md` §2.3，由 jobx 定时打这个端点，天然单点触发、有执行
//! 历史、失败可见。syn 自己不需要依赖 jobx 的 Rust 客户端。
//!
//! ## 一轮做什么
//!
//! ```text
//! 读 syn_source → 读 syn_cursor（没有就建）→ 取数 → 每行包成虚拟 topic 记录
//!   → 逐行走 sync_svc::handle（和 sink 推送完全同一条链路）
//!   → 只有连续成功的行才推进水位；遇到 fatal / retriable 立刻停，下一轮从断点重跑
//! ```
//!
//! ## 三种抽取的节奏不一样
//!
//! - **sql / 游标增量**：按 `(主游标, 决胜字段)` 复合游标取一批，一轮一批，天然增量。
//! - **sql / 全量快照**：一轮把整表拉完；分批模式在调用内循环翻页。拉完写
//!   `{"snapshot":{"done":true,"rows":n}}`，此后调度跳过；要重跑得显式 reset。
//! - **http**：全量分页，**一轮推一页**。翻到底写 `{"http":{"done":true}}`，此后调度
//!   跳过；要重跑得显式 reset（`POST /syn/source/{id}/pull?reset=true`）。一轮一页是
//!   为了断点可续：页与页之间进程挂了，下一轮从上次的下一页继续，不用从头再来。
//!
//! ## 四条边界（不是待办，是轮询的固有性质）
//!
//! 1. **复合游标 + 5 秒重叠**：`(主游标, 决胜字段)` 两列比较，且时间戳游标只取
//!    `<= now()-5s` 的行，避免读到还没提交的事务。重复行由下游 upsert 吸收。
//! 2. **删除捕获不到**：查不到已删的行。要软删标记或全量对账，不能假装支持。
//!    全量快照同样只是 upsert，**不按「缺失」删**（见 §11.14）。
//! 3. **单写者**：jobx 单点触发；进程内另有一把锁挡住「按钮连点」。两个副本同时拉会
//!    重复投递并互相覆盖水位，所以游标更新带 `update_ms` 乐观条件，输了的一轮作废。
//! 4. **游标存 syn 库**：不污染业务库；游标推进与下游投递**不同事务**，中间挂了会重投
//!    少量行，靠下游幂等/upsert 吸收。
//!
//! 全量（快照 / http）的使用前提：**只用于首次同步**，增量交给游标模式或 dbz。两边
//! 同时写同一张表会让旧快照覆盖新值、删除语义打架 —— 四条前提见
//! `doc/syn-开发规范.md` §11.14。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use syn_api::{ExtractMode, FieldType, SourceKind, SourceSpec, SynSourcePullVo, Verdict, WrapMode};
use syn_core::get_path;
use sqlx::Row;
use tokio::sync::Mutex;
use tracing::{info, warn};
use wheel_rs::time_utils::now_ms;

use crate::config::get_app_config;
use crate::dao::SynCursorDao;
use crate::db_sink::DbSinks;
use crate::mo::syn_cursor::{ActiveModel as CursorActive, Column as CursorColumn};
use crate::mo::syn_cursor::Model as CursorModel;
use crate::mo::syn_source::Model as SourceModel;
use crate::svc::handle;

/// 同一进程内正在拉的数据抽取。挡住按钮连点；跨副本靠 jobx 单点 + 乐观更新
static IN_FLIGHT: LazyLock<Mutex<HashSet<i64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// 重叠窗口：只取 5 秒前的行，避开正在提交的事务
const OVERLAP_SECONDS: u32 = 5;

/// 页码模式的安全上限：接口若忽略 `{cursor}`，取数会永远「有数据」
const MAX_PAGES: u32 = 100_000;

/// # 拉一轮
///
/// 返回本轮推进到哪儿、四类结论各多少行、以及卡住的原因。业务侧的 fatal / retriable
/// **不是接口错误**：接口仍返回 200，让运维在结果里看到「被哪条数据卡住了」。
pub async fn pull_once(id: U64) -> Result<SynSourcePullVo, SvcError> {
    let source_id = id.value() as i64;
    {
        let mut set = IN_FLIGHT.lock().await;
        if !set.insert(source_id) {
            return Err(SvcError::Runtime(anyhow::anyhow!(
                "数据抽取 {source_id} 正在拉取，请勿重复触发"
            )));
        }
    }
    let result = pull(id).await;
    IN_FLIGHT.lock().await.remove(&source_id);
    result
}

async fn pull(id: U64) -> Result<SynSourcePullVo, SvcError> {
    let started = Instant::now();
    let run_ms = now_ms() as i64;
    let db = get_db_conn()?;
    let source = load_source(id.value() as i64, db.as_ref()).await?;
    let kind = SourceKind::from_i16(source.kind).unwrap_or_default();
    let spec = SourceSpec::parse(&source.spec)
        .map_err(|e| SvcError::Runtime(anyhow::anyhow!("数据抽取 {} 的 spec 不合法: {e}", source.code)))?;
    spec.validate(kind).map_err(|issues| {
        SvcError::Runtime(anyhow::anyhow!(
            "数据抽取 {} 的 spec 不合法: {}",
            source.code,
            issues.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("；")
        ))
    })?;

    let cursor = load_cursor(source.id, db.as_ref()).await?;

    match kind {
        SourceKind::Sql => match spec.mode {
            ExtractMode::Cursor => pull_sql(&source, &spec, cursor, run_ms, started).await,
            ExtractMode::Snapshot => pull_snapshot(&source, &spec, cursor, run_ms, started).await,
        },
        SourceKind::Http => pull_http(&source, &spec, cursor, run_ms, started).await,
    }
}

fn empty_pull_vo() -> SynSourcePullVo {
    SynSourcePullVo {
        rows: 0,
        duration_ms: 0,
        success: 0,
        skip: 0,
        fatal: 0,
        retriable: 0,
        position: None,
        stalled: None,
        full_done: None,
    }
}

/// # sql：按水位取一批
async fn pull_sql(
    source: &SourceModel,
    spec: &SourceSpec,
    cursor: CursorModel,
    run_ms: i64,
    started: Instant,
) -> Result<SynSourcePullVo, SvcError> {
    let mut out = empty_pull_vo();

    let fetched = match fetch_sql(source, spec, cursor.cursor_value.as_deref()).await {
        Ok(v) => v,
        Err(e) => {
            warn!("数据抽取 {} 拉取失败: {e}", source.code);
            save_error(cursor, run_ms, Some(e.as_str())).await?;
            out.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(with_stalled(out, e));
        }
    };

    let rows = fetched;
    deliver(&source.topic, &rows, &mut out).await;

    // 只有连续成功的行能推进水位：水位取**本批最后一条已投递行自己的位置**。
    // 不能用「整批最后一行的位置」——deliver 遇到第一条 fatal/retriable 就停，
    // 那之后的行还没投递，水位跳过去就再也不会重跑了（静默丢数据）。
    // 停在上一个成功行，下一轮重跑失败行及其后所有行（重复由下游 upsert 吸收）。
    let advanced = out.rows;
    let new_position = last_delivered_position(&rows, advanced);
    let error = out.stalled.clone();
    if advanced > 0 {
        let ok = advance_cursor(
            cursor,
            new_position.as_deref(),
            advanced as i64,
            run_ms,
            error.as_deref(),
        )
        .await?;
        if !ok {
            // 另一轮已经推进过水位：本轮投递已发生，但水位以对方为准，不回写
            warn!(
                "数据抽取 {} 的游标被并发更新，本轮不回写（下游重复由幂等吸收）",
                source.code
            );
            out.position = None;
            out.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(out);
        }
    } else {
        // 没有新行也要记「这一轮跑过了」，否则调度器会认为它一直没到期，空转到天亮
        save_error(cursor, run_ms, error.as_deref()).await?;
    }

    out.position = new_position;
    out.duration_ms = started.elapsed().as_millis() as u64;
    info!(
        "数据抽取 {} 拉取完成：{} 行，成功 {} / 跳过 {} / 失败 {} / 重试 {}，水位 {:?}",
        source.code, out.rows, out.success, out.skip, out.fatal, out.retriable, out.position
    );
    Ok(out)
}

/// # sql 全量快照：一轮把整表拉完
///
/// 分批模式（`snapshot_batched`）在**一次调用内**循环翻页，拉完才写完成标记；
/// 中途进程挂掉会从头再来一遍 —— 快照只用于初始化，重复行由下游 upsert 吸收。
async fn pull_snapshot(
    source: &SourceModel,
    spec: &SourceSpec,
    cursor: CursorModel,
    run_ms: i64,
    started: Instant,
) -> Result<SynSourcePullVo, SvcError> {
    let mut out = empty_pull_vo();
    let state = parse_snapshot_cursor(cursor.cursor_value.as_deref());

    if let SnapshotCursor::Done { rows } = state {
        info!(
            "数据抽取 {} 的全量快照已完成（{} 行），本轮跳过",
            source.code, rows
        );
        out.full_done = Some(true);
        out.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(out);
    }

    let batch = source.batch_size.max(1) as u64;
    let mut offset = 0u64;
    let mut carried = 0u64;

    loop {
        let rows = match fetch_snapshot_page(source, spec, offset).await {
            Ok(v) => v,
            Err(e) => {
                warn!("数据抽取 {} 拉取失败: {e}", source.code);
                save_error(cursor, run_ms, Some(e.as_str())).await?;
                out.duration_ms = started.elapsed().as_millis() as u64;
                out.full_done = Some(false);
                return Ok(with_stalled(out, e));
            }
        };
        let fetched = rows.len() as u64;
        deliver(&source.topic, &rows, &mut out).await;

        let stalled = out.stalled.clone();
        if let Some(reason) = stalled {
            // 快照没有逐行水位：被卡住就整轮作废，下一轮从第 1 批重拉
            save_error(cursor, run_ms, Some(reason.as_str())).await?;
            out.full_done = Some(false);
            out.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(out);
        }

        let total = carried + out.rows;
        // 单次全表一条 SQL 就结束；分批模式拉不满一批也结束
        if !spec.snapshot_batched || fetched < batch {
            let value = snapshot_done_cursor(total, run_ms);
            // 与游标增量同一条 CAS：多副本抢同一轮时只有一方写完成标记
            if !advance_cursor(cursor, Some(&value), out.rows as i64, run_ms, None).await? {
                warn!(
                    "数据抽取 {} 的游标被并发更新，本轮不回写（下游重复由幂等吸收）",
                    source.code
                );
                out.position = None;
                out.full_done = Some(false);
                out.duration_ms = started.elapsed().as_millis() as u64;
                return Ok(out);
            }
            out.position = Some(value);
            out.full_done = Some(true);
            out.duration_ms = started.elapsed().as_millis() as u64;
            info!(
                "数据抽取 {} 全量快照完成：累计 {} 行（本轮 {} 行）",
                source.code, total, out.rows
            );
            return Ok(out);
        }

        offset += fetched;
        carried = total;
    }
}

/// # http：全量，一轮推一页
///
/// 状态全在 `syn_cursor.cursor_value` 里，进程重启也能接着翻：
///
/// ```json
/// {"http":{"next":"2","rows":300}}      // 下一页的游标，以及已投递行数
/// {"http":{"done":true,"rows":1200}}    // 翻到底了，调度器此后跳过
/// ```
///
/// 一轮只推一页是刻意的：页与页之间进程挂了，下一轮从 `next` 继续，不用从头再来。
/// 代价是全量完成时间 = 页数 × 调度间隔；未完成的全量源在调度里不看 `interval`，
/// 每拍都推，所以实际是「每拍一页」。
async fn pull_http(
    source: &SourceModel,
    spec: &SourceSpec,
    cursor: CursorModel,
    run_ms: i64,
    started: Instant,
) -> Result<SynSourcePullVo, SvcError> {
    let mut out = empty_pull_vo();
    let state = parse_http_cursor(cursor.cursor_value.as_deref());

    if let HttpCursor::Done { rows } = state {
        // 已完成：直接返回，不去打源接口。手工改库或 reset 才能重跑
        info!("数据抽取 {} 的全量已完成（{} 行），本轮跳过", source.code, rows);
        out.full_done = Some(true);
        out.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(out);
    }

    let (start_cursor, carried) = match &state {
        HttpCursor::Start => (
            if spec.token_paging() {
                String::new()
            } else {
                "1".to_string()
            },
            0,
        ),
        HttpCursor::Next { cursor, rows } => (cursor.clone(), *rows),
        HttpCursor::Done { .. } => unreachable!("上面已 return"),
    };

    let page = match fetch_http_page(source, spec, &start_cursor).await {
        Ok(p) => p,
        Err(e) => {
            warn!("数据抽取 {} 拉取失败: {e}", source.code);
            save_error(cursor, run_ms, Some(e.as_str())).await?;
            out.duration_ms = started.elapsed().as_millis() as u64;
            out.full_done = Some(false);
            return Ok(with_stalled(out, e));
        }
    };

    deliver(&source.topic, &page.rows, &mut out).await;

    // 有行被卡住：水位不动，下一轮重拉同一页（重复由下游 upsert 吸收）
    if out.stalled.is_some() {
        save_error(cursor, run_ms, out.stalled.as_deref()).await?;
        out.full_done = Some(false);
        out.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(out);
    }

    let total = carried + out.rows;
    let (new_value, done) = match page.next {
        Some(next) => (http_next_cursor(&next, total), false),
        None => (http_done_cursor(total, run_ms), true),
    };

    // 与 sql 同一条 CAS：多副本抢同一页时只有一方推进
    if !advance_cursor(cursor, Some(&new_value), out.rows as i64, run_ms, None).await? {
        warn!(
            "数据抽取 {} 的游标被并发更新，本轮不回写（下游重复由幂等吸收）",
            source.code
        );
        out.position = None;
        out.full_done = Some(false);
        out.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(out);
    }

    out.position = Some(new_value);
    out.full_done = Some(done);
    out.duration_ms = started.elapsed().as_millis() as u64;
    if done {
        info!(
            "数据抽取 {} 全量同步完成：累计 {} 行（本轮 {} 行）",
            source.code, total, out.rows
        );
    } else {
        info!(
            "数据抽取 {} 全量同步推进：本轮 {} 行，累计 {} 行，下一页游标 {:?}",
            source.code,
            out.rows,
            total,
            out.position.as_deref().and_then(|p| p.strip_prefix("{\"http\":{\"next\":"))
        );
    }
    Ok(out)
}

/// # 逐行走投递链路
///
/// 与 sink 推送完全同一条链路（`svc::handle`）。遇到第一条 fatal / retriable 就停，
/// 把原因记进 `stalled`；调用方据此决定「水位不动」。
async fn deliver(topic: &str, rows: &[FetchedRow], out: &mut SynSourcePullVo) {
    for row in rows {
        let outcome = handle(topic, &row.record, None).await;
        match outcome.verdict {
            Verdict::Success => out.success += 1,
            Verdict::Skip => out.skip += 1,
            Verdict::Fatal => out.fatal += 1,
            Verdict::Retriable => out.retriable += 1,
        }
        if matches!(outcome.verdict, Verdict::Fatal | Verdict::Retriable) {
            out.stalled = Some(format!(
                "{} / {}: {}",
                outcome.code,
                outcome.task.clone().unwrap_or_default(),
                outcome.detail.clone().unwrap_or_default()
            ));
            break;
        }
        out.rows += 1;
    }
}

fn with_stalled(mut out: SynSourcePullVo, reason: String) -> SynSourcePullVo {
    out.stalled = Some(reason);
    out
}

/// # 一行取数结果
struct FetchedRow {
    /// 包成虚拟 topic 的记录
    record: Value,
    /// 这一行自己的水位（仅 sql 源有；http 全量的水位是整页游标，不逐行记）
    position: Option<String>,
}

/// 本批已投递前缀里最后一行的水位。
///
/// `delivered` 是 `deliver` 累计的成功/跳过行数，它只会是一个连续前缀：
/// 遇到第一条 fatal/retriable 就停，后面的行还没投递。水位必须停在**这一行**，
/// 否则下一轮会跳过未投递的行。
fn last_delivered_position(rows: &[FetchedRow], delivered: u64) -> Option<String> {
    let delivered = usize::try_from(delivered).ok()?;
    if delivered == 0 {
        return None;
    }
    rows.get(delivered - 1)?.position.clone()
}

/// # 按复合游标查源库（游标增量）
///
/// 表名与字段名来自配置，保存时按标识符白名单校验过，这里再校验一次；
/// 值一律绑参数，**没有字符串拼接用户输入**。
async fn fetch_sql(
    source: &SourceModel,
    spec: &SourceSpec,
    position: Option<&str>,
) -> Result<Vec<FetchedRow>, String> {
    let datasource = spec.datasource.as_deref().ok_or("spec.datasource 缺失")?;
    let from = row_source(spec)?;
    let fields = spec.cursor_fields();
    if fields.len() != 2 {
        return Err("spec.cursor_field / spec.tie_field 缺失".to_string());
    }
    let c = quote_col("s", fields[0])?;
    let t = quote_col("s", fields[1])?;

    // 水位：JSON 数组文本 [主游标, 决胜字段]
    let values: Option<Vec<String>> = position
        .map(|p| serde_json::from_str(p).unwrap_or_else(|_| vec![p.to_string()]))
        .filter(|v| v.len() == 2);

    let mut sql =
        format!("select to_jsonb(s) as row, {c}::text as k0, {t}::text as k1 from {from} s");
    let mut conds: Vec<String> = Vec::new();
    if values.is_some() {
        conds.push(format!(
            "({c}, {t}) > ($1::{}, $2::{})",
            spec.cursor_type.cast(),
            spec.tie_type.cast()
        ));
    }
    // 重叠窗口只对时间戳游标成立：整数/文本水位没有「事务提交时间」这一维度
    if spec.cursor_type == FieldType::Timestamptz {
        conds.push(format!(
            "{c} <= now() - interval '{OVERLAP_SECONDS} seconds'"
        ));
    }
    if !conds.is_empty() {
        sql.push_str(&format!(" where {}", conds.join(" and ")));
    }
    sql.push_str(&format!(
        " order by {c} asc, {t} asc limit {}",
        source.batch_size.max(1)
    ));

    let rows = fetch_rows(datasource, &sql, values.as_deref()).await?;

    let wrap = spec.wrap;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let row: Value = r
            .try_get("row")
            .map_err(|e| format!("读取源行失败: {e}"))?;
        let mut keys = Vec::with_capacity(2);
        for i in 0..2 {
            let k: Option<String> = r
                .try_get(format!("k{i}").as_str())
                .map_err(|e| format!("读取游标字段 {i} 失败: {e}"))?;
            keys.push(k.unwrap_or_default());
        }
        let record = wrap_row(row, wrap)?;
        // 每行带自己的水位：投递中途被卡住时，水位只能停到最后一个成功行
        let position = serde_json::to_string(&keys).map_err(|e| format!("水位序列化失败: {e}"))?;
        out.push(FetchedRow {
            record,
            position: Some(position),
        });
    }
    Ok(out)
}

/// # 全量快照拉一批
///
/// `snapshot_batched` 为真时按 `batch_size` + `offset` 翻页；为假时一条 SQL 拉全表。
/// 快照没有逐行水位（`position` 为空），进度由调用方整体推进。
async fn fetch_snapshot_page(
    source: &SourceModel,
    spec: &SourceSpec,
    offset: u64,
) -> Result<Vec<FetchedRow>, String> {
    let datasource = spec.datasource.as_deref().ok_or("spec.datasource 缺失")?;
    let from = row_source(spec)?;
    let sql = if spec.snapshot_batched {
        format!(
            "select to_jsonb(s) as row from {from} s limit {} offset {offset}",
            source.batch_size.max(1)
        )
    } else {
        format!("select to_jsonb(s) as row from {from} s")
    };

    let rows = fetch_rows(datasource, &sql, None).await?;
    let wrap = spec.wrap;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let row: Value = r
            .try_get("row")
            .map_err(|e| format!("读取源行失败: {e}"))?;
        out.push(FetchedRow {
            record: wrap_row(row, wrap)?,
            position: None,
        });
    }
    Ok(out)
}

/// 行 → 虚拟 topic 记录
fn wrap_row(row: Value, wrap: WrapMode) -> Result<Value, String> {
    match wrap {
        WrapMode::Row => Ok(json!({ "op": "r", "after": row })),
        WrapMode::Cdc => {
            if !row.is_object() {
                return Err("wrap=cdc 要求查询每行返回一个 JSON 对象".to_string());
            }
            Ok(row)
        }
    }
}

/// # 跑一条只读查询
async fn fetch_rows(
    datasource: &str,
    sql: &str,
    binds: Option<&[String]>,
) -> Result<Vec<sqlx::postgres::PgRow>, String> {
    let pool = DbSinks::pool_for(datasource)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.detail))?;
    let timeout = get_app_config()
        .map(|c| c.syn.pull_timeout())
        .unwrap_or(Duration::from_secs(30));

    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    if let Some(values) = binds {
        for x in values {
            query = query.bind(x.clone());
        }
    }
    tokio::time::timeout(timeout, query.fetch_all(&pool))
        .await
        .map_err(|_| format!("查询源库超时（{timeout:?}）"))?
        .map_err(|e| format!("查询源库失败: {e}"))
}

/// 行来源：优先用手写 SQL 包成子查询，否则按表名 quote 后当 `s`
///
/// 手写 SQL 已在保存与 `pull` 入口校验过是单条 select/with；它本来就是要执行的
/// 用户语句，不能再套标识符白名单。
fn row_source(spec: &SourceSpec) -> Result<String, String> {
    if let Some(sql) = spec.custom_sql() {
        return Ok(format!("({sql})"));
    }
    quote_table(spec.table_or_empty())
}

/// 表名 → `"schema"."table"`；两段都必须是合法标识符
fn quote_table(raw: &str) -> Result<String, String> {
    let parts: Vec<&str> = raw.split('.').collect();
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|p| !is_ident(p)) {
        return Err(format!("表名不合法：{raw:?}"));
    }
    Ok(parts
        .iter()
        .map(|p| format!("\"{p}\""))
        .collect::<Vec<_>>()
        .join("."))
}

/// 字段名 → `s."field"`；必须是合法标识符
fn quote_col(alias: &str, raw: &str) -> Result<String, String> {
    if !is_ident(raw) {
        return Err(format!("字段名不合法：{raw:?}"));
    }
    Ok(format!("{alias}.\"{raw}\""))
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// # 全量快照的进度状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotCursor {
    /// 还没拉完（含没开始）
    Start,
    /// 拉完了
    Done { rows: u64 },
}

/// 解析 `syn_cursor.cursor_value` 里的快照状态；认不出来的值一律当「没开始」
fn parse_snapshot_cursor(raw: Option<&str>) -> SnapshotCursor {
    let Some(raw) = raw else {
        return SnapshotCursor::Start;
    };
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return SnapshotCursor::Start;
    };
    let Some(s) = v.get("snapshot") else {
        return SnapshotCursor::Start;
    };
    let rows = s.get("rows").and_then(Value::as_u64).unwrap_or(0);
    if s.get("done").and_then(Value::as_bool).unwrap_or(false) {
        return SnapshotCursor::Done { rows };
    }
    SnapshotCursor::Start
}

fn snapshot_done_cursor(rows: u64, at_ms: i64) -> String {
    json!({ "snapshot": { "done": true, "rows": rows, "at": at_ms } }).to_string()
}

/// 这个游标值是不是「全量快照已完成」——调度器据此跳过
pub(crate) fn is_snapshot_done(raw: Option<&str>) -> bool {
    matches!(parse_snapshot_cursor(raw), SnapshotCursor::Done { .. })
}

/// # http 全量的进度状态
#[derive(Debug, Clone, PartialEq, Eq)]
enum HttpCursor {
    /// 还没开始：页码模式从第 1 页来，token 模式从空游标来
    Start,
    /// 下一页的游标，以及已经投递过的行数
    Next { cursor: String, rows: u64 },
    /// 翻到底了
    Done { rows: u64 },
}

/// 解析 `syn_cursor.cursor_value` 里的 http 状态。
///
/// 认不出来的值（历史脏数据、别的形态）一律当「没开始」：重跑一遍全量是安全的
/// （下游 upsert），比卡在那里不动强。
fn parse_http_cursor(raw: Option<&str>) -> HttpCursor {
    let Some(raw) = raw else {
        return HttpCursor::Start;
    };
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return HttpCursor::Start;
    };
    let Some(h) = v.get("http") else {
        return HttpCursor::Start;
    };
    let rows = h.get("rows").and_then(Value::as_u64).unwrap_or(0);
    if h.get("done").and_then(Value::as_bool).unwrap_or(false) {
        return HttpCursor::Done { rows };
    }
    match h.get("next").and_then(Value::as_str) {
        Some(n) if !n.is_empty() => HttpCursor::Next {
            cursor: n.to_string(),
            rows,
        },
        _ => HttpCursor::Start,
    }
}

fn http_next_cursor(next: &str, rows: u64) -> String {
    json!({ "http": { "next": next, "rows": rows } }).to_string()
}

fn http_done_cursor(rows: u64, at_ms: i64) -> String {
    json!({ "http": { "done": true, "rows": rows, "at": at_ms } }).to_string()
}

/// 这个游标值是不是「全量已完成」——调度器据此跳过 http 源
pub(crate) fn is_http_done(raw: Option<&str>) -> bool {
    matches!(parse_http_cursor(raw), HttpCursor::Done { .. })
}

/// # 填分页地址
///
/// 占位符 `{cursor}` / `{size}`（也容忍双花括号）。**没有 `{cursor}` 模板就只拉一页**：
/// 固定地址意味着接口本身就是「全量一个响应」，再翻页只会拿到同一批数据。
fn fill_url(template: &str, cursor: &str, size: i32) -> String {
    let size = size.to_string();
    template
        .replace("{{cursor}}", cursor)
        .replace("{{size}}", &size)
        .replace("{cursor}", cursor)
        .replace("{size}", &size)
}

fn url_is_paged(template: &str) -> bool {
    template.contains("{cursor}") || template.contains("{{cursor}}")
}

/// # 分页拉一页（http 全量）
struct HttpPage {
    rows: Vec<FetchedRow>,
    /// 下一页的游标；`None` 表示这是最后一页
    next: Option<String>,
}

async fn fetch_http_page(
    source: &SourceModel,
    spec: &SourceSpec,
    cursor: &str,
) -> Result<HttpPage, String> {
    let template = spec
        .url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("spec.url 缺失")?;
    // 单页条数：spec 没写就用源自己的「单批行数」（console 上那个 batch_size），
    // 两者都没有时 batch_size 的列默认值兜底
    let size = spec
        .page_size
        .filter(|n| *n > 0)
        .unwrap_or_else(|| source.batch_size.max(1));
    let url = fill_url(template, cursor, size);
    let paged = url_is_paged(template);

    let method_name = spec.method_or_get().to_ascii_uppercase();
    let method = reqwest::Method::from_bytes(method_name.as_bytes())
        .map_err(|e| format!("spec.method 不合法: {e}"))?;
    let timeout = get_app_config()
        .map(|c| c.syn.pull_timeout())
        .unwrap_or(Duration::from_secs(30));

    let mut req = crate::transport::client()
        .request(method, &url)
        .timeout(timeout);
    if let Some(headers) = &spec.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    // POST 给一个空对象：不少接口不接受完全空的 body
    if spec.method_or_get().eq_ignore_ascii_case("post") {
        req = req.json(&json!({}));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求源接口失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "源接口返回 {status}: {}",
            truncate(&text, 200)
        ));
    }
    let body: Value =
        serde_json::from_str(&text).map_err(|e| format!("源接口返回的不是 JSON: {e}"))?;

    let data_path = spec.data_path_or_root();
    let data = get_path(&body, data_path)
        .ok_or_else(|| format!("响应里没有 {data_path} 指向的数据"))?;
    let arr = data
        .as_array()
        .ok_or_else(|| format!("{data_path} 不是数组：http 全量按数组逐行投递"))?;

    let wrap = spec.wrap;
    let mut rows = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        if !item.is_object() && wrap == WrapMode::Cdc {
            return Err(format!("第 {i} 行不是 JSON 对象，wrap=cdc 需要 op/after 形态"));
        }
        let record = match wrap {
            WrapMode::Row => json!({ "op": "r", "after": item }),
            WrapMode::Cdc => item.clone(),
        };
        rows.push(FetchedRow {
            record,
            // 全量的进度是整页游标，不按行推进
            position: None,
        });
    }

    // 下一页：token 模式看 next_path；页码模式「空页即结束」。
    // 固定地址（没有 {cursor} 占位）时永远是最后一页。
    let next = if !paged {
        None
    } else if spec.token_paging() {
        let path = spec.next_path.as_deref().unwrap_or("");
        get_path(&body, path).and_then(value_as_cursor)
    } else if arr.is_empty() {
        None
    } else {
        let page: u32 = cursor
            .parse()
            .map_err(|_| format!("页码游标必须是正整数，实际是 {cursor:?}"))?;
        if page >= MAX_PAGES {
            // 接口若忽略页码，这里会一直「有数据」，靠上限兜住而不是跑飞
            return Err(format!(
                "页码超过 {MAX_PAGES} 页仍未结束，检查 url 的 {{cursor}} 是否生效"
            ));
        }
        Some((page + 1).to_string())
    };

    Ok(HttpPage { rows, next })
}

/// 下一页游标的取值：字符串直接用，数字转字符串，其余当没有
fn value_as_cursor(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

/// # 读数据抽取
async fn load_source<C: sea_orm::ConnectionTrait>(
    id: i64,
    db: &C,
) -> Result<SourceModel, SvcError> {
    let rows = crate::dao::SynSourceDao::list_by_condition::<_, SourceModel>(
        Condition::all().add(crate::mo::syn_source::Column::Id.eq(id)),
        &None,
        db,
    )
    .await?;
    rows.into_iter()
        .next()
        .ok_or_else(|| SvcError::NotFound(format!("数据抽取 {id} 不存在")))
}

/// # 读（必要时建）水位行
async fn load_cursor<C: sea_orm::ConnectionTrait>(
    source_id: i64,
    db: &C,
) -> Result<CursorModel, SvcError> {
    if let Some(m) = SynCursorDao::get_by_condition::<_, CursorModel>(
        Condition::all().add(CursorColumn::SourceId.eq(source_id)),
        db,
    )
    .await?
    {
        return Ok(m);
    }
    let now = now_ms() as i64;
    let mut am = CursorActive::default();
    am.source_id = sea_orm::ActiveValue::Set(source_id);
    am.cursor_value = sea_orm::ActiveValue::Set(None);
    am.rows_synced = sea_orm::ActiveValue::Set(0);
    am.last_run_ms = sea_orm::ActiveValue::Set(None);
    am.last_error = sea_orm::ActiveValue::Set(None);
    am.creater_id = sea_orm::ActiveValue::Set(0);
    am.updater_id = sea_orm::ActiveValue::Set(0);
    am.create_ms = sea_orm::ActiveValue::Set(now);
    am.update_ms = sea_orm::ActiveValue::Set(now);
    Ok(SynCursorDao::insert(am, db).await?)
}

/// # 把全量进度清回起点（`pull?reset=true` 用）
///
/// 只清 `cursor_value` 与累计行数，保留 `last_run_ms`：调度节奏不该因为一次重跑被改。
/// sql 源也能调，效果是「水位清零重新拉全库」—— 同一条语义，不做特判。
pub async fn reset_full(id: U64) -> Result<(), SvcError> {
    let db = get_db_conn()?;
    let cursor = load_cursor(id.value() as i64, db.as_ref()).await?;
    let now = now_ms() as i64;
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update syn_cursor set cursor_value = null, rows_synced = 0, last_error = null, \
         update_ms = $1, updater_id = 0 where id = $2",
        vec![now.into(), cursor.id.into()],
    );
    db.execute_raw(statement)
        .await
        .map_err(|e| SvcError::Runtime(anyhow::anyhow!(e.to_string())))?;
    info!("数据抽取 {id} 的全量进度已清零，下一轮从第一页重新开始");
    Ok(())
}

/// # 推进水位（乐观并发控制）
///
/// `where id = ? and update_ms = 本轮读到的值`：两个副本同时拉时，后写的那个影响 0 行，
/// 本轮水位作废（下游已经写过的行由幂等/upsert 吸收），不会出现「旧水位覆盖新水位」。
/// 返回 `false` 表示被并发拦下。
async fn advance_cursor(
    cursor: CursorModel,
    position: Option<&str>,
    rows: i64,
    run_ms: i64,
    error: Option<&str>,
) -> Result<bool, SvcError> {
    let db = get_db_conn()?;
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update syn_cursor set cursor_value = $1, rows_synced = rows_synced + $2, \
         last_run_ms = $3, last_error = $4, update_ms = $5, updater_id = 0 \
         where id = $6 and update_ms = $7",
        vec![
            position.into(),
            rows.into(),
            run_ms.into(),
            error.into(),
            run_ms.into(),
            cursor.id.into(),
            cursor.update_ms.into(),
        ],
    );
    let res = db.execute_raw(statement).await.map_err(|e| SvcError::Runtime(anyhow::anyhow!(e.to_string())))?;
    Ok(res.rows_affected() > 0)
}

/// # 记一轮错误（或「没有新行」）
///
/// 成功一轮清空 `last_error`，失败一轮留下第一条卡住的原因；总览按它判断数据抽取是否卡住。
async fn save_error(
    cursor: CursorModel,
    run_ms: i64,
    error: Option<&str>,
) -> Result<(), SvcError> {
    let db = get_db_conn()?;
    let statement = Statement::from_sql_and_values(
        DbBackend::Postgres,
        "update syn_cursor set last_run_ms = $1, last_error = $2, update_ms = $3, \
         updater_id = 0 where id = $4",
        vec![run_ms.into(), error.into(), run_ms.into(), cursor.id.into()],
    );
    db.execute_raw(statement).await.map_err(|e| SvcError::Runtime(anyhow::anyhow!(e.to_string())))?;
    Ok(())
}

/// # 扫一遍「该跑的数据抽取」并各拉一轮
///
/// 只做一件事：读启用的源 + 各源水位，`now - last_run_ms >= interval` 的就拉。
/// 调用方决定节奏 —— 进程内调度器 1s 一次，jobx 计划任务按 `[syn.pull-job]` 的间隔。
///
/// 返回 `(扫到的源数, 真正拉取的源数)`，给执行器的日志/任务结果用。
///
/// **不持有跨源的锁**：单个源失败只 `warn` 并继续下一个，否则一个坏源会让所有源停摆。
pub async fn poll_due_sources() -> (usize, usize) {
    let sources = match crate::svc::enabled_sources().await {
        Ok(v) => v,
        Err(e) => {
            warn!("调度器读数据抽取失败: {e}");
            return (0, 0);
        }
    };
    let scanned = sources.len();
    let mut pulled = 0;
    let now = now_ms() as i64;
    for s in sources {
        let period = humantime::parse_duration(&s.interval_duration)
            .unwrap_or(Duration::from_secs(60))
            .as_millis() as i64;
        let db = match get_db_conn() {
            Ok(d) => d,
            Err(_) => break,
        };
        let cursor = match SynCursorDao::get_by_condition::<_, CursorModel>(
            Condition::all().add(CursorColumn::SourceId.eq(s.id)),
            db.as_ref(),
        )
        .await
        {
            Ok(v) => v,
            Err(_) => continue,
        };
        let raw = cursor.as_ref().and_then(|c| c.cursor_value.as_deref());

        // 全量源（http / sql 快照）拉完就永久跳过；跑的过程中不按 interval 排队，
        // 否则一次十万行的全量要跑几天。
        let kind = SourceKind::from_i16(s.kind).unwrap_or_default();
        let snapshot = kind == SourceKind::Sql
            && SourceSpec::parse(&s.spec)
                .map(|spec| spec.mode == ExtractMode::Snapshot)
                .unwrap_or(false);
        let full = kind == SourceKind::Http || snapshot;
        if full {
            let done = if snapshot {
                is_snapshot_done(raw)
            } else {
                is_http_done(raw)
            };
            if done {
                continue;
            }
        } else {
            let last = cursor.as_ref().and_then(|c| c.last_run_ms).unwrap_or(0);
            if now - last < period {
                continue;
            }
        }
        let id = U64::from(s.id);
        match pull_once(id).await {
            Ok(_) => pulled += 1,
            Err(e) => warn!("调度器拉取数据抽取 {} 失败: {e}", s.code),
        }
    }
    (scanned, pulled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_cursor_roundtrip() {
        let next = http_next_cursor("3", 600);
        assert_eq!(
            parse_http_cursor(Some(&next)),
            HttpCursor::Next {
                cursor: "3".into(),
                rows: 600
            }
        );

        let done = http_done_cursor(1200, 1_764_000_000_000);
        assert_eq!(parse_http_cursor(Some(&done)), HttpCursor::Done { rows: 1200 });
        assert!(is_http_done(Some(&done)));
        assert!(!is_http_done(Some(&next)));
    }

    #[test]
    fn snapshot_cursor_roundtrip() {
        let done = snapshot_done_cursor(1200, 1_764_000_000_000);
        assert_eq!(parse_snapshot_cursor(Some(&done)), SnapshotCursor::Done { rows: 1200 });
        assert!(is_snapshot_done(Some(&done)));

        // 其它形态的进度（http / 游标增量 / 脏值）都当「没开始」：重跑一遍是安全的
        assert_eq!(parse_snapshot_cursor(None), SnapshotCursor::Start);
        assert_eq!(parse_snapshot_cursor(Some("")), SnapshotCursor::Start);
        assert_eq!(
            parse_snapshot_cursor(Some(r#"{"http":{"done":true,"rows":3}}"#)),
            SnapshotCursor::Start
        );
        assert_eq!(
            parse_snapshot_cursor(Some(r#"["2026-11-13 00:40:22+00","4"]"#)),
            SnapshotCursor::Start
        );
        assert!(!is_snapshot_done(Some(r#"{"snapshot":{"offset":100,"rows":100}}"#)));
    }

    #[test]
    fn table_and_column_are_quoted_from_whitelisted_idents() {
        assert_eq!(quote_table("dtw_polygon").unwrap(), "\"dtw_polygon\"");
        assert_eq!(quote_table("public.dtw_polygon").unwrap(), "\"public\".\"dtw_polygon\"");
        // 注入尝试直接拒绝，不拼进 SQL
        assert!(quote_table("dtw_polygon; drop table x").is_err());
        assert!(quote_table("public.a.b").is_err());
        assert_eq!(quote_col("s", "update_timestamp").unwrap(), "s.\"update_timestamp\"");
        assert!(quote_col("s", "id; --").is_err());
    }

    #[test]
    fn row_source_prefers_custom_sql_over_table() {
        let custom = SourceSpec {
            sql: Some("  select id, updated_at from t where deleted = false;  ".to_string()),
            table: Some("ignored".to_string()),
            ..Default::default()
        };
        assert_eq!(
            row_source(&custom).unwrap(),
            "(select id, updated_at from t where deleted = false)"
        );

        let by_table = SourceSpec {
            table: Some("public.t".to_string()),
            ..Default::default()
        };
        assert_eq!(row_source(&by_table).unwrap(), "\"public\".\"t\"");
    }

    #[test]
    fn http_cursor_treats_unknown_as_start() {
        // sql 源的水位（JSON 数组）、另一种全量的进度、脏值、空串都当成「没开始」：
        // 重跑一遍是安全的
        assert_eq!(parse_http_cursor(None), HttpCursor::Start);
        assert_eq!(parse_http_cursor(Some("")), HttpCursor::Start);
        assert_eq!(
            parse_http_cursor(Some(r#"["2026-11-13 00:40:22+00","4"]"#)),
            HttpCursor::Start
        );
        assert_eq!(parse_http_cursor(Some("{oops")), HttpCursor::Start);
        assert_eq!(parse_http_cursor(Some(r#"{"http":{"next":""}}"#)), HttpCursor::Start);
    }

    #[test]
    fn fill_url_supports_single_and_double_braces() {
        assert_eq!(
            fill_url("https://x/api?page={cursor}&size={size}", "2", 100),
            "https://x/api?page=2&size=100"
        );
        assert_eq!(
            fill_url("https://x/api?page={{cursor}}", "7", 100),
            "https://x/api?page=7"
        );
        // 没有占位符：原样返回，调用方据此判定「只有一页」
        assert_eq!(fill_url("https://x/api/all", "1", 100), "https://x/api/all");
    }

    #[test]
    fn url_is_paged_detects_placeholder() {
        assert!(url_is_paged("https://x?page={cursor}"));
        assert!(url_is_paged("https://x?page={{cursor}}"));
        assert!(!url_is_paged("https://x/all"));
    }

    #[test]
    fn next_cursor_accepts_string_and_number() {
        assert_eq!(value_as_cursor(&json!("abc")), Some("abc".to_string()));
        assert_eq!(value_as_cursor(&json!(2)), Some("2".to_string()));
        assert_eq!(value_as_cursor(&json!("")), None);
        assert_eq!(value_as_cursor(&Value::Null), None);
    }

    /// 投递中途被 fatal 卡住时，水位必须停在最后一条已投递行，而不是整批最后一行 ——
    /// 后者会让未投递的行永远不再被拉取（静默丢数据）。
    #[test]
    fn cursor_stops_at_last_delivered_row() {
        let rows = vec![
            FetchedRow {
                record: json!({}),
                position: Some(r#"["2026-11-13 00:00:01+00","1"]"#.to_string()),
            },
            FetchedRow {
                record: json!({}),
                position: Some(r#"["2026-11-13 00:00:02+00","2"]"#.to_string()),
            },
            FetchedRow {
                record: json!({}),
                position: Some(r#"["2026-11-13 00:00:03+00","3"]"#.to_string()),
            },
        ];
        // 前两行投递成功、第三行被卡住：水位停在第二行
        assert_eq!(
            last_delivered_position(&rows, 2).as_deref(),
            Some(r#"["2026-11-13 00:00:02+00","2"]"#)
        );
        // 一行都没成功：不推进
        assert_eq!(last_delivered_position(&rows, 0), None);
        // 整批都投递了：停在最后一行
        assert_eq!(
            last_delivered_position(&rows, 3).as_deref(),
            Some(r#"["2026-11-13 00:00:03+00","3"]"#)
        );
        // 防御：投递数超出批大小时不 panic
        assert_eq!(last_delivered_position(&rows, 99), None);
    }
}
