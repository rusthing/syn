//! `SeaORM` Entity 的简写导出
//!
//! 业务代码用 `mo::prelude::SynTask` 指代实体，不写 `mo::syn_task::Entity`。

pub use super::syn_cursor::Entity as SynCursor;
pub use super::syn_idem::Entity as SynIdem;
pub use super::syn_source::Entity as SynSource;
pub use super::syn_task::Entity as SynTask;
pub use super::syn_task_version::Entity as SynTaskVersion;
