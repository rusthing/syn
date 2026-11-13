//! # 自拉数据源 DTO
//!
//! 这一组**是**表形状（除 `spec` 外每个字段都对应一列），但 `spec` 是 JSONB，
//! `#[crud_dto]` 会把它一并塞进 QueryDto 当等值条件 —— 没人会按「取数定义」查数据源。
//! 手写一小段比给宏加特例便宜，也让 `kind` / `enabled` 的默认值写在看得见的地方。

use crate::dic::SourceKind;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// # 保存数据源（新增与修改共用）
///
/// `topic` 留空时由服务端按 `source:{code}` 拼：虚拟 topic 的命名是**约定**，
/// 让人手填只会填出三种写法。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynSourceSaveDto {
    /// 数据源编码
    #[validate(length(min = 1, max = 64, message = "编码长度需在 1..=64 之间"))]
    pub code: String,
    /// 名称
    #[validate(length(min = 1, max = 100, message = "名称长度需在 1..=100 之间"))]
    pub name: String,
    /// 取数方式
    pub kind: SourceKind,
    /// 虚拟 topic，留空则由 `source:{code}` 生成
    #[validate(length(max = 255, message = "topic 最长 255"))]
    pub topic: Option<String>,
    /// 是否参与调度
    pub enabled: bool,
    /// 期望调度间隔（Duration 字符串）
    #[validate(length(min = 1, max = 30, message = "间隔长度需在 1..=30 之间"))]
    pub interval_duration: String,
    /// 单批行数
    #[validate(range(min = 1, max = 5000, message = "单批行数需在 1..=5000 之间"))]
    pub batch_size: i32,
    /// 取数定义（JSONB 原样）
    pub spec: serde_json::Value,
    /// 备注
    #[validate(length(max = 500, message = "备注最长 500 字"))]
    pub remark: Option<String>,
}

/// # 启停数据源
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynSourceEnabledDto {
    /// 是否参与调度
    pub enabled: bool,
}

/// # 数据源列表查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynSourceQueryDto {
    /// 关键字，匹配 `code` / `name` / `topic`
    pub keyword: Option<String>,
    /// 按取数方式筛
    pub kind: Option<SourceKind>,
    /// 按启用状态筛
    pub enabled: Option<bool>,
    /// 页码，从 1 开始
    pub page_num: Option<u64>,
    /// 每页条数
    pub page_size: Option<u64>,
}

impl SynSourceQueryDto {
    /// 页码，缺省 1
    pub fn page_num(&self) -> u64 {
        self.page_num.filter(|n| *n > 0).unwrap_or(1)
    }

    /// 每页条数，缺省 50（数据源是低频配置，一页基本够），上限 500
    pub fn page_size(&self) -> u64 {
        self.page_size.filter(|n| *n > 0).unwrap_or(50).min(500)
    }
}
