//! # 控制器
//!
//! 五个资源各一个手写 ctrl，加上给 sink 的 `syn_sync_ctrl`。命名与 `#[router]` 宏
//! 从 Router 结构名推导的 `xxx_ctrl` 模块一一对应，改名会让宏找不到 handler。

pub(crate) mod common;

pub mod syn_datasource_ctrl;
pub mod syn_delivery_ctrl;
pub mod syn_idem_ctrl;
pub mod syn_overview_ctrl;
pub mod syn_source_ctrl;
pub mod syn_sync_ctrl;
pub mod syn_task_ctrl;
