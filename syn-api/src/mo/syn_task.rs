//! `SeaORM` Entity（表 `syn_task`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 同步任务
///
/// 五段规则的载体。`topic` / `priority` / `enabled` / `exclusive` 在这里是**列**，
/// 同时也是 `spec` 里的字段 —— 不是冗余，而是两层职责：
///
/// - 列要建索引、要能被 `where topic = ? order by priority` 直接筛，执行器每来一条
///   记录都要用；
/// - `spec` 是整体消费的 JSONB，没有任何一列参与检索。
///
/// **写入口以 `spec` 为准、落库时同步列**（`SynTaskSvc` 负责），读取时以列为准
/// （`store::reload` 会覆盖并用 warn 记录不一致）。这样两份数据不会各自漂移。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_task")]
pub struct Model {
    /// 主键，idworker 生成
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 任务编码，人写可读的稳定标识（对外指代任务一律用它）
    #[sea_orm(unique)]
    pub code: String,
    /// 名称
    pub name: String,
    /// 来源 topic：push 入口是 Kafka topic，poll 入口是 `source:{code}`
    pub topic: String,
    /// 匹配优先级，升序；同 topic 下数字小的先试
    pub priority: i32,
    /// 是否启用（停用只影响匹配，规则原样保留）
    pub enabled: bool,
    /// 命中后是否停止匹配后续任务（false = 一分多）
    pub exclusive: bool,
    /// 五段规则（match / mapping / actions / guards / outcomes）
    #[sea_orm(column_type = "JsonBinary")]
    pub spec: serde_json::Value,
    /// 配置版本号，每次发布 +1
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
