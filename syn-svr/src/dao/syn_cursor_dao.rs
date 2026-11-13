use robotech::macros::dao;

/// # 数据源水位
///
/// 一个数据源一行（`source_id` 唯一）：多行会变成「哪一行才是当前水位」的猜谜，
/// 而历史水位没有任何用处 —— 需要历史时看审计列。
#[dao(
    unique_keys: [
        ("source_id", "数据源"),
    ],
)]
pub struct SynCursorDao;
