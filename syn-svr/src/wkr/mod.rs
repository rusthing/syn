//! # 周期任务的执行侧
//!
//! syn 里交给 jobx 调度、需要写外部系统的任务有两类：
//!
//! 1. **扫一遍该跑的数据抽取并拉取**（[`pull_wkr`]）—— 多副本下必须只有一个副本取走
//!    一轮，否则会互相把游标推乱；
//! 2. **过期数据清理**（[`cleanup_wkr`]）—— 删除超过保留期的 `syn_idem` 与
//!    `syn_delivery_log`，同样只应跑一次。
//!
//! 原因见 `doc/syn-开发规范.md` §11 第 7 条：多副本下进程内 `tokio::spawn` 会让每个
//! 副本都跑；用 Redis 锁兜底又会在锁 TTL 与执行耗时之间留空窗。jobx 用 Redis Stream
//! 消费者组保证「一轮只有一个副本取走」，执行结果有记录、崩溃后 `XAUTOCLAIM` 认领，
//! 业务侧不需要再加锁。
//!
//! 进程内**没有**调度器：两者都由 jobx 计划驱动，进程只提供执行器与 handler。

pub mod cleanup_wkr;
pub mod pull_wkr;

pub use cleanup_wkr::setup_cleanup_wkr;
pub use pull_wkr::setup_pull_wkr;
