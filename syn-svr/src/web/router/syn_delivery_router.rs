//! # 投递记录路由（只读）

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/delivery/page", get(page)),
])]
struct SynDeliveryRouter;
