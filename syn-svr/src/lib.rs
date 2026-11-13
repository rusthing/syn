// `SvcError` 是框架类型（含 anyhow/DAO/校验等大变体），业务层每个 `Result` 都会
// 触发 result_large_err；把错误装箱会改变框架约定的 `?` 转换链，得不偿失。
// ActiveModel 逐个 `Set` 是 SeaORM 的惯用写法，改成结构体初始化式反而看不清哪些列被改。
#![allow(clippy::result_large_err, clippy::field_reassign_with_default)]

//! # syn-svr
//!
//! 执行器进程。只做三件事：
//!
//! 1. 从 `syn_task` 读配置，维护一份不可变快照；
//! 2. 对 `POST /syn/sync/{topic}` 的每条记录选出该由哪个任务处理；
//! 3. 把五段的结论翻译成给 sink 的 HTTP 状态码。
//!
//! 它**不重试、不排队、不管死信**——那些是 sink 的 `http.retry.*` 与 Kafka Connect
//! 的 DLQ。执行器只回答一个问题：这条记录这次算成功、跳过、还是失败。
//!
//! 另有一条自拉链路：`poll` 按 `syn_source` 的间隔查源库，把行包成虚拟 topic 的记录，
//! 再走**同一个** `svc::sync_svc::handle`。自拉与 sink 推送只是「记录从哪来」不同，
//! 五段规则完全一致。

pub mod config;
pub mod dao;
pub mod db_sink;
pub mod poll;
pub mod store;
pub mod svc;
pub mod transport;
pub mod web;

/// 重新导出契约层：控制器与测试写 `crate::spec::TaskSpec`，不写 `syn_api::spec::TaskSpec`
pub use syn_api::*;
