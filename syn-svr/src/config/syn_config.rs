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
    /// 取数心跳计划：配了就在启动时注册成 jobx 计划任务，由调度器保证多副本下
    /// 一轮只跑一次。**不配就不注册**（本地开发、没有 jobx 的环境照常跑）。
    /// 见 `crate::wkr`。
    #[serde(default)]
    pub pull_job: Option<PullJobConfig>,
}

/// # 取数心跳计划
///
/// ```toml
/// [syn.pull-job]
/// name = "syn 取数心跳"
/// executor-code = "syn.pull"
/// interval-duration = "5s"
/// ```
///
/// 一个计划扫**所有**启用的数据源，而不是一个来源一个计划：来源是控制台随时增删的
/// 配置，一个来源一个计划就得在业务写库里同步调 jobx、失败还要补偿；而且来源的
/// `interval-duration` 最小 1s，jobx 的计划粒度撑不住。所以这里只负责「隔一会儿打一拍」，
/// 「哪个源到点了」由 `poll::poll_due_sources` 判断，与进程内调度器同一段逻辑。
///
/// 因此**实际精度 = max(interval-duration, 每个源的 interval-duration)**；计划是 5s 时，
/// 源配 1s 也只会 5s 拉一次。要更快就把这里的间隔调小，但高频计划的 `jobx_task`
/// 会按「每天 86400 / 秒数」增长，所以 `task-expire-duration` 必须配。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct PullJobConfig {
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
            token: None,
            targets: HashMap::new(),
            datasources: HashMap::new(),
            load_on_start: true,
            reload_duration: default_reload(),
            pull_timeout: default_pull_timeout(),
            self_schedule: false,
            pull_job: None,
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
