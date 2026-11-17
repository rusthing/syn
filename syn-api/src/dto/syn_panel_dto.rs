//! # 控制面板导出 / 导入 DTO
//!
//! 导入是一次**批量写**：把面板里的三类组件（数据源 / 数据抽取 / 任务）按文件
//! 一次性提交，服务端在同一个事务里写。`mode` 决定「同 code（任务按主题 + 名称）
//! 的已存在组件」是覆盖还是跳过。
//!
//! 这里直接复用三个资源的保存 DTO，而不是另造一套「导入行」：
//! 校验规则（编码长度、连接串必填、spec 结构）只该有一份，导入不该是绕过校验的后门。

use super::{SynDatasourceSaveDto, SynSourceSaveDto, SynTaskSaveDto};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// # 导入模式
///
/// - `overwrite`：文件里同 code 的数据源 / 数据抽取、同主题 + 名称的任务覆盖库里那条；
/// - `skip`：已存在的组件原样不动，只补文件里有、库里没有的。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SynPanelImportMode {
    /// 覆盖已存在的组件
    #[default]
    Overwrite,
    /// 已存在的组件跳过
    Skip,
}

/// # 批量导入控制面板配置
///
/// 三类组件按依赖顺序写：数据源 → 数据抽取 → 任务。三份数组都允许为空，
/// 但引用关系必须自洽（抽取引用的数据源、db 任务直写的数据源都得在「库里的 +
/// 文件里的」集合里），否则整批回滚。
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SynPanelImportDto {
    /// 覆盖还是跳过已存在的组件
    #[serde(default)]
    pub mode: SynPanelImportMode,
    /// 数据源（含连接串明文；新增必填）
    #[serde(default)]
    pub datasources: Vec<SynDatasourceSaveDto>,
    /// 数据抽取
    #[serde(default)]
    pub sources: Vec<SynSourceSaveDto>,
    /// 任务（主题 / 排序 / 启停 / 独占从 spec 派生）
    #[serde(default)]
    pub tasks: Vec<SynTaskSaveDto>,
}
