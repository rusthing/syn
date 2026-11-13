use robotech::macros::dao;

/// # 任务配置的版本快照
///
/// 唯一键是 `(task_id, version)`：同一任务的同一版本只能有一行，重复写说明版本号
/// 没有递增 —— 那是 svc 的 bug，宁可报错也不要静默覆盖历史。
#[dao(
    unique_keys: [
        ("task_id, version", "任务与版本号"),
    ],
)]
pub struct SynTaskVersionDao;
