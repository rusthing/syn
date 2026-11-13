//! # 幂等台账 VO

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::dic::SyncVerdict;

/// # 幂等台账一行
///
/// 一个 `(task_id, idem_key)` 只有一行：重投时读到它就直接返回上次的结论，
/// 不再执行。所以这里**没有「命中次数」** —— 计数不在表的形状里，
/// 要统计命中次数得另建投递明细，不能凭空编一列。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynIdemVo {
    /// ID
    pub id: U64,
    /// 任务编码（对外一律用编码，不用 ID）
    pub task_code: String,
    /// 幂等键，形如 `topic:partition:offset`
    pub idem_key: String,
    /// 上次的结论
    pub verdict: SyncVerdict,
    /// 上次的分类码
    pub code: String,
    /// 首次记账时间
    pub create_ms: U64,
    /// 最近一次更新时间（重投命中会刷新它）
    pub update_ms: U64,
}
