//! # 自拉入口（poll-sql / poll-http）
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
//! ## 两种取数的节奏不一样
//!
//! - **sql**：按 `(updated_at, id)` 复合游标取一批，一轮一批，天然增量。
//! - **http**：全量分页，**一轮推一页**。翻到底写 `{"http":{"done":true}}`，此后调度
//!   跳过；要重跑得显式 reset（`POST /syn/source/{id}/pull?reset=true`）。一轮一页是
//!   为了断点可续：页与页之间进程挂了，下一轮从上次的下一页继续，不用从头再来。
//!
//! ## 四条边界（不是待办，是轮询的固有性质）
//!
//! 1. **复合游标 + 5 秒重叠**：`(updated_at, id)` 两列比较，且只取 `updated_at <= now()-5s`
//!    的行，避免读到还没提交的事务。重复行由下游 upsert 吸收。
//! 2. **删除捕获不到**：查不到已删的行。要软删标记或全量对账，不能假装支持。
//!    http 全量同样只是 upsert，**不按「缺失」删**（见 §11.14）。
//! 3. **单写者**：jobx 单点触发；进程内另有一把锁挡住「按钮连点」。两个副本同时拉会
//!    重复投递并互相覆盖水位，所以游标更新带 `update_ms` 乐观条件，输了的一轮作废。
//! 4. **游标存 syn 库**：不污染业务库；游标推进与下游投递**不同事务**，中间挂了会重投
//!    少量行，靠下游幂等/upsert 吸收。
//!
//! http 全量的使用前提：**只用于首次同步**，增量交给 dbz。两边同时写同一张表会让旧
//! 快照覆盖新值、删除语义打架 —— 四条前提见 `doc/syn-开发规范.md` §11.14。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use syn_api::{CursorType, SourceKind, SourceSpec, SynSourcePullVo, Verdict, WrapMode};
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

/// 同一进程内正在拉的数据源。挡住按钮连点；跨副本靠 jobx 单点 + 乐观更新
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
                "数据源 {source_id} 正在拉取，请勿重复触发"
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
        .map_err(|e| SvcError::Runtime(anyhow::anyhow!("数据源 {} 的 spec 不合法: {e}", source.code)))?;
    spec.validate(kind).map_err(|issues| {
        SvcError::Runtime(anyhow::anyhow!(
            "数据源 {} 的 spec 不合法: {}",
            source.code,
            issues.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("；")
        ))
    })?;

    let cursor = load_cursor(source.id, db.as_ref()).await?;

    match kind {
        SourceKind::Sql => pull_sql(&source, &spec, cursor, run_ms, started).await,
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
            warn!("数据源 {} 拉取失败: {e}", source.code);
            save_error(cursor, run_ms, Some(e.as_str())).await?;
            out.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(with_stalled(out, e));
        }
    };

    let (rows, position) = fetched;
    deliver(&source.topic, &rows, &mut out).await;

    // 只有连续成功的行能推进水位：最后一行失败时停在上一个成功行的位置，
    // 下一轮重跑失败行及其后所有行（重复由下游 upsert 吸收）
    let advanced = out.rows;
    let new_position = (advanced > 0).then_some(position).flatten();
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
                "数据源 {} 的游标被并发更新，本轮不回写（下游重复由幂等吸收）",
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
        "数据源 {} 拉取完成：{} 行，成功 {} / 跳过 {} / 失败 {} / 重试 {}，水位 {:?}",
        source.code, out.rows, out.success, out.skip, out.fatal, out.retriable, out.position
    );
    Ok(out)
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
        info!("数据源 {} 的全量已完成（{} 行），本轮跳过", source.code, rows);
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
            warn!("数据源 {} 拉取失败: {e}", source.code);
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
            "数据源 {} 的游标被并发更新，本轮不回写（下游重复由幂等吸收）",
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
            "数据源 {} 全量同步完成：累计 {} 行（本轮 {} 行）",
            source.code, total, out.rows
        );
    } else {
        info!(
            "数据源 {} 全量同步推进：本轮 {} 行，累计 {} 行，下一页游标 {:?}",
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
}

/// # 按水位查源库
///
/// SQL 里只有三处来自配置：`select`（校验过是单条 select/with）、游标列名（白名单）、
/// 类型名（枚举）。行值一律绑参数，**没有字符串拼接用户输入**。
async fn fetch_sql(
    source: &SourceModel,
    spec: &SourceSpec,
    position: Option<&str>,
) -> Result<(Vec<FetchedRow>, Option<String>), String> {
    let Some(datasource) = spec.datasource.as_deref() else {
        return Err("spec.datasource 缺失".to_string());
    };
    let select = spec
        .select
        .as_deref()
        .map(str::trim)
        .map(|s| s.trim_end_matches(';'))
        .unwrap_or_default();
    let cols = spec.cursor_columns();
    if select.is_empty() || cols.is_empty() {
        return Err("spec.select / spec.cursor_column 缺失".to_string());
    }
    let q = |c: &str| format!("s.\"{c}\"");
    let col_list = cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ");

    // 水位：JSON 数组文本，列数与游标列一一对应
    let values: Option<Vec<String>> = position
        .map(|p| serde_json::from_str(p).unwrap_or_else(|_| vec![p.to_string()]))
        .filter(|v| v.len() == cols.len());

    let mut sql = String::from("select to_jsonb(s) as row");
    for (i, c) in cols.iter().enumerate() {
        sql.push_str(&format!(", {}::text as k{i}", q(c)));
    }
    sql.push_str(&format!(" from ({select}) s"));

    let mut conds: Vec<String> = Vec::new();
    if values.is_some() {
        let cast0 = spec.cursor_type.cast();
        let lhs = if cols.len() == 2 {
            format!("({}, {})", q(cols[0]), q(cols[1]))
        } else {
            q(cols[0])
        };
        let rhs = if cols.len() == 2 {
            // 两列按约定是 (时间戳, 自增 ID)，第二列固定 int8
            format!("($1::{cast0}, $2::int8)")
        } else {
            format!("($1::{cast0})")
        };
        conds.push(format!("{lhs} > {rhs}"));
    }
    // 重叠窗口只对时间戳游标成立：整数/文本水位没有「事务提交时间」这一维度
    if spec.cursor_type == CursorType::Timestamp {
        conds.push(format!(
            "{} <= now() - interval '{OVERLAP_SECONDS} seconds'",
            q(cols[0])
        ));
    }
    if !conds.is_empty() {
        sql.push_str(&format!(" where {}", conds.join(" and ")));
    }
    sql.push_str(&format!(
        " order by {col_list} limit {}",
        source.batch_size.max(1)
    ));

    let pool = DbSinks::pool_for(datasource)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.detail))?;
    let timeout = get_app_config()
        .map(|c| c.syn.pull_timeout())
        .unwrap_or(Duration::from_secs(30));

    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
    if let Some(v) = &values {
        for x in v {
            query = query.bind(x.clone());
        }
    }
    let rows = tokio::time::timeout(timeout, query.fetch_all(&pool))
        .await
        .map_err(|_| format!("查询源库超时（{timeout:?}）"))?
        .map_err(|e| format!("查询源库失败: {e}"))?;

    let wrap = spec.wrap;
    let mut out = Vec::with_capacity(rows.len());
    let mut last_position: Option<String> = None;
    for r in &rows {
        let row: Value = r
            .try_get("row")
            .map_err(|e| format!("读取源行失败: {e}"))?;
        let mut keys = Vec::with_capacity(cols.len());
        for i in 0..cols.len() {
            let k: Option<String> = r
                .try_get(format!("k{i}").as_str())
                .map_err(|e| format!("读取游标列 {i} 失败: {e}"))?;
            keys.push(k.unwrap_or_default());
        }
        let record = match wrap {
            WrapMode::Row => json!({ "op": "r", "after": row }),
            WrapMode::Cdc => {
                if !row.is_object() {
                    return Err("wrap=cdc 要求查询每行返回一个 JSON 对象".to_string());
                }
                row
            }
        };
        last_position = Some(
            serde_json::to_string(&keys).map_err(|e| format!("水位序列化失败: {e}"))?,
        );
        out.push(FetchedRow { record });
    }
    Ok((out, last_position))
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
        rows.push(FetchedRow { record });
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

