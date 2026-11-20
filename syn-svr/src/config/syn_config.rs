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
    /// 拉取数据源时的单次查询超时。单个源可以在 `spec.timeout_duration` 里覆盖它
    #[serde(default = "default_pull_timeout")]
    pub pull_timeout: String,
    /// 一轮心跳里同时拉取的源数上限
    ///
    /// 单心跳扫所有源，但**不是串行**：一次到点的多个源按这个上限并发拉，
    /// 一个慢源（全量快照、慢接口）不会把同拍的其它源一起压住。
    /// 1 等于退回原来的串行行为；调大要留意源库连接数与 `[syn.datasources.X] max-connections`。
    #[serde(default = "default_pull_concurrency")]
    pub pull_concurrency: u32,
    /// 取数心跳计划。**默认就注册**，不需要在配置里出现：
    /// 周期取数归 jobx 管（多副本下一轮只跑一次），缺省一套参数即可跑。
    /// 只有想改参数或显式关掉时才写 `[syn.pull-job]`，见 [`PullJobConfig`]。
    #[serde(default)]
    pub pull_job: PullJobConfig,
    /// 过期数据清理计划。同样**默认就注册**：`syn_idem` 与 `syn_delivery_log`
    /// 只增不减，不清理就会无限长。保留天数在这里配，见 [`CleanupJobConfig`]。
    #[serde(default)]
    pub cleanup_job: CleanupJobConfig,
}

/// # 取数心跳计划
///
/// **默认就有**，不需要写进配置：
///
/// | 项 | 默认值 |
/// |----|--------|
/// | `enabled` | `true` |
/// | `name` | `同步台取数心跳` |
/// | `executor-code` | `syn.pull` |
/// | `interval-duration` | `5s` |
/// | `group-name` | `同步台` |
/// | `task-expire-duration` | `1h` |
///
/// 一个计划扫**所有**启用的数据源，而不是一个数据抽取一个计划：抽取定义是控制台随时增删的
/// 配置，一个数据抽取一个计划就得在业务写库里同步调 jobx、失败还要补偿；而且数据抽取的
/// `interval-duration` 最小 1s，jobx 的计划粒度撑不住。所以这里只负责「隔一会儿打一拍」，
/// 「哪个源到点了」由 `poll::poll_due_sources` 判断。
///
/// 一拍里到点的多个源**并发拉**（上限 `[syn] pull-concurrency`，缺省 4），
/// 每个源还能用自己的 `spec.timeout_duration` 覆盖全局超时：慢源只拖慢自己，
/// 不会把同拍其它源排在自己后面。
///
/// 因此**实际精度 = max(interval-duration, 每个源的 interval-duration)**；计划是 5s 时，
/// 源配 1s 也只会 5s 拉一次。要更快就调小这里的间隔：jobx 完全支持 1s —— 低于
/// `high-freq-threshold`（默认 60s）的 FixedRate 计划会被判成高频，一次分派批成一段
/// 连续执行（`jobx_task` 一段一行、段长 `high-freq-assign-interval` 默认 5 分钟），
/// 段内按本间隔循环。代价是每一拍都要读一遍所有源的水位，1s × N 个源的空转查询不划算。
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

