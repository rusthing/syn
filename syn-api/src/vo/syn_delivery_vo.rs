//! # 投递记录 VO
//!
//! **这张 VO 是两张表的并集**，不是某一张表的镜像：
//!
//! - `syn_idem`（幂等台账）只记 success / skip，是 `record_key` 有值的那部分；
//! - `syn_delivery_log`（投递明细）只记 fatal / retriable，带 `stage` / `detail` /
//!   `latency_ms` / 真实 `http_status`，自拉链路（没有幂等键）的失败也在里面。
//!
//! 两张表互补、不重叠：失败结论不能进幂等台账（否则重投命中缓存就永远不会再试），
//! 成功/跳过也没必要再写一份明细。列表按 `create_ms` 倒序合并。
//!
//! | 字段 | 台账行 | 明细行 |
//! |---|---|---|
//! | `source` | `idem` | `log` |
//! | `record_key` | `idem_key` | `record_key`（自拉为空） |
//! | `stage` | 恒为 `verdict` | 失败所在段 |
//! | `latency_ms` | 恒为 0（台账不落耗时） | 本任务实际耗时 |
//! | `http_status` | 按结论换算 | 下游真实状态码（传输失败为空） |
//! | `detail` | 恒为 NULL | 失败详情 |
//!
//! 没有逐次执行明细的成功/跳过仍然只有一条台账行：同一条记录重投命中缓存时不会
//! 产生新行，`create_ms` 是首次记账时间。这是幂等台账的口径，不是丢数据。

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::spec::Verdict;

#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDeliveryVo {
    /// 行 ID（两张表各自的主键，跨表可能重复，前端要用 `source` 一起做 key）
    pub id: U64,
    /// 数据来源：`idem`（幂等台账）或 `log`（投递明细）
    pub source: String,
    /// 任务名称。任务已删除时台账行可能为空字符串
    pub task_name: String,
    /// 任务订阅的 topic
    pub topic: Option<String>,
    /// 变更操作。台账行恒为 `null`；明细行记 `c` / `r` / `u` / `d`
    pub op: Option<String>,
    /// 结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 得出结论的段。台账行恒为 `verdict`
    pub stage: String,
    /// 记录键，即幂等键；自拉链路的失败明细没有，为空
    pub record_key: Option<String>,
    /// 本任务耗时（毫秒）。台账行不落耗时，恒为 0
    pub latency_ms: u64,
    /// 下游 HTTP 状态码。台账行按结论换算；传输失败 / DB 直写失败为空
    pub http_status: Option<u16>,
    /// 实际发出的请求体快照（JSON 文本）。台账行恒为 `null`
    pub request_body: Option<String>,
    /// 下游响应体快照（JSON 文本）。台账行恒为 `null`
    pub response_body: Option<String>,
    /// 首次记账时间 / 明细产生时间
    pub create_ms: U64,
    /// 补充说明（失败详情）。台账行恒为 `null`
    pub detail: Option<String>,
}
