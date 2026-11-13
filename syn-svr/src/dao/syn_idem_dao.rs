use robotech::macros::dao;

/// # 幂等台账
///
/// 唯一键是 `(task_id, idem_key)`：按任务维度记账，同一条记录的不同任务各记一行。
/// 幂等键由 sink 给（`topic:partition:offset`），重投时命中即返回上次结论。
#[dao(
    unique_keys: [
        ("task_id, idem_key", "任务与幂等键"),
    ],
    like_columns: [
        Column::IdemKey,
    ],
)]
pub struct SynIdemDao;
