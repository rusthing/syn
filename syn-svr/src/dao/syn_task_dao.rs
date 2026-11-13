use robotech::macros::dao;

/// # 同步任务
///
/// `code` 是唯一键（`AK_CODE_SYN_TASK`）：它是任务的对外标识，重复了就没有意义 ——
/// 日志与 topic 匹配都按它指代，两条同名任务会让「改的是哪一条」变成猜。
///
/// 模糊查询放在 `code` / `name` / `topic` 上：列表页的搜索框按这三个字段找任务，
/// 没人会去搜 JSONB 里的 `spec`。
#[dao(
    unique_keys: [
        ("code", "任务编码"),
    ],
    like_columns: [
        Column::Code,
        Column::Name,
        Column::Topic,
        Column::Remark,
    ],
)]
pub struct SynTaskDao;
