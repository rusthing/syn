//! # 字典枚举
//!
//! 只放**落库成 INT2** 的枚举。它们与 `spec.rs` 里那些写进 JSONB 的字符串枚举是两套东西：
//!
//! | 位置 | 表示 | 改名代价 |
//! |---|---|---|
//! | 表列（`syn_idem.verdict` / `syn_source.kind`） | `INT2`，见列注释的 `@enum` | 无，整数是稳定契约 |
//! | `spec` JSONB（`verdict` / `op` / `scope`…） | 小写字符串 | 有，配置与文档都按名字指代 |
//!
//! 不要为了「统一」把 JSONB 里的字符串改成整数：那份配置是给人读、给人改的，
//! `"retriable"` 比 `3` 更难写错。

mod canvas_node_type;
mod source_kind;
mod sync_verdict;

pub use canvas_node_type::CanvasNodeType;
pub use source_kind::SourceKind;
pub use sync_verdict::SyncVerdict;
