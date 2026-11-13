//! # 自拉数据源 VO

use robotech::api::U64;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use utoipa::ToSchema;

use crate::dic::SourceKind;
use crate::mo::syn_cursor::Model as CursorModel;
use crate::mo::syn_source::Model as SourceModel;

/// # 数据源的水位
///
/// 与 `syn_cursor` 的列不完全同名：`cursor_value` 出去叫 `position`（「水位值」在
/// 界面上是「当前位置」），并且把「最近一次跑」的四个字段收在一起 —— 游标是
/// 一个整体状态，拆开摆在数据源上会让人以为它们是数据源的属性。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynCursorVo {
    /// 水位值（时间戳 / 自增 ID / 页码 token），空表示还没跑过
    pub position: Option<String>,
    /// 累计同步行数
    pub rows_synced: i64,
    /// 上一轮开始时间
    pub last_run_ms: Option<U64>,
    /// 上一轮的错误摘要，成功一轮就清空
    pub last_error: Option<String>,
}

impl From<CursorModel> for SynCursorVo {
    fn from(m: CursorModel) -> Self {
        Self {
            position: m.cursor_value,
            rows_synced: m.rows_synced,
            last_run_ms: m.last_run_ms.map(U64::from),
            last_error: m.last_error,
        }
    }
}

/// # 自拉数据源
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynSourceVo {
    /// ID
    pub id: U64,
    /// 数据源编码
    pub code: String,
    /// 名称
    pub name: String,
    /// 取数方式
    pub kind: SourceKind,
    /// 虚拟 topic
    pub topic: String,
    /// 是否参与调度
    pub enabled: bool,
    /// 期望调度间隔
    pub interval_duration: String,
    /// 单批行数
    pub batch_size: i32,
    /// 取数定义（JSONB 原样）
    pub spec: serde_json::Value,
    /// 配置版本号
    pub version: i32,
    /// 备注
    pub remark: Option<String>,
    /// 水位。还没建游标行时为 `null`（诚实：没跑过）
    pub cursor: Option<SynCursorVo>,
    /// 创建者
    pub creater_id: U64,
    /// 创建时间
    pub create_ms: U64,
    /// 更新者
    pub updater_id: U64,
    /// 更新时间
    pub update_ms: U64,
}

impl SynSourceVo {
    /// 拼上水位
    pub fn with_cursor(mut self, cursor: Option<CursorModel>) -> Self {
        self.cursor = cursor.map(SynCursorVo::from);
        self
    }
}

impl From<SourceModel> for SynSourceVo {
    fn from(m: SourceModel) -> Self {
        Self {
            id: U64::from(m.id),
            code: m.code,
            name: m.name,
            kind: SourceKind::from_i16(m.kind).unwrap_or_default(),
            topic: m.topic,
            enabled: m.enabled,
            interval_duration: m.interval_duration,
            batch_size: m.batch_size,
            spec: m.spec,
            version: m.version,
            remark: m.remark,
            cursor: None,
            creater_id: U64::from(m.creater_id),
            create_ms: U64::from(m.create_ms),
            updater_id: U64::from(m.updater_id),
            update_ms: U64::from(m.update_ms),
        }
    }
}

/// # 立即拉取一轮的结果
///
/// 不只是「拉了几行」：`stalled` 说明这一轮为什么停在那里（遇到 fatal 就不再推进
/// 游标），`verdicts` 是四类结论的分布。运维看这三个数就知道「是没数据、还是被
/// 一条坏数据卡住了」。
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynSourcePullVo {
    /// 本轮推进成功的行数（游标前进了这么多）
    pub rows: u64,
    /// 本轮耗时（毫秒）
    pub duration_ms: u64,
    /// 四条结论各自的条数
    pub success: u64,
    /// 跳过
    pub skip: u64,
    /// 业务失败
    pub fatal: u64,
    /// 暂时失败
    pub retriable: u64,
    /// 推进到的水位；这一轮一行都没成功时为 `null`
    pub position: Option<String>,
    /// 卡住的原因（第一条非 success/skip 的结论），成功一轮为 `null`
    pub stalled: Option<String>,
}
