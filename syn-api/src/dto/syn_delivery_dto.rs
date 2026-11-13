//! # 投递记录查询
//!
//! 只读，且数据源是 `syn_idem`（幂等台账），不是一张独立的投递明细表 ——
//! 见 `dto/mod.rs` 与 `vo/syn_delivery_vo.rs` 的说明。

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// # 投递记录查询
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SynDeliveryQueryDto {
    /// 关键字，匹配 `idem_key` / 分类码
    pub keyword: Option<String>,
    /// 按任务编码精确筛
    pub task_code: Option<String>,
    /// 按结论筛：`success` / `skip` / `fatal` / `retriable`
    pub verdict: Option<String>,
    /// 页码，从 1 开始
    pub page_num: Option<u64>,
    /// 每页条数
    pub page_size: Option<u64>,
}

impl SynDeliveryQueryDto {
    /// 页码，缺省 1
    pub fn page_num(&self) -> u64 {
        self.page_num.filter(|n| *n > 0).unwrap_or(1)
    }

    /// 每页条数，缺省 20，上限 500
    pub fn page_size(&self) -> u64 {
        self.page_size.filter(|n| *n > 0).unwrap_or(20).min(500)
    }

    /// 结论字符串归一成表里的 INT2；认不出来就忽略该条件（不报错、不查空）
    pub fn verdict_code(&self) -> Option<i16> {
        match self.verdict.as_deref()?.trim().to_ascii_lowercase().as_str() {
            "success" => Some(0),
            "skip" => Some(1),
            "fatal" => Some(2),
            "retriable" => Some(3),
            _ => None,
        }
    }
}
