//! # DB 直写的传输抽象
//!
//! 与 [`Transport`](crate::Transport) 并列：五段产出一行字段，最后一步要么拼成 HTTP
//! 请求，要么拼成 `insert ... on conflict`。引擎不认识 sqlx，DB 写入也走 trait 注入，
//! 这样「一行数据会被写成什么样」可以在没有数据库的机器上单测。
//!
//! 与 HTTP 的差异只有一处：**没有状态码**。写成功给的是影响行数，所以判定段看到的
//! 是一个合成的 200 + `{"affected": n}`，规则照常写 `$.affected eq 0` 就能表达
//! 「没写进去任何行」这种语义。

use async_trait::async_trait;
use serde_json::{Map, Value};
use syn_api::{DbTarget, Op};

/// # 写入失败
///
/// 只回答「能不能重试」。可重试的是连接类与并发类（连不上、超时、死锁、序列化失败），
/// 其余（约束冲突、列不存在、类型不匹配）重试多少次都一样，属于死信。
#[derive(Debug, Clone)]
pub struct DbError {
    /// 是否可重试
    pub retriable: bool,
    /// 分类码，进死信与「能不能改报文重投」的判断
    pub code: String,
    /// 详情
    pub detail: String,
}

impl DbError {
    /// 可重试（连接、超时、死锁）
    pub fn retriable(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            retriable: true,
            code: code.into(),
            detail: detail.into(),
        }
    }

    /// 确定性失败（约束、类型、权限）
    pub fn fatal(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            retriable: false,
            code: code.into(),
            detail: detail.into(),
        }
    }
}

/// # DB 写入实现
///
/// 返回受影响行数。`op = d` 时是删除，其余三种按 `target.on_conflict` 走 upsert。
#[async_trait]
pub trait DbWriter: Send + Sync {
    /// 写一行
    async fn write(
        &self,
        target: &DbTarget,
        op: Op,
        row: &Map<String, Value>,
    ) -> Result<u64, DbError>;
}
