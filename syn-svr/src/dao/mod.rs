//! # 数据访问层
//!
//! 一个实体一个 DAO，只做单表 SQL：条件拼装、分页、唯一键错误翻译。
//! **不开事务**（事务由 svc 传 `DatabaseTransaction` 进来）、**不做业务判断**。
//!
//! `unique_keys` 里的列名要与 DDL 里的约束**逐字一致**：框架靠它把
//! `23505`（唯一冲突）翻译成「任务编码已存在」，写错列名只会退化成 500。

mod syn_cursor_dao;
mod syn_idem_dao;
mod syn_source_dao;
mod syn_task_dao;
mod syn_task_version_dao;

pub use syn_cursor_dao::SynCursorDao;
pub use syn_idem_dao::SynIdemDao;
pub use syn_source_dao::SynSourceDao;
pub use syn_task_dao::SynTaskDao;
pub use syn_task_version_dao::SynTaskVersionDao;
