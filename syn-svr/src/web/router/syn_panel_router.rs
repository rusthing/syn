//! # 控制面板导出 / 导入路由
//!
//! 都是固定路径，没有 `{id}`，顺序无关。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/panel/export", get(export)),
    ("/syn/panel/import", post(import)),
])]
struct SynPanelRouter;
