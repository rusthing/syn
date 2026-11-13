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
//! ## 为什么不直接用框架的 FeignApiClient
//!
//! Feign 是「选址 + 发请求」打包的重客户端，四处契约与本链路相反：服务名由
//! `[api.xxx]` 在启动期静态装配（这里是任务表里的运行时数据）；响应是 `Ro<E>`、
//! 非 2xx 即错误（这里要把原始 status/body 交给 `outcomes` 判定）；失败自动换实例
//! 重试（这里一次投递只许有一个结论，重投由 sink 的预算决定）；发现 0 实例时降级
//! 补发现（这里必须显式 fatal，不能猜地址把数据发出去）。所以复用的是**选址层**，
//! 见 `robotech::micro_svc::instance_resolver` 的模块文档。
//!
//! ## 职责边界
//!
//! 缓存、TTL、空结果负缓存、每服务轮转、并发刷新合并、失败保留旧实例全在框架；
//! Feign 客户端与这里共享同一份按服务名的实例快照。本模块只做两件业务相关的事：
//! 把空服务名翻译成指向任务配置的提示，以及把「解析不到」判定成致命失败。
//! 5s TTL 由本服务给：投递是「一条记录一次」的热路径，比普通服务调用密得多。

use robotech::micro_svc::{ResolveError, choose_instance, instance_base_url};
use std::time::Duration;

/// 发现结果的缓存时长。够短，换实例/扩容后很快生效；够长，热路径上不打爆注册中心
const TTL: Duration = Duration::from_secs(5);

/// # 解析服务地址
///
/// 返回 `http://{ip}:{port}`，可直接作为 `syn_core::execute` 的 `base_url`。
///
/// 解析不到实例是**部署问题不是数据问题**，调用方应作为致命失败返回，
/// 不能猜一个地址把数据发出去。
pub async fn resolve_base_url(service: &str) -> Result<String, String> {
    validate_service_name(service)?;

    match choose_instance(service, None, None, TTL).await {
        Ok(instance) => Ok(instance_base_url(&instance)),
        Err(ResolveError::InvalidServiceName) => {
            Err("任务没有配置 target.service（HTTP 投递必须给出服务名）".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_service_name_is_rejected_without_querying_registry() {
        let err = validate_service_name("  ").unwrap_err();
        assert!(err.contains("target.service"), "{err}");
        assert!(validate_service_name("dtw-rs-svr").is_ok());
    }
}
