//! # 周期任务的执行侧
//!
//! syn 里会写外部系统的周期任务只有一个：**扫一遍该跑的取数来源并拉取**
//! （[`pull_wkr`]）。它交给 jobx 调度，原因见 `doc/syn-开发规范.md` §11 第 7 条：
//! 多副本下进程内 `tokio::spawn` 会让每个副本都跑、都推游标；用 Redis 锁兜底又会
//! 在锁 TTL 与扫描耗时之间留空窗。jobx 用 Redis Stream 消费者组保证「一轮只有一个
//! 副本取走」，执行结果有记录、崩溃后 `XAUTOCLAIM` 认领，业务侧不需要再加锁。
//!
//! 进程内调度器（`poll::spawn_scheduler`）仍然保留，但它只用于单副本本地开发，
//! 默认关闭；两者打的是同一段逻辑（`poll::poll_due_sources`）。

pub mod pull_wkr;

pub use pull_wkr::setup_pull_wkr;
