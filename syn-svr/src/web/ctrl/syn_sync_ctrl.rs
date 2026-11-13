//! # 同步入口
//!
//! 两个接口：
//!
//! - `POST /syn/sync/{topic}`：sink 每条记录一次调用。返回状态码就是结论：
//!   2xx 提交 offset、4xx 确定性失败进 DLQ、503 交还重试；
//! - `POST /syn/task/reload`：改完配置让执行器重新拉快照，不必重启。
//!
//! 这个入口**不鉴权用户**，鉴权的是 sink：配了 `[syn] token` 就要求
//! `X-Syn-Token`。不带用户概念，所以不用框架的 `X-User-Id` 约定。

use axum::Json;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use robotech::api::Ro;
use serde_json::json;

use crate::config::get_app_config;
use crate::store;
use crate::svc;

/// # 返回体
///
/// 结构固定，sink 侧与排障脚本都按这个读。`result` 与 HTTP 状态码同时给出，
/// 便于日志里一眼看出「是 400 但业务码是什么」。
#[allow(clippy::too_many_arguments)]
fn reply(
    status: u16,
    result: &str,
    code: &str,
    task: Option<&str>,
    stage: &str,
    detail: Option<&str>,
) -> Response {
    let body = json!({
        "result": result,
        "code": code,
        "task": task,
        "stage": stage,
        "detail": detail,
    });
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(body)).into_response()
}

/// 校验调用方是否可信
fn authorized(headers: &HeaderMap) -> bool {
    let Ok(config) = get_app_config() else {
        return false;
    };
    match &config.syn.token {
        None => true,
        Some(expected) => headers
            .get("x-syn-token")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|got| got == expected),
    }
}

/// # 处理一条变更记录
pub async fn sync(Path(topic): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers) {
        return reply(
            401,
            "fatal",
            "UNAUTHORIZED",
            None,
            "match",
            Some("缺少或错误的 X-Syn-Token"),
        );
    }

    let record: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            // 报文解析不了属于确定性失败：重试多少次都一样，直接进 DLQ
            return reply(
                400,
                "fatal",
                "BAD_PAYLOAD",
                None,
                "match",
                Some(&e.to_string()),
            );
        }
    };

    // 幂等键由 sink 给；没有就退化为「不记账」，行为与以前一致
    let idem_key = headers
        .get("x-idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let outcome = svc::handle(&topic, &record, idem_key).await;
    reply(
        outcome.http_status(),
        outcome.verdict.as_str(),
        &outcome.code,
        outcome.task.as_deref(),
        outcome.stage,
        outcome.detail.as_deref(),
    )
}

/// # 重新加载任务快照
///
/// 这个接口给控制台 / 运维用，走统一 `Ro`（不像 `sync` 要用状态码表达结论）。
/// 前端「重载快照」按钮读 `extra` 里的生效任务数。
pub async fn reload() -> Result<Json<Ro<u64>>, robotech::web::CtrlError> {
    let n = store::reload().await?;
    Ok(Json(
        robotech::api::Ro::success(format!("{n} 个任务生效")).extra(Some(n as u64)),
    ))
}
