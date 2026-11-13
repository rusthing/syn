//! `SeaORM` Entity（表 `syn_datasource`）
//!
//! DB 数据源连接配置。`url` 含账号密码，**明文只写不回显**：所有读接口只输出
//! 脱敏后的 `host:port/db`（见 `SynDatasourceVo::target`），实体列与
//! `model/create-table-pgsql.sql` 逐字对齐。

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # DB 数据源（连接配置）
///
/// `code` 是任务与来源按名字引用数据源的唯一标识；`url` 明文只写不回显，
/// 编辑时留空表示不修改。改动后由刷新信号失效各副本连接池（不在实体层职责内）。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_datasource")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 数据源编码，对应 target.datasource 与 source.spec.datasource
    #[sea_orm(unique)]
    pub code: String,
    /// 名称
    pub name: String,
    /// 连接串（含账号密码）；明文只写不回显
    pub url: String,
    /// 连接池上限
    pub max_connections: i32,
    /// 是否启用
    pub enabled: bool,
    /// 备注
    pub remark: Option<String>,
    /// 配置版本号
    pub version: i32,
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
