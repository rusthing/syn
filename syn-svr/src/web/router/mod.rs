//! # 路由
//!
//! `linkme` 自注册：这里只要 `mod` 一下，生成的 `build_router` 就会进 `ROUTER_SLICE`，
//! 不需要在别处引用。静态路径排在 `{id}` 前，见各文件。

mod syn_datasource_router;
mod syn_delivery_router;
mod syn_idem_router;
mod syn_overview_router;
mod syn_source_router;
mod syn_sync_router;
mod syn_task_router;
