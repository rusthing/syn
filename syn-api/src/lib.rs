//! # syn-api
//!
//! 同步服务的**契约层**：只放类型与校验，不放行为，也不认识 SQL 与 HTTP 细节。
//!
//! - [`spec`]：五段规则（匹配 / 映射 / 动作 / 判定 / 校验），整体以 JSONB 落库；
//! - [`source_spec`]：自拉数据源的取数定义（sql 的查询与游标 / http 的分页）；
//! - [`issue`]：保存前的结构校验，错误信息带 `path`，编辑器直接定位到行；
//! - [`dic`]：字典枚举（`syn_idem.verdict` / `syn_source.kind`）；
//! - [`dto`]：入参，含 `@len` / `@range` 派生的校验；
//! - [`vo`]：出参，`camelCase` + `u64 → String`（防 JS 精度丢失）；
//! - [`mo`]：SeaORM 实体。
//!
//! `mo` / `vo` 只在 `server` 特性下编译：它们要 `sea-orm` 与实体类型，而只读 `spec` 的
//! 离线工具（比对脚本、编辑器后端）不该被拖进整套 ORM。
//!
//! 求值在 `syn-core`，IO 与持久化在 `syn-svr`。拆三个 crate 是为了让图形化编辑器、
//! 执行器、离线比对工具共用同一份定义，同时保证五段语义能在没有数据库的机器上单测。

pub mod dic;
pub mod dto;
pub mod issue;
pub mod source_spec;
pub mod spec;

#[cfg(feature = "server")]
pub mod mo;
#[cfg(feature = "server")]
pub mod vo;

pub use dic::{CanvasNodeType, SourceKind, SyncVerdict};
pub use dto::*;
// 数据源连接清单 CRUD 入参：显式列出，控制器/服务按 crate 根引用
pub use dto::{SynCanvasLayoutSaveDto, SynCanvasNodePosDto};
pub use dto::{SynDatasourceEnabledDto, SynDatasourceQueryDto, SynDatasourceSaveDto};
pub use issue::{SpecIssue, SpecIssueKind};
pub use source_spec::{CursorType, SourceSpec, WrapMode};
pub use spec::{
    Action, Assert, Binding, BodyMode, DbTarget, Guard, Header, Mapping, MappingRow, Method,
    OnConflict, OnEmpty, OnError, Op, Operator, Outcome, Scope, Target, TargetKind, TaskSpec,
    Verdict,
};
#[cfg(feature = "server")]
pub use vo::*;
