//! `SeaORM` Entity（表 `syn_task_version`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 任务配置的不可变版本快照
///
/// 每次发布固化一份 `(task_id, version)` 的完整规则。存在的意义是回滚与追责：
/// 「上周二那条链路为什么把姓名截断了」——翻到当时的 `spec` 就有答案，
/// 不必去猜当时的配置长什么样。
///
/// 不回写到 `syn_task` 之外的地方，也不参与执行：执行器只读 `syn_task`。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_task_version")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 所属任务 ID
    pub task_id: i64,
    /// 版本号，与 `syn_task.version` 对应
    pub version: i32,
    /// 该版本的完整五段规则
    #[sea_orm(column_type = "JsonBinary")]
    pub spec: serde_json::Value,
    /// 发布说明（这一版改了什么）
    pub remark: Option<String>,
    /// 创建者
    pub creater_id: i64,
    /// 创建时间（毫秒）
    pub create_ms: i64,
    /// 更新者
    pub updater_id: i64,
    /// 更新时间（毫秒）
    pub update_ms: i64,
    /// 所属任务（级联删除：任务没了版本快照也没有意义）
    #[sea_orm(
        belongs_to,
        from = "task_id",
        to = "id",
        on_update = "Restrict",
        on_delete = "Cascade"
    )]
    pub syn_task: BelongsTo<super::syn_task::Entity>,
}

impl ActiveModelBehavior for ActiveModel {}
