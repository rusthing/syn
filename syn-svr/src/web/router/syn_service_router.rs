//! # 注册中心服务名候选路由

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/registry/services", get(services)),
])]
struct SynServiceRouter;
