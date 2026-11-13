//! # 全局配置
//!
//! 与其它服务一致的形态：`ArcSwapOption` 保存，支持配置中心热更新时整体替换。

use arc_swap::ArcSwapOption;
use config::Value;
use idworker::IdWorkerConfig;
use robotech::cfg::CfgError;
use robotech::db::DbConnConfig;
use robotech::web::WebServerConfig;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::info;

use crate::config::SynConfig;

static APP_CONFIG: ArcSwapOption<AppConfig> = ArcSwapOption::const_empty();

/// # 取全局配置
pub fn get_app_config() -> Result<Arc<AppConfig>, CfgError> {
    APP_CONFIG
        .load_full()
        .ok_or(CfgError::NotInit("AppConfig not initialized".to_string()))
}

/// # 初始化全局配置
pub fn setup_app_config(app_config: AppConfig, _changed: &Option<HashMap<String, Value>>) {
    info!("setup app config...");
    APP_CONFIG.store(Some(Arc::new(app_config)));
}

/// # 配置文件结构
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub struct AppConfig {
    /// 数据库
    pub db: DbConnConfig,
    /// Web 服务器
    #[serde(default = "WebServerConfig::default")]
    pub web: WebServerConfig,
    /// ID 生成器。`node` 留空由框架按实例自动分配（注册中心里记 `id-node`），
    /// 多副本不会撞号；只有「分配不到就回退 0」这种极端情况才需要显式指定
    #[serde(default = "IdWorkerConfig::default")]
    pub id_worker: IdWorkerConfig,
    /// syn 自身配置
    #[serde(default = "SynConfig::default")]
    pub syn: SynConfig,
    /// API 客户端表（键是逻辑名，如 `jobx`）。取数心跳向 jobx 注册计划时用；
    /// 没配时跳过注册，sink 推送与手工 pull 照常。
    #[serde(default)]
    pub api: HashMap<String, robotech::api_client::ApiClientConfig>,
    /// Redis。取数心跳的执行器从 Stream 收任务；没配时跳过注册。
    #[serde(default)]
    pub redis: Option<robotech::redis::RedisConfig>,
    /// NATS。任务写库后在这里发刷新信号，所有副本收到就重建快照；
    /// 没配时退化为「只有写的那台重载」，单副本开发/联调够用。
    #[serde(default)]
    pub nats: Option<robotech::mq::nats::NatsConfig>,
}
