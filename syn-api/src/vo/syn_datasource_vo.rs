//! # 数据源连接清单 VO
//!
//! **不返回连接串原文**：里面带账号密码，控制台只需要知道「有哪些名字可选」。
//! `target` 是脱敏后的 `host:port/db`，用来区分同名数据源在不同环境指向哪里。

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

/// # 一个已配置的 DB 数据源
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDatasourceVo {
    /// 名字，对应 `[syn.datasources.<name>]`，也是 `spec.datasource` / `target.datasource` 要填的值
    pub name: String,
    /// 脱敏后的目标（host:port/db）；解析不出来时为 null
    pub target: Option<String>,
    /// 连接池上限
    pub max_connections: u32,
}
