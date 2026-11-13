//! # 幂等台账路由（只读）

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/idem/page", get(page)),
])]
struct SynIdemRouter;
