//! # 总览路由

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/overview", get(overview)),
])]
struct SynOverviewRouter;
