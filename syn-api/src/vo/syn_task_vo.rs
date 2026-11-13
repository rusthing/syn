//! # 同步任务 VO

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::mo::syn_task::Model;

/// # 同步任务
///
/// `spec` 原样返回，前端拿它渲染五段编辑器；`code` 与几个索引列同时给出，
/// 列表页不必先解析 `spec` 才能显示主题。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynTaskVo {
    /// ID
    pub id: U64,
    /// 任务编码
    pub code: String,
    /// 名称
    pub name: String,
    /// 来源 topic
    pub topic: String,
    /// 匹配优先级
    pub priority: i32,
    /// 是否启用
    pub enabled: bool,
    /// 命中后是否停止匹配
    pub exclusive: bool,
    /// 配置版本号
    pub version: i32,
    /// 五段规则（JSONB 原样）
    pub spec: serde_json::Value,
    /// 备注
    pub remark: Option<String>,
    /// 创建者
    pub creater_id: U64,
    /// 创建时间
    pub create_ms: U64,
    /// 更新者
    pub updater_id: U64,
    /// 更新时间
    pub update_ms: U64,
}

impl From<Model> for SynTaskVo {
    fn from(m: Model) -> Self {
        Self {
            id: U64::from(m.id),
            code: m.code,
            name: m.name,
            topic: m.topic,
            priority: m.priority,
            enabled: m.enabled,
            exclusive: m.exclusive,
            version: m.version,
            spec: m.spec,
            remark: m.remark,
            creater_id: U64::from(m.creater_id),
            create_ms: U64::from(m.create_ms),
            updater_id: U64::from(m.updater_id),
            update_ms: U64::from(m.update_ms),
        }
    }
}
