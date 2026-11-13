//! # 同步任务路由
//!
//! 静态路径排在 `{id}` 前面；同一路径的四种方法由 axum 合并，不冲突。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/task/list", get(list)),
    ("/syn/task/page", get(page)),
    ("/syn/task", post(create)),
    ("/syn/task/{id}", put(modify)),
    ("/syn/task/{id}/enabled", put(enabled)),
    ("/syn/task/{id}", delete(del_by_id)),
    ("/syn/task/{id}", get(get_by_id)),
])]
struct SynTaskRouter;
