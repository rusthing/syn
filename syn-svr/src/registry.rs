//! # 目标服务地址解析
//!
//! 任务的 `target.service`（如 `dtw-rs-svr`）是**注册中心里的服务名**，不是地址。
//! 配置里不写 URL：写 URL 等于把「哪个环境、几副本、什么端口」固化进业务配置，
//! 换环境就得改任务。
//!
//! ## 为什么不走网关
//!
//! 走网关要拼上服务名前缀（`http://gatex/服务名/路径`），而 `target.base` 是
//! **服务内路径**（`/dtw/region`），两者语义不同；直连实例不必区分，也没有多一跳。
//! 网关的用途是给浏览器/外部调用方做入口，服务之间的调用走注册中心更直接。
//!
//! ## 缓存
//!
//! 一条记录一次投递，逐条查注册中心会把 consul 打满。这里按服务名缓存
//! [`TTL`]，到期后重新发现；空结果同样缓存（下游整体下线时不要每一条都去问一次，
//! 但也不能一直缓存着，否则下游恢复后要等重启）。
//!
//! ## 轮询
//!
//! 一次发现可能返回多个实例，按进程内自增计数轮转，避免所有请求压在同一台上。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// 发现结果的缓存时长。够短，换实例/扩容后很快生效；够长，热路径上不打爆注册中心
const TTL: Duration = Duration::from_secs(5);

struct Cached {
    at: Instant,
    bases: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 轮转游标。全局一个即可：不同服务之间串着转，不影响各自内部的均衡
static CURSOR: AtomicUsize = AtomicUsize::new(0);

/// # 解析服务地址
///
/// 返回 `http://{ip}:{port}`，可直接作为 `syn_core::execute` 的 `base_url`。
///
/// 解析不到实例是**部署问题不是数据问题**，调用方应作为致命失败返回，
/// 不能猜一个地址把数据发出去。
pub async fn resolve_base_url(service: &str) -> Result<String, String> {
    validate_service_name(service)?;

    if let Some(hit) = pick_from_cache(service) {
        return Ok(hit);
    }

    let instances = robotech::micro_svc::discover_service(service, None, None)
        .await
        .map_err(|e| format!("从注册中心发现服务 {service} 失败：{e}"))?;

    let bases: Vec<String> = instances
        .iter()
        .filter(|i| !i.ip.trim().is_empty() && i.port > 0)
        .map(|i| format!("http://{}:{}", i.ip, i.port))
        .collect();

    if bases.is_empty() {
        // 缓存空结果，避免下游整体下线时每条记录都去问一次注册中心
        store_cache(service, Vec::new());
        warn!("注册中心里服务 {service} 没有可用实例");
        return Err(format!("注册中心里服务 {service} 没有可用实例"));
    }

    debug!("服务 {service} 解析到 {} 个实例: {bases:?}", bases.len());
    let picked = pick(&bases, CURSOR.fetch_add(1, Ordering::Relaxed));
    let picked = picked.clone();
    store_cache(service, bases);
    Ok(picked)
}

/// # 服务名合法性
///
/// 空服务名是配置错误，在查注册中心之前就拒绝：报错要指向任务配置，
/// 而不是一句「注册中心里没有实例」。
fn validate_service_name(service: &str) -> Result<(), String> {
    if service.trim().is_empty() {
        return Err("任务没有配置 target.service（HTTP 投递必须给出服务名）".to_string());
    }
    Ok(())
}

fn pick_from_cache(service: &str) -> Option<String> {
    let mut guard = cache().lock().ok()?;
    let hit = guard.get(service)?;
    if hit.at.elapsed() > TTL {
        guard.remove(service);
        return None;
    }
    if hit.bases.is_empty() {
        // 上次发现是空的：仍然按失败返回，但不重复查注册中心
        return None;
    }
    let bases = hit.bases.clone();
    drop(guard);
    Some(pick(&bases, CURSOR.fetch_add(1, Ordering::Relaxed)).clone())
}

fn store_cache(service: &str, bases: Vec<String>) {
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            service.to_string(),
            Cached {
                at: Instant::now(),
                bases,
            },
        );
    }
}

/// 按游标取一个实例。调用方保证 `bases` 非空
fn pick(bases: &[String], cursor: usize) -> &String {
    &bases[cursor % bases.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_wraps_around() {
        let bases = vec![
            "http://10.0.0.1:9000".to_string(),
            "http://10.0.0.2:9000".to_string(),
        ];
        assert_eq!(pick(&bases, 0), "http://10.0.0.1:9000");
        assert_eq!(pick(&bases, 1), "http://10.0.0.2:9000");
        assert_eq!(pick(&bases, 2), "http://10.0.0.1:9000");
    }

    #[test]
    fn pick_single_instance_is_stable() {
        let bases = vec!["http://10.0.0.1:9000".to_string()];
        for i in 0..5 {
            assert_eq!(pick(&bases, i), "http://10.0.0.1:9000");
        }
    }

    #[test]
    fn empty_service_name_is_rejected_without_querying_registry() {
        let err = validate_service_name("  ").unwrap_err();
        assert!(err.contains("target.service"), "{err}");
        assert!(validate_service_name("dtw-rs-svr").is_ok());
    }
}
