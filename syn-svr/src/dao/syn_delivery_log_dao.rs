use robotech::macros::dao;

/// # 投递明细（失败 / 重试）
///
/// 只增不改：写入由 `sync_svc` 在失败时顺手做，读取留给排障与后续页面，
/// 清理由 jobx 的保留期计划按 `create_ms` 批量删除。
#[dao(
    like_columns: [
        Column::TaskName,
        Column::Code,
    ],
)]
pub struct SynDeliveryLogDao;
