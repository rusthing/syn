//! # syn-core
//!
//! 五段求值引擎。**没有任何 IO**：HTTP 走 [`Transport`] 注入，DB 直写走
//! [`DbWriter`] 注入，配置由调用方给。
//!
//! 这样划分的理由很实际：五段是全部业务语义所在，必须能在没有数据库、没有下游、
//! 没有 kafka 的机器上跑单测与影子比对；而「把结论翻成状态码还给 sink」这件事
//! 属于执行器的固定语义，不该混进求值逻辑。

pub mod assertion;
pub mod db;
pub mod engine;
pub mod mapping;
pub mod transform;
pub mod transport;
pub mod value;
pub mod verdict;
pub mod wkb;

pub use assertion::{Context, eval};
pub use db::{DbError, DbWriter};
pub use engine::{Execution, Stage, execute, execute_db, matches};
pub use mapping::{MapFailure, MappedBody, Trace, map};
pub use transform::{TransformError, apply as apply_transform};
pub use transport::{HttpRequest, HttpResponse, Transport, TransportError, TransportErrorKind};
pub use value::get_path;
pub use verdict::{Judgement, judge};
pub use wkb::to_wkt;
