//! # 数据源连接清单路由

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [("/syn/datasource/list", get(list))])]
struct SynDatasourceRouter;
