//! # 数据源连接清单 DTO
//!
//! 校验注解与 `model/create-table-pgsql.sql` 的列注释一一对应
//! （`@len` / `@range` / `@check`）。业务 DTO **不含审计四列**：由框架在落库时填。
//!
//! `url` 是唯一「表里有、DTO 里可选」的字段：新增必填，修改留空/None 表示保持原连接串。

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// # 保存数据源（新增与修改共用）
///
/// `url` 含账号密码，只在写入时收；读接口一律不回显（见 `SynDatasourceVo`）。
/// 修改时 `url` 留空（`None` / 空串）表示不改连接串，其余字段照常更新。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynDatasourceSaveDto {
    /// 数据源编码
    #[validate(length(min = 1, max = 64, message = "编码长度需在 1..=64 之间"))]
    pub code: String,
    /// 名称
    #[validate(length(min = 1, max = 100, message = "名称长度需在 1..=100 之间"))]
    pub name: String,
    /// 连接串（含账号密码）。新增必填；修改留空/None 表示保持原值
    #[validate(length(min = 1, max = 500, message = "连接串长度需在 1..=500 之间"))]
    pub url: Option<String>,
    /// 连接池上限
    #[validate(range(min = 1, max = 100, message = "连接池上限需在 1..=100 之间"))]
    pub max_connections: u32,
    /// 是否启用（`@check is_enabled`：布尔类型本身即约束）
    pub enabled: bool,
    /// 备注
    #[validate(length(max = 500, message = "备注最长 500 字"))]
    pub remark: Option<String>,
}

/// # 启停数据源
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDatasourceEnabledDto {
    /// 是否启用
    pub enabled: bool,
}

/// # 数据源列表查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynDatasourceQueryDto {
    /// 关键字，匹配 `code` / `name` / `remark`
    pub keyword: Option<String>,
    /// 按启用状态筛
    pub enabled: Option<bool>,
    /// 页码，从 1 开始
    pub page_num: Option<u64>,
    /// 每页条数
    pub page_size: Option<u64>,
}

impl SynDatasourceQueryDto {
    /// 页码，缺省 1
    pub fn page_num(&self) -> u64 {
        self.page_num.filter(|n| *n > 0).unwrap_or(1)
    }

    /// 每页条数，缺省 50，上限 500
    pub fn page_size(&self) -> u64 {
        self.page_size.filter(|n| *n > 0).unwrap_or(50).min(500)
    }
}
