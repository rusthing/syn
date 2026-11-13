//! # 总览 VO

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

/// # 一小时桶
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynOverviewHourVo {
    /// 桶起点（整点毫秒）
    pub hour_ms: U64,
    /// 成功
    pub success: u64,
    /// 业务失败
    pub fatal: u64,
    /// 暂时失败
    pub retriable: u64,
}

/// # 失败分类 Top
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynOverviewFailureVo {
    /// 分类码
    pub code: String,
    /// 任务编码
    pub task_code: String,
    /// 次数
    pub count: u64,
}

/// # 总览
///
/// 口径写在字段上，不做「猜」：`total` 统计的是**幂等台账里的记账行**。
/// 没开幂等记账（请求不带 `X-Idempotency-Key`）时这些数恒为 0 —— 这是事实，
/// 不是「没命中」。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynOverviewVo {
    /// 统计窗口（原样回显）
    pub window: String,
    /// 记账总行数
    pub total: u64,
    /// 成功
    pub success: u64,
    /// 跳过
    pub skip: u64,
    /// 业务失败
    pub fatal: u64,
    /// 暂时失败
    pub retriable: u64,
    /// P95 端到端耗时（毫秒）。执行器不落耗时，恒为 0
    pub p95_ms: u64,
    /// 任务总数
    pub tasks: u64,
    /// 启用中的任务数
    pub enabled_tasks: u64,
    /// 数据源总数
    pub sources: u64,
    /// 卡住的数据源数（超过 3 个周期没动过水位）
    pub stalled_sources: u64,
    /// 每小时桶，长度固定 = 窗口小时数
    pub series: Vec<SynOverviewHourVo>,
    /// 失败分类 Top 10
    pub top_failures: Vec<SynOverviewFailureVo>,
}
