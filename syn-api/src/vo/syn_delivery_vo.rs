//! # 投递记录 VO
//!
//! **这张 VO 不是一张表的镜像**：库里只有 `syn_idem`（幂等台账），没有逐次投递明细。
//! 控制台的「投递记录」因此是台账的投影，口径必须写死在这里，免得有人把
//! `latency_ms = 0` 当成「快到没有耗时」：
//!
//! | 字段 | 来源 | 口径 |
//! |---|---|---|
//! | `task_code` / `topic` | `syn_task` 关联 | 任务编码与它订阅的 topic |
//! | `record_key` | `syn_idem.idem_key` | sink 给的 `topic:partition:offset` |
//! | `verdict` / `code` / `http_status` | 台账 | 上次执行给 sink 的结论 |
//! | `stage` | 常量 `verdict` | 台账只记最终结论，不记中间轨迹 |
//! | `op` / `detail` / `latency_ms` | **无** | 台账不存；分别为 `null` / `null` / `0` |
//!
//! 没带 `X-Idempotency-Key` 的投递不会记账，也就不会出现在列表里。这是事实，
//! 不是丢数据；要看逐次轨迹得另建明细表，先改 LDM。

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::dic::SyncVerdict;
use crate::mo::syn_idem::Model as IdemModel;
use crate::spec::Verdict;


#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDeliveryVo {
    /// 台账行 ID
    pub id: U64,
    /// 任务编码
    pub task_code: String,
    /// 任务订阅的 topic（由 `syn_task` 关联带出）
    pub topic: Option<String>,
    /// 变更操作。台账不记，恒为 `null`
    pub op: Option<String>,
    /// 结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 得出结论的段。台账只存最终结论，恒为 `verdict`
    pub stage: String,
    /// 记录键，即幂等键
    pub record_key: String,
    /// 端到端耗时（毫秒）。**台账不落耗时，恒为 0**
    pub latency_ms: u64,
    /// 当时返回给 sink 的 HTTP 状态码
    pub http_status: u16,
    /// 首次记账时间
    pub create_ms: U64,
    /// 补充说明。台账不记，恒为 `null`
    pub detail: Option<String>,
}

impl SynDeliveryVo {
    /// 从台账行 + 关联任务信息构造
    pub fn new(row: IdemModel, task_code: String, topic: Option<String>) -> Self {
        let verdict = Verdict::from(SyncVerdict::from_i16(row.verdict).unwrap_or_default());
        Self {
            id: U64::from(row.id),
            task_code,
            topic,
            op: None,
            http_status: verdict.http_status(),
            verdict,
            code: row.code,
            stage: "verdict".to_string(),
            record_key: row.idem_key,
            latency_ms: 0,
            create_ms: U64::from(row.create_ms),
            detail: None,
        }
    }
}
