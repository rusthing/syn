//! # 数据抽取 DTO
//!
//! 这一组**是**表形状（除 `spec` 外每个字段都对应一列），但 `spec` 是 JSONB，
//! `#[crud_dto]` 会把它一并塞进 QueryDto 当等值条件 —— 没人会按「抽取定义」查数据源。
//! 手写一小段比给宏加特例便宜，也让 `kind` / `enabled` 的默认值写在看得见的地方。

use crate::dic::SourceKind;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// # 保存数据抽取（新增与修改共用）
///
/// `topic` 是数据抽取的唯一业务键，必填：它就是任务侧精确匹配的那条虚拟 topic，
/// 也是画布上数据抽取节点的标识。去掉 `code` 后没有可推导的来源，留空就等于
/// 没有关联键，所以这里直接收字符串、不再做 `source:{code}` 的兜底。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynSourceSaveDto {
    /// 名称
    #[validate(length(min = 1, max = 100, message = "名称长度需在 1..=100 之间"))]
    pub name: String,
    /// 抽取方式
    pub kind: SourceKind,
    /// 虚拟 topic：任务按它精确匹配，必须唯一
    #[validate(length(min = 1, max = 255, message = "topic 长度需在 1..=255 之间"))]
    pub topic: String,
    /// 是否参与调度
    pub enabled: bool,
    /// 期望调度间隔（Duration 字符串）
    #[validate(length(min = 1, max = 30, message = "间隔长度需在 1..=30 之间"))]
    pub interval_duration: String,
    /// 单批行数
    #[validate(range(min = 1, max = 5000, message = "单批行数需在 1..=5000 之间"))]
    pub batch_size: i32,
    /// 抽取定义（JSONB 原样）
    pub spec: serde_json::Value,
    /// 备注
    #[validate(length(max = 500, message = "备注最长 500 字"))]
    pub remark: Option<String>,
}

/// # 启停数据抽取
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynSourceEnabledDto {
    /// 是否参与调度
    pub enabled: bool,
}

/// # 数据抽取列表查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynSourceQueryDto {
    /// 关键字，匹配 `name` / `topic`
    pub keyword: Option<String>,
    /// 按抽取方式筛
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
