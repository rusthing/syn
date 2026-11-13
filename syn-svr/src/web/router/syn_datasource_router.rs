//! # 数据源连接清单路由
//!
//! 静态路径（`list` / `page`）排在 `{id}` 前，`{id}/enabled` 排在 `{id}` 前。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/datasource/list", get(list)),
    ("/syn/datasource/page", get(page)),
    ("/syn/datasource", post(add)),
    ("/syn/datasource/{id}/enabled", put(enabled)),
    ("/syn/datasource/{id}", put(modify)),
    ("/syn/datasource/{id}", delete(del_by_id)),
    ("/syn/datasource/{id}", get(get_by_id)),
])]
struct SynDatasourceRouter;
