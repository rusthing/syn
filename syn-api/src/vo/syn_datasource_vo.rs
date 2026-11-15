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

/// # 一次连接测试的结果
///
/// 测试失败**不是接口错误**：连通与否是数据，200 也要能表达「连不上」。
/// 状态栏要同时显示成败与耗时，所以这里给 `ok` 而不是靠 HTTP 状态码区分。
///
/// `server` 是 `select current_setting('server_version')` 的结果（例如
/// `PostgreSQL 16.4`），用来确认连到的确实是目标库；连不上时为 `None`。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynDatasourceTestVo {
    /// 是否连通
    pub ok: bool,
    /// 建连（+ 探活查询）耗时，毫秒
    pub elapsed_ms: U64,
    /// 服务端版本；连不上时不返回
    pub server: Option<String>,
    /// 状态栏文字：成功时「连接成功」，失败时「连接失败：xxx」
    pub message: String,
}
