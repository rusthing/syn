//! # 自拉数据源路由
//!
//! `pull` 是给 jobx 与运维按钮共用的端点。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/source/list", get(list)),
    ("/syn/source/page", get(page)),
    ("/syn/source", post(add)),
    ("/syn/source/{id}/pull", post(pull)),
    ("/syn/source/{id}/enabled", put(enabled)),
    ("/syn/source/{id}", put(modify)),
    ("/syn/source/{id}", delete(del_by_id)),
    ("/syn/source/{id}", get(get_by_id)),
])]
struct SynSourceRouter;
