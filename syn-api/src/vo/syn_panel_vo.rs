//! # 控制面板导出 / 导入 VO
//!
//! **导出是本工程唯一输出数据源连接串明文的接口**。其余读接口一律只给脱敏后的
//! `target`；这里破例是为了让「一份文件就能把面板搬到另一套环境」成立 ——
//! 文件本身含账号密码，导出与分发都按密钥对待（前端也会在提示里写明）。
//!
//! 导出只带配置与启停状态：游标水位、最近拉取结果属于部署环境，跟着文件走会在
//! 换库时跳过一整段数据，所以一律不导。

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::dic::{DbEngine, SourceKind};
use crate::dto::SynPanelImportMode;

/// # 导出的数据源（含连接串明文）
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelDatasourceVo {
    /// 数据源编码
    pub code: String,
    /// 名称
    pub name: String,
    /// 数据库引擎
    pub engine: DbEngine,
    /// 连接串明文（含账号密码）
    pub url: String,
    /// 连接池上限
    pub max_connections: u32,
    /// 是否启用
    pub enabled: bool,
    /// 备注
    pub remark: Option<String>,
    /// 脱敏目标，供人核对文件与环境的对应关系
    pub target: Option<String>,
}

/// # 导出的数据抽取
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelSourceVo {
    /// 名称
    pub name: String,
    /// 抽取方式
    pub kind: SourceKind,
    /// 虚拟 topic
    pub topic: String,
    /// 是否参与调度
    pub enabled: bool,
    /// 期望调度间隔
    pub interval_duration: String,
    /// 单批行数
    pub batch_size: i32,
    /// 抽取定义（JSONB 原样）
    pub spec: serde_json::Value,
    /// 备注
    pub remark: Option<String>,
}

/// # 导出的任务
///
/// `spec` 已把 `topic / sort_order / enabled / exclusive` 按列覆盖：导入时任务
/// 只提交 `spec`，列由 spec 派生，不能指望文件里的旧 spec 恰好和列一致。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelTaskVo {
    /// 名称
    pub name: String,
    /// topic
    pub topic: String,
    /// 同一主题内的排序值
    pub sort_order: i32,
    /// 是否启用
    pub enabled: bool,
    /// 命中后是否停止匹配
    pub exclusive: bool,
    /// 备注
    pub remark: Option<String>,
    /// 五段规则（JSONB 原样，索引列已按列覆盖）
    pub spec: serde_json::Value,
}

/// # 控制面板导出包
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelExportVo {
    /// 服务端导出时间（毫秒）
    pub exported_ms: U64,
    /// 数据源
    pub datasources: Vec<SynPanelDatasourceVo>,
    /// 数据抽取
    pub sources: Vec<SynPanelSourceVo>,
    /// 任务
    pub tasks: Vec<SynPanelTaskVo>,
}

/// # 一类组件的导入结果计数
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelImportCounts {
    /// 新建条数
    pub created: u32,
    /// 覆盖条数
    pub updated: u32,
    /// 跳过条数
    pub skipped: u32,
}

/// # 批量导入结果
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelImportVo {
    /// 本次使用的模式
    pub mode: SynPanelImportMode,
    /// 数据源计数
    pub datasources: SynPanelImportCounts,
    /// 数据抽取计数
    pub sources: SynPanelImportCounts,
    /// 任务计数
    pub tasks: SynPanelImportCounts,
    /// 因抽取定义变更而清空水位的抽取条数
    pub watermarks_reset: u32,
}
