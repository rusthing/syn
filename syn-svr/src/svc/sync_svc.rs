//! # 记录转发
//!
//! 一个 topic 下可能有多个任务。按 `priority` 升序找匹配的任务：
//! 默认命中第一个就停；前面的任务标了 `exclusive: false` 就继续往下找，
//! 一条记录可以同时同步到多个下游。
//!
//! 没选到任务不是错误：返回 `skip`，sink 正常提交 offset。topic 里出现不该同步的
//! 记录（上游多发了、别的任务负责）是常态，不能让它变成死信。
//!
//! ## 幂等
//!
//! 请求带 `X-Idempotency-Key` 时，按 `(task_id, key)` 查 `syn_idem`：**只记终态**
//! （success / skip）。失败结论不记账，因为重投本来就该再试一次；把 retriable
//! 记下来再原样返回，等于让这条记录永远不会被重试。
//!
//! ## 两种投递
//!
//! `target.kind` 决定最后一步：http 走服务名解析 + `HttpTransport`，db 走 `DbSinks`
//! 的 `insert ... on conflict`。前四段与判定段完全共用，见 `syn-core::engine`。

use sea_orm::{ColumnTrait, Condition};
use serde_json::Value;
use syn_api::{SyncVerdict, TaskSpec, Verdict};
use syn_core::{Execution, Stage};
use wheel_rs::time_utils::now_ms;

use crate::config::get_app_config;
use crate::dao::{SynIdemDao, SynTaskDao};
use crate::db_sink::DbSinks;
use crate::mo::syn_idem::{ActiveModel as IdemActive, Column as IdemColumn};
use crate::mo::syn_idem::Model as IdemModel;
use crate::mo::syn_task::{Column as TaskColumn, Model as TaskModel};
use crate::store;
use crate::transport::HttpTransport;

/// # 一次转发的结论
#[derive(Debug, Clone)]
pub struct SyncOutcome {
    /// 结论（多任务时取最严重的一个）
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 命中的任务（多任务用逗号连接）
    pub task: Option<String>,
    /// 得出结论的段
    pub stage: &'static str,
    /// 补充说明
    pub detail: Option<String>,
    /// 每个任务的独立结论，失败排查时看这个
    pub results: Vec<TaskResult>,
}

/// # 单个任务的结果
#[derive(Debug, Clone)]
pub struct TaskResult {
    /// 任务标识
    pub task: String,
    /// 结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
}

impl SyncOutcome {
    /// 返回给 sink 的 HTTP 状态码
    pub fn http_status(&self) -> u16 {
        self.verdict.http_status()
    }

    fn skip(code: &str, detail: impl Into<String>) -> Self {
        Self {
            verdict: Verdict::Skip,
            code: code.to_string(),
            task: None,
            stage: Stage::Match.as_str(),
            detail: Some(detail.into()),
            results: Vec::new(),
        }
    }

    fn fatal(code: &str, stage: Stage, detail: impl Into<String>) -> Self {
        Self {
            verdict: Verdict::Fatal,
            code: code.to_string(),
            task: None,
            stage: stage.as_str(),
            detail: Some(detail.into()),
            results: Vec::new(),
        }
    }
}

/// # 处理一条记录
///
/// `idem_key` 由 sink 给（`topic:partition:offset`）。自拉链路不传：它的重复由
/// 「水位不推进 + 下游 upsert」吸收，不需要再记一份台账。
pub async fn handle(topic: &str, record: &Value, idem_key: Option<&str>) -> SyncOutcome {
    let snapshot = store::snapshot();
    let mut ordered: Vec<&TaskSpec> = snapshot.iter().filter(|t| t.topic == topic).collect();

    if ordered.is_empty() {
        return SyncOutcome::skip("no_task_for_topic", format!("topic {topic} 下没有任务"));
    }
    // 快照加载时已排序，这里再排一次是为了不依赖加载顺序
    ordered.sort_by_key(|t| t.priority);

    let mut chosen: Vec<&TaskSpec> = Vec::new();
    for task in ordered {
        if syn_core::matches(task, record) {
            chosen.push(task);
            if task.exclusive {
                break;
            }
        }
    }
    if chosen.is_empty() {
        return SyncOutcome::skip("no_match", "没有任务的条件命中");
    }

    let mut executions: Vec<Execution> = Vec::with_capacity(chosen.len());
    for task in chosen {
        // 命中台账就直接复用上次的结论，不再打下游
        if let Some(key) = idem_key
            && let Some(cached) = cached_execution(task, key).await
        {
            executions.push(cached);
            continue;
        }

        let execution = if task.target.is_db() {
            syn_core::execute_db(task, record, &DbSinks).await
        } else {
            let config = match get_app_config() {
                Ok(c) => c,
                Err(e) => {
                    return SyncOutcome::fatal("CONFIG_NOT_READY", Stage::Action, e.to_string());
                }
            };
            let Some(base_url) = config.syn.targets.get(&task.target.service) else {
                // 部署配置问题，不是数据问题：必须显式失败，不能猜一个地址发出去
                return SyncOutcome::fatal(
                    "TARGET_UNRESOLVED",
                    Stage::Action,
                    format!("[syn.targets] 缺少服务 {}", task.target.service),
                );
            };
            syn_core::execute(task, record, base_url, &HttpTransport).await
        };
        if let Some(key) = idem_key {
            remember(task, key, &execution).await;
        }
        executions.push(execution);
    }

    aggregate(executions)
}

