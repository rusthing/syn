use robotech::macros::dic;
use strum::{AsRefStr, Display, EnumString};

/// 拓扑画布上的节点类型，对应 `syn_canvas_layout.node_type`。
///
/// 只用来给坐标定位：同一种 `node_key` 在不同类型下是不同节点（任务编码和数据源
/// 编码可以重名）。节点本身不存在这里 —— 画布每次从任务 / 来源 / 数据源三张表
/// 现拼，坐标表里多出来的行按「孤儿」丢弃。
///
/// 数值从 1 起，0 留空：老数据的默认值不该悄悄等于某个真类型。
#[dic(default = Task)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, AsRefStr, Display, EnumString)]
#[strum(serialize_all = "kebab-case")]
pub enum CanvasNodeType {
    /// 数据源：`node_key` 是 `syn_datasource.code`
    Datasource = 1,
    /// 取数来源：`node_key` 是 `syn_source.code`
    Source = 2,
    /// 主题：`node_key` 是 topic 名（CDC topic 或 `source:{code}`）
    Topic = 3,
    /// 任务：`node_key` 是 `syn_task.code`
    Task = 4,
}
