//! # 画布布局 DTO
//!
//! 只有「批量保存坐标」一个入参：拓扑页拖动松手时把变动过的节点一起提交。
//! 校验注解与 `model/create-table-pgsql.sql` 的列注释一一对应
//! （`node_key` 的 `@len`、`x` / `y` 的 `@range`）；审计四列不进 DTO。
//!
//! 不做「删一条坐标」的接口：坐标是纯展示态，节点删掉之后残行由画布忽略，
//! 少一个接口就少一处要解释的语义。

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

use crate::dic::CanvasNodeType;

/// # 一个节点的坐标
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynCanvasNodePosDto {
    /// 节点类型：数据源 / 取数来源 / 主题 / 任务
    pub node_type: CanvasNodeType,
    /// 节点标识：数据源 / 来源 / 任务填 code，主题填 topic 名
    #[validate(length(min = 1, max = 128, message = "节点标识长度需在 1..=128 之间"))]
    pub node_key: String,
    /// 画布横坐标（世界坐标，与缩放无关）
    #[validate(range(min = 0, max = 20000, message = "横坐标需在 0..=20000 之间"))]
    pub x: i32,
    /// 画布纵坐标（世界坐标，与缩放无关）
    #[validate(range(min = 0, max = 20000, message = "纵坐标需在 0..=20000 之间"))]
    pub y: i32,
}

/// # 批量保存节点坐标
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynCanvasLayoutSaveDto {
    /// 本次变动过的节点；一次最多 500 个（画布上不会有这么多节点）
    #[validate(
        length(max = 500, message = "一次最多保存 500 个节点位置"),
        nested
    )]
    pub nodes: Vec<SynCanvasNodePosDto>,
}
