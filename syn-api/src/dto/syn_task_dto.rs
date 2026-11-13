//! # 同步任务 DTO

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// # 保存任务（新增与修改共用）
///
/// `spec` 是完整的五段规则，**任务的标识与索引列都从它派生**：
/// `spec.id → code`、`spec.topic → topic`、`spec.priority → priority`、
/// `spec.enabled → enabled`、`spec.exclusive → exclusive`。
///
/// 只提交一份规则、由服务端拆列，是为了避免「同一件事填两个地方」：
/// 若让调用方同时传 `topic` 和 `spec.topic`，两者不一致时行为就取决于读取顺序。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Validate)]
#[serde(rename_all = "camelCase")]
pub struct SynTaskSaveDto {
    /// 名称
    #[validate(length(min = 1, max = 100, message = "名称长度需在 1..=100 之间"))]
    pub name: String,
    /// 备注
    #[validate(length(max = 500, message = "备注最长 500 字"))]
    pub remark: Option<String>,
    /// 五段规则（JSONB 原样）
    pub spec: serde_json::Value,
}

/// # 启停任务
///
/// 单独一个接口而不是复用保存：停用只影响匹配，不动规则、不产生新版本。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynTaskEnabledDto {
    /// 是否启用
    pub enabled: bool,
}

/// # 任务列表查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynTaskQueryDto {
    /// 关键字，匹配 `code` / `name` / `topic`
    pub keyword: Option<String>,
    /// 按来源 topic 精确筛
    pub topic: Option<String>,
    /// 按启用状态筛
    pub enabled: Option<bool>,
    /// 页码，从 1 开始
    pub page_num: Option<u64>,
    /// 每页条数
    pub page_size: Option<u64>,
}

impl SynTaskQueryDto {
    /// 页码，缺省 1
    pub fn page_num(&self) -> u64 {
        self.page_num.filter(|n| *n > 0).unwrap_or(1)
    }

    /// 每页条数，缺省 20，上限 500（列表页不需要一次拉全表）
    pub fn page_size(&self) -> u64 {
        self.page_size.filter(|n| *n > 0).unwrap_or(20).min(500)
    }
}
