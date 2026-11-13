//! # OpenAPI 清单
//!
//! `POST /syn/sync/{topic}` 与 `POST /syn/task/reload` **不在**这里：它们返回
//! `(StatusCode, Json)` 且面向 sink，不需要出现在控制台的 swagger 里。
//! 其余五个资源的手写方法必须逐个列全 —— 漏一个不报错，只是文档里查不到。

mod syn_datasource_api_doc;
mod syn_delivery_api_doc;
mod syn_idem_api_doc;
mod syn_overview_api_doc;
mod syn_source_api_doc;
mod syn_task_api_doc;

pub use syn_datasource_api_doc::*;
pub use syn_delivery_api_doc::*;
pub use syn_idem_api_doc::*;
pub use syn_overview_api_doc::*;
pub use syn_source_api_doc::*;
pub use syn_task_api_doc::*;
