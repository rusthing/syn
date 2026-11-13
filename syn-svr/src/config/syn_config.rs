//! # syn 自身配置

use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

/// # syn 段
///
/// ```toml
/// [syn]
/// # 只有想覆盖默认值时才写，一般整个段落都不需要出现
/// pull-timeout = "30s"
///
/// # DB 直写的数据源。一个下游一个账号
/// [syn.datasources.dtw]
/// url = "postgresql://syn_dtw:xxx@10.0.0.12:5432/dtw"
/// ```
///
/// 这里**只有业务策略**：投递语义、下游库账号。
/// 环境相关与框架已负责的东西一律不进来 ——
/// - HTTP 目标地址不配：`target.service` 是注册中心里的服务名，
///   运行时按名字查（见 `crate::registry`），换环境不改配置；
/// - 端口不配：监听端口由框架给（随机），真实端口登记在注册中心；
/// - 雪花 node 不配：框架按实例自动分配（见 `robotech::app::setup_id_worker`）；
/// - 快照刷新不配间隔：任务写库后发刷新信号，各副本收到就重建（见 `crate::store`）；
/// - 取数计划不配：默认就向 jobx 注册，见 [`PullJobConfig`]；
/// - sink 入口不加自制令牌：边界是 overlay 内网 + 网关，和 dtw / msg / alarm 一致。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct SynConfig {
    /// DB 直写的数据源表，键是 `target.datasource`
    #[serde(default)]
    pub datasources: HashMap<String, DataSourceConfig>,
    /// 是否启动时预加载快照（关掉方便空库启动）
    #[serde(default = "default_true")]
    pub load_on_start: bool,
    /// 拉取数据源时的单次查询超时
    #[serde(default = "default_pull_timeout")]
    pub pull_timeout: String,
    /// 取数心跳计划。**默认就注册**，不需要在配置里出现：
    /// 周期取数归 jobx 管（多副本下一轮只跑一次），缺省一套参数即可跑。
    /// 只有想改参数或显式关掉时才写 `[syn.pull-job]`，见 [`PullJobConfig`]。
    #[serde(default)]
    pub pull_job: PullJobConfig,
}

/// # 取数心跳计划
///
/// **默认就有**，不需要写进配置：
///
/// | 项 | 默认值 |
/// |----|--------|
/// | `enabled` | `true` |
/// | `name` | `syn 取数心跳` |
/// | `executor-code` | `syn.pull` |
/// | `interval-duration` | `5s` |
/// | `group-name` | `syn` |
/// | `task-expire-duration` | `1h` |
///
/// 一个计划扫**所有**启用的数据源，而不是一个来源一个计划：来源是控制台随时增删的
/// 配置，一个来源一个计划就得在业务写库里同步调 jobx、失败还要补偿；而且来源的
/// `interval-duration` 最小 1s，jobx 的计划粒度撑不住。所以这里只负责「隔一会儿打一拍」，
/// 「哪个源到点了」由 `poll::poll_due_sources` 判断。
///
/// 因此**实际精度 = max(interval-duration, 每个源的 interval-duration)**；计划是 5s 时，
/// 源配 1s 也只会 5s 拉一次。要更快就把这里的间隔调小，但高频计划的 `jobx_task`
/// 会按「每天 86400 / 秒数」增长，所以 `task-expire-duration` 必须配。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct PullJobConfig {
    /// 是否注册。默认开；显式 `enabled = false` 可关掉（本地不想连 jobx 时用）
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 计划名称。同名视为同一个计划，重复启动撞唯一键后只补分组
    #[serde(default = "default_pull_job_name")]
    pub name: String,
    /// 执行器编码。**必须与执行器配置一致**，否则计划照常分派、没有执行器认领
    #[serde(default = "default_pull_job_executor")]
    pub executor_code: String,
    /// 心跳间隔。真正的「哪个源到点了」由每个源的配置决定
    #[serde(default = "default_pull_job_interval")]
    pub interval_duration: String,
    /// jobx 计划分组名（给人看的归类维度，不存在会自动创建）
    #[serde(default = "default_pull_job_group")]
    pub group_name: String,
    /// 任务记录保留时长。高频计划不配就是永久保留，`jobx_task` 会无限长
    #[serde(default = "default_pull_job_expire")]
    pub task_expire_duration: String,
    /// 备注，只在该计划首次创建时写入
    #[serde(default)]
    pub remark: Option<String>,
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
            datasources: HashMap::new(),
            load_on_start: true,
            pull_timeout: default_pull_timeout(),
            pull_job: PullJobConfig::default(),
        }
    }
}

impl Default for PullJobConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            name: default_pull_job_name(),
            executor_code: default_pull_job_executor(),
            interval_duration: default_pull_job_interval(),
            group_name: default_pull_job_group(),
            task_expire_duration: default_pull_job_expire(),
            remark: None,
        }
    }
}

impl SynConfig {
    /// 拉取超时
    pub fn pull_timeout(&self) -> Duration {
        humantime::parse_duration(&self.pull_timeout).unwrap_or(Duration::from_secs(30))
    }
}

fn default_pull_timeout() -> String {
    "30s".to_string()
}

fn default_pull_job_name() -> String {
    "syn 取数心跳".to_string()
}

fn default_pull_job_executor() -> String {
    "syn.pull".to_string()
}

fn default_pull_job_interval() -> String {
    // 不取 1s：jobx 每个周期落一行 jobx_task，1s 就是每天 8.6 万行，
    // 而 syn 的源最小间隔本来也是 1s，5s 的误差对「5 秒重叠窗口」无影响
    "5s".to_string()
}

fn default_pull_job_group() -> String {
    "syn".to_string()
}

fn default_pull_job_expire() -> String {
    "1h".to_string()
}

fn default_true() -> bool {
    true
}
