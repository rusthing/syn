//! # 同步入口路由
//!
//! 两个手写接口，没有 CRUD，所以单独一棵路由树。
//! 生成的代码会一次性导入四个构造器，这里只用到 `post`，屏蔽未使用导入告警。

#![allow(unused_imports)]

use robotech::macros::router;

#[router(routes [
    ("/syn/sync/{topic}", post(sync)),
    ("/syn/task/reload", post(reload)),
])]
struct SynSyncRouter;
