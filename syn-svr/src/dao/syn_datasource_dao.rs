use robotech::macros::dao;

/// # DB 数据源（连接配置）
///
/// 唯一键 `code`（`AK_CODE_SYN_DATASOURCE`）：任务与来源按它指代数据源，重复了
/// 就分不清引用的是哪一条。
///
/// 模糊查询放在 `code` / `name` / `remark` 上；`url` 含账号密码，**不参与检索**，
/// 否则等于给了一个按密文猜测连接串的入口。
#[dao(
    unique_keys: [
        ("code", "数据源编码"),
    ],
    like_columns: [
        Column::Code,
        Column::Name,
        Column::Remark,
    ],
)]
pub struct SynDatasourceDao;