/// # 读数据源
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
        .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))
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
    info!("数据源 {id} 的全量进度已清零，下一轮从第一页重新开始");
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
/// 成功一轮清空 `last_error`，失败一轮留下第一条卡住的原因；总览按它判断数据源是否卡住。
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

/// # 进程内调度（默认关闭，仅单副本开发用）
///
/// 生产让 jobx 打 `POST /syn/source/{id}/pull`。开了这个开关又部署多副本，就会有两个
/// 进程同时拉 —— 水位有乐观条件兜着，但下游会被重复打，所以启动时明确 warn。
///
/// 与 [`poll_due_sources`] 是同一段逻辑：进程内调度只是「自己打拍子」的那一层，
/// jobx 计划任务（`crate::wkr`）打拍子时走的是同一个函数。
pub fn spawn_scheduler() {
    warn!("[syn] self-schedule 已开启：进程内调度只适用于单副本开发，生产请让 jobx 打 pull 端点");
    tokio::spawn(async move {
        // 1s 一拍只看「到没到点」，不查源库；真正的间隔由每个源的 interval_duration 决定
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            poll_due_sources().await;
        }
    });
    info!("[syn] 进程内 poll 调度已启动（1s 巡检）");
}

/// # 扫一遍「该跑的数据源」并各拉一轮
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
            warn!("调度器读数据源失败: {e}");
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

        // http 全量源不按 interval 排：翻页期间每拍都推一页，推完就永久跳过。
        // 按 interval 排队的话，一次 10 万行的全量要跑几天。
        if SourceKind::from_i16(s.kind).unwrap_or_default() == SourceKind::Http {
            if cursor
                .as_ref()
                .and_then(|c| c.cursor_value.as_deref())
                .is_some_and(|v| is_http_done(Some(v)))
            {
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
            Err(e) => warn!("调度器拉取数据源 {} 失败: {e}", s.code),
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
    fn http_cursor_treats_unknown_as_start() {
        // sql 源的水位（JSON 数组）、脏值、空串都当成「没开始」：重跑一遍是安全的
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
}
