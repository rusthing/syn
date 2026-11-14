//! # 画布布局 VO
//!
//! 只回坐标本身，不带审计列：前端拿它铺节点位置，不需要「谁什么时候拖的」。
//! `node_type` 按整数出（`1 数据源 / 2 来源 / 3 主题 / 4 任务`），前端用字典映射，
//! 与表里的 `@enum` 同一份定义。

use serde::Serialize;
use utoipa::ToSchema;

use crate::dic::CanvasNodeType;

/// # 一个节点的坐标
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynCanvasLayoutVo {
    /// 节点类型
    pub node_type: CanvasNodeType,
    /// 节点标识
    pub node_key: String,
    /// 画布横坐标（世界坐标）
    pub x: i32,
    /// 画布纵坐标（世界坐标）
    pub y: i32,
}
