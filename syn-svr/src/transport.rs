//! # reqwest 传输实现
//!
//! 引擎只认 `syn-core::Transport`，这里给它一个真实现。
//! 超时在这里统一设死：单条记录的处理时间是 sink 的 `http.timeout` 的子集，
//! 太长会把 sink 的 worker 拖住，太短会把下游的正常慢查询打成可重试。

use async_trait::async_trait;
use std::sync::LazyLock;
use std::time::Duration;
use syn_core::{HttpRequest, HttpResponse, Transport, TransportError, TransportErrorKind};

/// 单次请求超时。下游是内网单体接口，正常 2~30ms，3s 已经非常宽裕
const TIMEOUT: Duration = Duration::from_secs(3);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// # 共享的 reqwest 客户端
///
/// 自拉取数（`poll`）也用它，但会按 `[syn] pull-timeout` 在单次请求上覆盖超时 ——
/// 拉一页比投递一条慢得多，不能用同一个 3 秒。
pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

/// # HTTP 传输
pub struct HttpTransport;

#[async_trait]
impl Transport for HttpTransport {
    async fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let method = reqwest::Method::from_bytes(req.method.as_str().as_bytes())
            .map_err(|e| TransportError::new(TransportErrorKind::Other, e.to_string()))?;

        let mut builder = CLIENT.request(method, &req.url);
        for (k, v) in &req.headers {
            builder = builder.header(k, v);
        }
        if let Some(body) = &req.body {
            builder = builder.json(body);
        }

        let resp = builder.send().await.map_err(|e| {
            let kind = if e.is_timeout() {
                TransportErrorKind::Timeout
            } else if e.is_connect() {
                TransportErrorKind::Connect
            } else {
                TransportErrorKind::Other
            };
            TransportError::new(kind, e.to_string())
        })?;

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let body =
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));

        Ok(HttpResponse { status, body })
    }
}
