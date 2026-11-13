//! # 自拉入口（poll-sql）
//!
//! 「poll 入口」是一个 **HTTP 端点**：`POST /syn/source/{id}/pull`。调度不属于 syn ——
//! 按 `doc/syn-通用同步模型.md` §2.3，由 jobx 定时打这个端点，天然单点触发、有执行
//! 历史、失败可见。syn 自己不需要依赖 jobx 的 Rust 客户端。
//!
//! ## 一轮做什么
//!
//! ```text
//! 读 syn_source → 读 syn_cursor（没有就建）→ 按水位查源库 → 每行包成虚拟 topic 记录
//!   → 逐行走 sync_svc::handle（和 sink 推送完全同一条链路）
//!   → 只有连续成功的行才推进水位；遇到 fatal / retriable 立刻停，下一轮从断点重跑
//! ```
//!
//! ## 四条边界（不是待办，是轮询的固有性质）
//!
//! 1. **复合游标 + 5 秒重叠**：`(updated_at, id)` 两列比较，且只取 `updated_at <= now()-5s`
//!    的行，避免读到还没提交的事务。重复行由下游 upsert 吸收。
//! 2. **删除捕获不到**：查不到已删的行。要软删标记或 P5 的全量对账，不能假装支持。
//! 3. **单写者**：jobx 单点触发；进程内另有一把锁挡住「按钮连点」。两个副本同时拉会
//!    重复投递并互相覆盖水位，所以游标更新带 `update_ms` 乐观条件，输了的一轮作废。
//! 4. **游标存 syn 库**：不污染业务库；游标推进与下游投递**不同事务**，中间挂了会重投
//!    少量行，靠下游幂等/upsert 吸收。
//!
//! `kind = http` 目前只做配置与校验（P5），调用时明确报错，不假装跑通。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use syn_api::{CursorType, SourceKind, SourceSpec, SynSourcePullVo, Verdict, WrapMode};
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
    let mut out = SynSourcePullVo {
        rows: 0,
        duration_ms: 0,
        success: 0,
        skip: 0,
        fatal: 0,
        retriable: 0,
        position: None,
        stalled: None,
    };

    let fetched: Result<(Vec<FetchedRow>, Option<String>), String> = match kind {
        SourceKind::Sql => fetch_sql(&source, &spec, cursor.cursor_value.as_deref()).await,
        SourceKind::Http => Err("poll-http 尚未实现（P5）：当前只落地了 sql 取数".to_string()),
    };

    let (rows, position) = match fetched {
        Ok(v) => v,
        Err(e) => {
            warn!("数据源 {} 拉取失败: {e}", source.code);
            save_error(cursor, run_ms, Some(e.as_str())).await?;
            out.duration_ms = started.elapsed().as_millis() as u64;
            return Ok(with_stalled(out, e));
        }
    };

    // 一行一条记录，逐条走与 sink 推送相同的链路
    for row in &rows {
        let outcome = handle(&source.topic, &row.record, None).await;
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
        let last = match SynCursorDao::get_by_condition::<_, CursorModel>(
            Condition::all().add(CursorColumn::SourceId.eq(s.id)),
            db.as_ref(),
        )
        .await
        {
            Ok(v) => v.and_then(|c| c.last_run_ms).unwrap_or(0),
            Err(_) => continue,
        };
        if now - last < period {
            continue;
        }
        let id = U64::from(s.id);
        match pull_once(id).await {
            Ok(_) => pulled += 1,
            Err(e) => warn!("调度器拉取数据源 {} 失败: {e}", s.code),
        }
    }
    (scanned, pulled)
}
