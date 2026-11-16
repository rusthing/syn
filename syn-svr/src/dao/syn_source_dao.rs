use robotech::macros::dao;

/// # 数据抽取
///
/// 两个唯一键：`code` 是抽取定义标识（虚拟 topic 由它拼），`topic` 必须唯一 ——
/// 两个抽取定义共用一个虚拟 topic，任务就分不清记录是哪来的。
#[dao(
    unique_keys: [
        ("code", "抽取编码"),
        ("topic", "虚拟 topic"),
    ],
    like_columns: [
        Column::Code,
        Column::Name,
        Column::Topic,
        Column::Remark,
    ],
)]
pub struct SynSourceDao;
