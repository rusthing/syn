//! # 注册中心服务名候选服务
//!
//! 从注册中心列出**服务名全集**，给控制台的 `target.service` 下拉用。
//!
//! ## 为什么失败不算错
//!
//! 这里列的是「编辑期候选」，不是运行时依赖。注册中心没配（本地单机联调）、
//! 临时不可达、后端是 etcd/nacos 这类不支持枚举的实现（框架给空列表），都只意味着
//! **没有候选项**，表单手输照常能存。把它做成 5xx 只会让配置页白屏，
//! 而配置本身完全合法。
//!
//! 所以这条链路只降级、不报错：拿不到就返回空数组并留一条 warn，
//! 让「为什么下拉是空的」在日志里查得到。

use robotech::micro_svc;
use syn_api::SynServiceVo;
use tracing::warn;

/// # 注册中心服务名候选服务
pub struct SynServiceSvc;

impl SynServiceSvc {
    /// # 列出注册中心里的服务名
    ///
    /// `namespace` / `group` 传 `None`，由注册中心客户端用自己的配置（与发现实例时
    /// 同一套前缀规则），避免「下拉里的名字和运行时发现用的名字不是一套」。
    pub async fn list() -> Vec<SynServiceVo> {
        match micro_svc::list_services(None, None).await {
            Ok(names) => names
                .into_iter()
                .map(|name| SynServiceVo { name })
                .collect(),
            Err(e) => {
                // 降级不报错：注册中心没配 / 后端不支持枚举 / 临时不可达
                warn!("列出注册中心服务名失败，候选为空（表单仍可手输）: {e}");
                Vec::new()
            }
        }
    }
}
