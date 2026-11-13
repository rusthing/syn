//! # syn 自身配置

use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

/// # syn 段
///
/// ```toml
/// [syn]
/// token = "xxxxxxxx"
/// reload-duration = "10s"
///
/// # 服务名 → 真实地址。执行器只认这个表，不查服务发现，也不让配置里出现 URL
/// [syn.targets]
/// dtw-rs-svr = "http://gatexrs:80"
///
/// # DB 直写的数据源。一个下游一个账号
/// [syn.datasources.dtw]
/// url = "postgresql://syn_dtw:xxx@10.0.0.12:5432/dtw"
/// ```
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct SynConfig {
    /// 共享令牌。配置了就要求请求带 `X-Syn-Token`，不配则只允许内网裸跑
    #[serde(default)]
    pub token: Option<String>,
    /// 目标服务地址表，键是 `target.service`
    #[serde(default)]
    pub targets: HashMap<String, String>,
    /// DB 直写的数据源表，键是 `target.datasource`
    #[serde(default)]
    pub datasources: HashMap<String, DataSourceConfig>,
    /// 是否启动时预加载快照（关掉方便空库启动）
    #[serde(default = "default_true")]
    pub load_on_start: bool,
    /// 快照巡检间隔：比对「任务条数 + 最大更新时间」，变了就重载。
    /// 多副本时靠它让每个副本都跟上别人的修改（重载按钮只打到其中一台）
    #[serde(default = "default_reload")]
    pub reload_duration: String,
    /// 拉取数据源时的单次查询超时
    #[serde(default = "default_pull_timeout")]
    pub pull_timeout: String,
    /// 是否在进程内自起 poll 调度器。**默认关闭**：写库类周期任务归 jobx，
    /// 由它定时打 `POST /syn/source/{id}/pull`（见 `syn-通用同步模型.md` §2.3）。
    /// 打开只用于单副本本地开发，多副本会重复拉数。
    #[serde(default)]
    pub self_schedule: bool,
}

/// # 一个 DB 直写数据源
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct DataSourceConfig {
    /// 连接串
    pub url: String,
    /// 连接池上限。DB 直写是同步链路，池子开太大只会把下游库的连接数吃满
    #[serde(default = "default_max_connections")]
    pub max_connections: u32,
}

fn default_max_connections() -> u32 {
    4
}

impl Default for SynConfig {
    fn default() -> Self {
        Self {
            token: None,
            targets: HashMap::new(),
            datasources: HashMap::new(),
            load_on_start: true,
            reload_duration: default_reload(),
            pull_timeout: default_pull_timeout(),
            self_schedule: false,
        }
    }
}

impl SynConfig {
    /// 快照巡检间隔。下限 1s：比这更密就是在空转查库
    pub fn reload_interval(&self) -> Duration {
        humantime::parse_duration(&self.reload_duration)
            .unwrap_or(Duration::from_secs(10))
            .max(Duration::from_secs(1))
    }

    /// 拉取超时
    pub fn pull_timeout(&self) -> Duration {
        humantime::parse_duration(&self.pull_timeout).unwrap_or(Duration::from_secs(30))
    }
}

fn default_reload() -> String {
    "10s".to_string()
}

fn default_pull_timeout() -> String {
    "30s".to_string()
}

fn default_true() -> bool {
    true
}
