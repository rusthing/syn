//! # 注册中心服务名候选 VO
//!
//! 只给控制台「http 投递目标服务名」下拉当**编辑期候选**用：任务里存进 `spec`
//! 的仍是服务名字符串（`target.service`），运行时按名字查实例。
//!
//! 这条边界不能破：注册中心里有什么是**环境事实**，今天有 `dtw-rs-svr`、明天可能
//! 改名；配置如果依赖「当时列出来的名字」，开发/生产注册中心不同就写不出配置，
//! 下游还没上线就存不了任务。所以列表拉不到时表单必须能纯手输。

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// # 一个可作为投递目标的服务名
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynServiceVo {
    /// 注册中心里的服务名，即 `target.service` 要填的值
    pub name: String,
}
