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
    /// ID 生成器。**多副本必须各配一个不同的 `node`**，否则两台机器会算出同一个雪花 ID，
    /// `syn_task` 主键直接撞车。见 `syn-svr.toml` 的 `[id-worker]`
    #[serde(default = "IdWorkerConfig::default")]
    pub id_worker: IdWorkerConfig,
    /// syn 自身配置
    #[serde(default = "SynConfig::default")]
    pub syn: SynConfig,
}
