//! `SeaORM` Entity（表 `syn_idem`）

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// # 幂等记账
///
/// 一条记录命中多个任务时，重投不能让已经成功的任务再写一次。键由调用方给
/// （sink 的 `X-Idempotency-Key`，形如 `topic:partition:offset`），按
/// **任务维度**记账：同一条记录的两个任务各自成功才算整体成功。
///
/// 重投时直接返回这里记下的结论，不再执行 —— 这是 at-least-once 下唯一能省掉
/// 重复 IO 的地方，也是「几分钱的接口不用打两遍」。
#[sea_orm::model]
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Serialize, Deserialize, Default)]
#[sea_orm(table_name = "syn_idem")]
pub struct Model {
    /// 主键
    #[sea_orm(primary_key, auto_increment = false, unique)]
    pub id: i64,
    /// 任务 ID（按任务维度记账，不按记录维度）
    pub task_id: i64,
    /// 幂等键
    pub idem_key: String,
    /// 该键上次的结论，见 `SyncVerdict`
    pub verdict: i16,
    /// 该键上次的分类码，如 `OK` / `NOT_FOUND` / `TIMEOUT`
    pub code: String,
    /// 创建者
    pub creater_id: i64,
    /// 创建时间（毫秒）
    pub create_ms: i64,
    /// 更新者
    pub updater_id: i64,
    /// 更新时间（毫秒）
    pub update_ms: i64,
    /// 所属任务
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
