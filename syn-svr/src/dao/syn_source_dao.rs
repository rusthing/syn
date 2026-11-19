use robotech::macros::dao;

/// # 数据抽取
///
/// 唯一键只有 `topic`：它是数据抽取与任务关联的唯一键 —— 两个抽取共用同一个
/// topic，任务就分不清记录是哪来的。
#[dao(
    unique_keys: [
        ("topic", "虚拟 topic"),
    ],
    like_columns: [
        Column::Name,
        Column::Topic,
        Column::Remark,
    ],
)]
pub struct SynSourceDao;
