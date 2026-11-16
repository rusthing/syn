use robotech::macros::dic;
use strum::{AsRefStr, Display, EnumString};

/// 数据抽取的抽取方式，对应 `syn_source.kind`。
///
/// 两种方式产出的记录**形态完全相同**（虚拟 topic 里的一行 JSON），所以任务侧
/// 的五段规则不需要知道数据是查库来的还是翻页来的。见 `doc/syn-通用同步模型.md` §2。
#[dic(default = Sql)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, AsRefStr, Display, EnumString)]
#[strum(serialize_all = "kebab-case")]
pub enum SourceKind {
    /// SQL 取数：由 `spec.mode` 决定「全量快照」还是「游标增量」，推荐方式
    Sql = 0,
    /// 分页拉接口：按 `next_path` 翻页，对方接口质量决定一切
    Http = 1,
}
