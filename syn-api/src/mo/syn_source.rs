//! `SeaORM` Entity（表 `syn_source`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 数据抽取（poll）
///
/// 一个抽取定义的一批数据可以喂给多个任务，任务侧不需要知道数据是推来的还是拉来的：
/// `topic` 写成虚拟 topic `source:{code}`，五段规则照常按 topic 匹配。
///
/// `kind` 决定 `spec` 的形状（sql 的全量快照 / 游标增量 / http 的地址与分页），
/// 三种都产出行 JSON，形态一致。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_source")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 数据抽取编码，虚拟 topic 由它拼出
    #[sea_orm(unique)]
    pub code: String,
    /// 名称
    pub name: String,
    /// 抽取方式，见 `SourceKind`
    pub kind: i16,
    /// 虚拟 topic，形如 `source:adm_person_full`
    #[sea_orm(unique)]
    pub topic: String,
    /// 是否参与调度（停用不影响已配的游标，重新启用从原水位继续）
    pub enabled: bool,
    /// 期望的调度间隔（Duration 字符串，如 `5s` / `1m`），实际触发由 jobx 保证
    pub interval_duration: String,
    /// 单批行数
    pub batch_size: i32,
    /// 抽取定义
    #[sea_orm(column_type = "JsonBinary")]
    pub spec: serde_json::Value,
    /// 配置版本号
    pub version: i32,
    /// 备注
    pub remark: Option<String>,
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
