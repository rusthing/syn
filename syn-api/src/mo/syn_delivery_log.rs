//! `SeaORM` Entity（表 `syn_delivery_log`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 投递明细（只记失败 / 重试）
///
/// 与 [`super::syn_idem`] 的分工：
///
/// - `syn_idem` 是**幂等台账**，只记 success / skip，重投命中缓存就直接返回；
/// - 这张表是**排障明细**，只记 fatal / retriable，回答「在哪一段失败、为什么、
///   下游回了什么、花了多久」。失败结论不能进幂等台账，否则重投永远不会再试。
///
/// `task_id` 是弱引用（不建外键）：任务删除后历史明细仍应可查，也不能反过来
/// 阻塞删除。保留期由 jobx 的清理计划按 `create_ms` 处理。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_delivery_log")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 任务 ID（弱引用 `syn_task.id`）
    pub task_id: i64,
    /// 任务名称（落库时冗余，任务改名/删除后仍能看懂）
    pub task_name: String,
    /// 记录来源 topic
    pub topic: String,
    /// 幂等键；自拉链路没有，为 NULL
    pub record_key: Option<String>,
    /// 结论，只写 2=Fatal / 3=Retriable，见 `SyncVerdict`
    pub verdict: i16,
    /// 分类码
    pub code: String,
    /// 得出结论的段
    pub stage: String,
    /// 失败详情
    pub detail: Option<String>,
    /// 下游 HTTP 状态码；没发出请求 / 传输失败 / DB 直写失败时为空
    pub http_status: Option<i16>,
    /// 本任务执行耗时（毫秒）
    pub latency_ms: i32,
    /// 创建者
    pub creater_id: i64,
    /// 创建时间（毫秒），清理按它计算保留期
    pub create_ms: i64,
    /// 更新者
    pub updater_id: i64,
    /// 更新时间（毫秒）
    pub update_ms: i64,
}

impl ActiveModelBehavior for ActiveModel {}
