//! # 幂等台账 DTO
//!
//! 只读：这张表由执行器在带 `X-Idempotency-Key` 的请求里写，控制台只看不写。

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// # 幂等台账查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynIdemQueryDto {
    /// 关键字，匹配 `idem_key` / 任务编码
    pub keyword: Option<String>,
    /// 按任务编码精确筛
    pub task_code: Option<String>,
    /// 页码，从 1 开始
    pub page_num: Option<u64>,
    /// 每页条数
    pub page_size: Option<u64>,
}

impl SynIdemQueryDto {
    /// 页码，缺省 1
    pub fn page_num(&self) -> u64 {
        self.page_num.filter(|n| *n > 0).unwrap_or(1)
    }

    /// 每页条数，缺省 20，上限 500
    pub fn page_size(&self) -> u64 {
        self.page_size.filter(|n| *n > 0).unwrap_or(20).min(500)
    }
}
