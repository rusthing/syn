//! `SeaORM` Entity（表 `syn_cursor`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 自拉数据源的水位
///
/// 独立成表而不是挂在 `syn_source` 上：游标每轮都在写，数据源是低频配置，
/// 混在一行会让「读配置」和「推水位」争同一把行锁。
///
/// 一个数据源只有一行，不建历史；`cursor_value` 是字符串而不是带类型的列，因为
/// 它可能是时间戳、自增 ID 或页码 token，类型由数据源自己声明（`cursor_type`）。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_cursor")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 数据源 ID，一对一
    #[sea_orm(unique)]
    pub source_id: i64,
    /// 水位值，空表示还没跑过（首轮从头取）
    pub cursor_value: Option<String>,
    /// 累计同步行数
    pub rows_synced: i64,
    /// 上一轮开始时间（毫秒）
    pub last_run_ms: Option<i64>,
    /// 上一轮的错误摘要，成功一轮就清空
    pub last_error: Option<String>,
    /// 创建者
    pub creater_id: i64,
    /// 创建时间（毫秒）
    pub create_ms: i64,
    /// 更新者
    pub updater_id: i64,
    /// 更新时间（毫秒）
    pub update_ms: i64,
    /// 所属数据源
    #[sea_orm(
        belongs_to,
        from = "source_id",
        to = "id",
        on_update = "Restrict",
        on_delete = "Cascade"
    )]
    pub syn_source: BelongsTo<super::syn_source::Entity>,
}

impl ActiveModelBehavior for ActiveModel {}