/// # 查幂等台账
///
/// 台账按 `task_id` 存，配置里用的是 `code`，所以要先反查一次任务 ID。
/// 查不到任务（配置刚删）时返回 `None`，让本轮照常执行而不是静默吞掉。
async fn cached_execution(task: &TaskSpec, key: &str) -> Option<Execution> {
    let db = robotech::db::get_db_conn().ok()?;
    let task_id = task_id(&task.id, db.as_ref()).await?;
    let row = SynIdemDao::get_by_condition::<_, IdemModel>(
        Condition::all()
            .add(IdemColumn::TaskId.eq(task_id))
            .add(IdemColumn::IdemKey.eq(key)),
        db.as_ref(),
    )
    .await
    .ok()??;
    let verdict = Verdict::from(SyncVerdict::from_i16(row.verdict).unwrap_or_default());
    Some(Execution::stop(
        task,
        verdict,
        row.code,
        Stage::Verdict,
        format!("幂等命中 {key}，复用上次结论"),
    ))
}

/// # 记终态
///
/// 只记 success / skip。唯一键冲突说明另一个副本已经记过，不是错误（两边结论相同）。
async fn remember(task: &TaskSpec, key: &str, execution: &Execution) {
    if !matches!(execution.verdict, Verdict::Success | Verdict::Skip) {
        return;
    }
    let Ok(db) = robotech::db::get_db_conn() else {
        return;
    };
    let Some(task_id) = task_id(&task.id, db.as_ref()).await else {
        return;
    };
    let now = now_ms() as i64;
    let mut am = IdemActive::default();
    am.task_id = sea_orm::ActiveValue::Set(task_id);
    am.idem_key = sea_orm::ActiveValue::Set(key.to_string());
    am.verdict = sea_orm::ActiveValue::Set(i16::from(SyncVerdict::from(execution.verdict)));
    am.code = sea_orm::ActiveValue::Set(execution.code.clone());
    am.creater_id = sea_orm::ActiveValue::Set(0);
    am.updater_id = sea_orm::ActiveValue::Set(0);
    am.create_ms = sea_orm::ActiveValue::Set(now);
    am.update_ms = sea_orm::ActiveValue::Set(now);
    if let Err(e) = SynIdemDao::insert(am, db.as_ref()).await {
        tracing::debug!("幂等台账写入跳过（多半是并发重复）: {e}");
    }
}

async fn task_id<C: sea_orm::ConnectionTrait>(code: &str, db: &C) -> Option<i64> {
    SynTaskDao::get_by_condition::<_, TaskModel>(
        Condition::all().add(TaskColumn::Code.eq(code)),
        db,
    )
    .await
    .ok()??
    .id
    .into()
}

/// # 汇总多个任务
///
/// 取**最严重**的结论：只要有一个 fatal，整条记录就是 fatal。
/// 这是 fanout 唯一正确的语义 —— 报成功会让失败的那个下游永远补不上；
/// 重复执行由 sink 的幂等键兜住（带 `X-Idempotency-Key` 时下游自己去重）。
fn aggregate(executions: Vec<Execution>) -> SyncOutcome {
    let worst = executions
        .iter()
        .max_by_key(|e| severity(e.verdict))
        .expect("调用方保证至少一个");

    SyncOutcome {
        verdict: worst.verdict,
        code: worst.code.clone(),
        task: Some(
            executions
                .iter()
                .map(|e| e.task.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ),
        stage: worst.stage.as_str(),
        detail: worst.detail.clone(),
        results: executions
            .into_iter()
            .map(|e| TaskResult {
                task: e.task,
                verdict: e.verdict,
                code: e.code,
            })
            .collect(),
    }
}

fn severity(v: Verdict) -> u8 {
    match v {
        Verdict::Success => 0,
        Verdict::Skip => 1,
        Verdict::Retriable => 2,
        Verdict::Fatal => 3,
    }
}
