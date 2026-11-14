//! `SeaORM` Entity（表结构映射）
//!
//! 五张表一一对应，**没有第二个来源**：列名、类型、可空性跟 `model/create-table-pgsql.sql`
//! 逐字对齐，`///` 注释抄列注释的首行。改表先改 LDM → PDM → DDL，再回来改这里。
//!
//! `syn_cursor` 的运行时字段（`rows_synced` / `last_error`）也在这五个实体里，
//! 不是「配置表 vs 运行表」的区别 —— 框架的 `#[dao]`/`#[crud_dto]` 假定审计四列存在，
//! 少一列编译不过，这一点见规范 §11.4。

pub mod prelude;

pub mod syn_canvas_layout;
pub mod syn_cursor;
pub mod syn_datasource;
pub mod syn_idem;
pub mod syn_source;
pub mod syn_task;
pub mod syn_task_version;
