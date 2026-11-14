//! `SeaORM` Entity（表 `syn_canvas_layout`）
//!
//! 只存画布坐标：一个节点一行，按 `(node_type, node_key)` 唯一。
//! 节点本身不在这张表里 —— 拓扑页每次从任务 / 来源 / 数据源现拼，
//! 没写过坐标的节点走默认网格，写过但节点已删的残行由画布忽略（不清理，
//! 因为「删了又建同名」时保留原位反而更符合直觉）。

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 画布布局（节点坐标）
///
/// `x` / `y` 是**世界坐标**，与缩放无关；缩放与平移只存在前端内存里。
/// 数值上限按 DDL 的 `@range 0..=20000`，超出说明前端算了 NaN 或负值。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_canvas_layout")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 节点类型，见 `CanvasNodeType`
    pub node_type: i16,
    /// 节点标识：数据源 / 来源 / 任务填 code，主题填 topic 名
    pub node_key: String,
    /// 画布横坐标（世界坐标）
    pub x: i32,
    /// 画布纵坐标（世界坐标）
    pub y: i32,
    /// 创建者
    pub creater_id: i64,
    /// 创建时间（毫秒）
    pub create_ms: i64,
    /// 更新者
    pub updater_id: i64,
    /// 更新时间（毫秒）
    pub update_ms: i64,
}

impl ActiveModelBehavior for ActiveModel {}
