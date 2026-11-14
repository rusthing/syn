//! # 画布布局路由
//!
//! 只有一个路径、两个方法：`GET` 读全量，`PUT` 批量写坐标。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/canvas/layout", get(layout)),
    ("/syn/canvas/layout", put(save_layout)),
])]
struct SynCanvasLayoutRouter;
