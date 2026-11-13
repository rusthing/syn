//! # 数据源连接清单 VO
//!
//! **不返回连接串原文**：里面带账号密码，控制台只需要知道「有哪些名字可选」。
//! `target` 是脱敏后的 `host:port/db`，用来区分同名数据源在不同环境指向哪里。
//! 本结构**没有 `url`，也没有任何能还原连接串的字段** —— 由服务层用 `mask_url`
//! 生成 `target`，转换只发生在服务端。

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

/// # 一个已配置的 DB 数据源
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDatasourceVo {
    /// ID
    pub id: U64,
    /// 数据源编码
    pub code: String,
    /// 名称
    pub name: String,
    /// 脱敏后的目标（host:port/db）；解析不出来时为 null
    pub target: Option<String>,
    /// 连接池上限
    pub max_connections: u32,
    /// 是否启用
    pub enabled: bool,
    /// 备注
    pub remark: Option<String>,
    /// 配置版本号
    pub version: i32,
    /// 创建者
    pub creater_id: U64,
    /// 创建时间
    pub create_ms: U64,
    /// 更新者
    pub updater_id: U64,
    /// 更新时间
    pub update_ms: U64,
}
