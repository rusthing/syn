//! # 传输抽象
//!
//! 引擎不认识 reqwest。HTTP 走这个 trait 注入，好处有三个：
//!
//! - 五段可以完全离线单测（`MockTransport` 返回固定响应）；
//! - 影子比对时换个「只记录不发送」的实现就能拿到真实请求；
//! - 将来换成连接池/自研客户端不用动业务代码。

use async_trait::async_trait;
use serde_json::Value;
use syn_api::Method;

/// # 一次待发送的请求
#[derive(Debug, Clone)]
pub struct HttpRequest {
    /// 方法
    pub method: Method,
    /// 完整 URL（含 query）
    pub url: String,
    /// 请求头
    pub headers: Vec<(String, String)>,
    /// 请求体
    pub body: Option<Value>,
}

/// # 下游响应
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// 状态码
    pub status: u16,
    /// 响应体。非 JSON 时包成 `{"raw": "..."}`
    pub body: Value,
}

/// # 传输失败类型
///
/// 只分三类，因为下游只需要一个结论：能不能重试。
/// 超时与连不上一定可重试；其余（TLS、编码、URL 非法）当作不可重试更安全，
/// 但执行器统一按 `retriable` 交还给 sink，由 sink 的预算决定重试几次。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportErrorKind {
    /// 超时
    Timeout,
    /// 连接失败/DNS
    Connect,
    /// 其它
    Other,
}

impl TransportErrorKind {
    /// 分类码后缀
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "TIMEOUT",
            Self::Connect => "CONNECT",
            Self::Other => "OTHER",
        }
    }
}

/// # 传输失败
#[derive(Debug, Clone)]
pub struct TransportError {
    /// 类别
    pub kind: TransportErrorKind,
    /// 详情，进死信
    pub detail: String,
}

impl TransportError {
    /// 新建
    pub fn new(kind: TransportErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

/// # 传输实现
#[async_trait]
pub trait Transport: Send + Sync {
    /// 发送一次请求
    async fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError>;
}
