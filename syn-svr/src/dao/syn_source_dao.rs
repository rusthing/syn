use robotech::macros::dao;

/// # 自拉数据源
///
/// 两个唯一键：`code` 是数据源标识（虚拟 topic 由它拼），`topic` 必须唯一 ——
/// 两个数据源共用一个虚拟 topic，任务就分不清记录是哪来的。
#[dao(
    unique_keys: [
        ("code", "数据源编码"),
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