/// # 过期数据清理计划
///
/// **默认就有**，不需要写进配置：
///
/// | 项 | 默认值 |
/// |----|--------|
/// | `enabled` | `true` |
/// | `name` | `同步台过期数据清理` |
/// | `executor-code` | `syn.cleanup` |
/// | `interval-duration` | `24h` |
/// | `group-name` | `同步台` |
/// | `task-expire-duration` | `1h` |
/// | `retention-days` | `7` |
/// | `batch-size` | `5000` |
///
/// 一次执行删两张表里超过保留期的行：`syn_idem`（幂等台账）与
/// `syn_delivery_log`（失败/重试明细）。保留期按行的 `create_ms` 计算；
/// 删除按 `batch-size` 分批，避免首次执行一口气删掉大量历史数据。
///
/// **不要与 `[syn.pull-job]` 共用 `executor-code`**：一个执行器编码只能绑定一个处理器，
/// 共用了后注册的那个会覆盖前一个，取数心跳或清理会静默失效。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct CleanupJobConfig {
    /// 是否注册。默认开；显式 `enabled = false` 可关掉
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 计划名称。同名视为同一个计划，重复启动撞唯一键后只补分组
    #[serde(default = "default_cleanup_job_name")]
    pub name: String,
    /// 执行器编码。**必须与清理处理器一致**，且不能与取数心跳相同
    #[serde(default = "default_cleanup_job_executor")]
    pub executor_code: String,
    /// 清理周期。默认一天一次即可，清理量只跟写入量有关
    #[serde(default = "default_cleanup_job_interval")]
    pub interval_duration: String,
    /// jobx 计划分组名（不存在会自动创建）
    #[serde(default = "default_pull_job_group")]
    pub group_name: String,
    /// 清理任务的执行记录保留时长，避免 jobx_task 自己涨起来
    #[serde(default = "default_pull_job_expire")]
    pub task_expire_duration: String,
    /// 保留天数。超过它的幂等台账与投递明细会被删除；必须 ≥ 1
    #[serde(default = "default_retention_days")]
    pub retention_days: u32,
    /// 单条 DELETE 删除的行数上限。首次执行可能面对大量历史数据，
    /// 分批删避免长事务与大量锁等待；必须 ≥ 1
    #[serde(default = "default_cleanup_batch_size")]
    pub batch_size: u32,
    /// 备注，只在该计划首次创建时写入
    #[serde(default)]
    pub remark: Option<String>,
}

/// # 一个 DB 直写数据源
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct DataSourceConfig {
    /// 数据库引擎：`postgres` / `mysql` / `sqlite`；缺省按连接串 scheme 推断
    #[serde(default)]
    pub engine: Option<syn_api::DbEngine>,
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
            pull_concurrency: default_pull_concurrency(),
            pull_job: PullJobConfig::default(),
            cleanup_job: CleanupJobConfig::default(),
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

impl Default for CleanupJobConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            name: default_cleanup_job_name(),
            executor_code: default_cleanup_job_executor(),
            interval_duration: default_cleanup_job_interval(),
            group_name: default_pull_job_group(),
            task_expire_duration: default_pull_job_expire(),
            retention_days: default_retention_days(),
            batch_size: default_cleanup_batch_size(),
            remark: None,
        }
    }
}

impl SynConfig {
    /// 拉取超时
    pub fn pull_timeout(&self) -> Duration {
        humantime::parse_duration(&self.pull_timeout).unwrap_or(Duration::from_secs(30))
    }

    /// 一轮心跳的并发取数上限。钳在 `1..=64`：0 会让到点的源一个都不拉
    pub fn pull_concurrency(&self) -> usize {
        (self.pull_concurrency as usize).clamp(1, 64)
    }
}

/// 并发取数的缺省上限。4 是个保守值：够让慢源不挡住别人，又不会把源库连接打满
pub const DEFAULT_PULL_CONCURRENCY: u32 = 4;

fn default_pull_concurrency() -> u32 {
    DEFAULT_PULL_CONCURRENCY
}

fn default_pull_timeout() -> String {
    "30s".to_string()
}

fn default_pull_job_name() -> String {
    "同步台取数心跳".to_string()
}

fn default_pull_job_executor() -> String {
    "syn.pull".to_string()
}

fn default_pull_job_interval() -> String {
    // 5s 是省空转的折中，不是 jobx 撑不住：高频计划一次分派批成一段连续执行，
    // 段内按本间隔循环，`jobx_task` 一段一行（5 分钟一段），配 1s 一天也只多 288 行。
    // 每一拍都要读一遍所有源的水位（N 次查询），1s × N 个源的空转查询不划算；
    // 真要 1s 级取数，给那个源单独一条计划/执行器更合适。
    "5s".to_string()
}

fn default_pull_job_group() -> String {
    "同步台".to_string()
}

fn default_pull_job_expire() -> String {
    "1h".to_string()
}

fn default_cleanup_job_name() -> String {
    "同步台过期数据清理".to_string()
}

fn default_cleanup_job_executor() -> String {
    "syn.cleanup".to_string()
}

fn default_cleanup_job_interval() -> String {
    "24h".to_string()
}

fn default_retention_days() -> u32 {
    7
}

fn default_cleanup_batch_size() -> u32 {
    5000
}

fn default_true() -> bool {
    true
}
