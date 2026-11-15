use robotech::macros::dao;

/// # 同步任务
///
/// 身份只有主键 `id`；`name` 是人读的名字，不要求唯一（重名时按 `sort_order, id`
/// 仍能排出稳定顺序，界面上也能用 ID 区分）。
///
/// 模糊查询放在 `name` / `topic` / `remark` 上：列表页的搜索框按这三个字段找任务，
/// 没人会去搜 JSONB 里的 `spec`。
#[dao(
    like_columns: [
        Column::Name,
        Column::Topic,
        Column::Remark,
    ],
)]
pub struct SynTaskDao;
