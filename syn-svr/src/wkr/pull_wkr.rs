//! # 取数心跳（jobx 计划任务）
//!
//! ## 一个计划，不是一源一计划
//!
//! 数据源是控制台随时增删的配置行，`interval-duration` 最小 1s。如果按来源注册计划，
//! 每建一个源就要在写业务库的同时调一次 jobx，失败还得补偿；删源要反向停用；jobx
//! 的计划粒度也撑不住 1s。所以这里只注册**一个**「心跳」计划，handler 每次调用
//! `poll::poll_due_sources()` —— 读启用的源、看各自水位、到点的才拉。
//!
//! 代价是精度：实际间隔 = `max(计划间隔, 源的 interval-duration)`。源配 1s、计划配 5s，
//! 就是 5s 一次。想要更快就调小计划间隔，但必须同时配 `task-expire-duration`。注意
//! `jobx_task` 是**批次**不是「每拍一行」：5s 间隔下每 5 分钟一条、内部跑 60 拍。
//!
//! ## 注册是幂等的
//!
//! 首次启动 `job.add`，撞唯一键（重复启动/换副本）时按名字回查并补齐分组，不报错。
//! 这与 dtw 的 `setup_region_alarm_wkr`、alarm 的补发任务是同一套写法。
//!
//! ## 注册失败不拖死整个服务
//!
//! `[syn.pull-job]` 的**配置错误**（缺 `[api.jobx]` / 缺 `[redis]` / 间隔不合法）在启动时
//! 直接失败 —— 那是写错了，越早发现越好。
//!
//! 但 **jobx 不可达**只 `error!` 一条然后继续跑：sink 推送才是主链路，让它因为调度器
//! 没起而整体不可用，等于把 jobx 的可用性变成 syn 的启动前提。代价是这种情况下不会有
//! 自动取数（`POST /syn/source/{id}/pull` 仍可手工或由其它调度打），日志里留了明确一行。

use async_trait::async_trait;
use jobx_api::vo::JobxTaskVo;
use jobx_api_client::{get_jobx_api_client, setup_jobx_api_client};
use jobx_wkr::{
    ensure_existing_job_group, ensure_job_group, init_jobx_executor, set_jobx_executor_config,
    JobxExecutorConfig, JobxJobConfig, JobxTaskHandler,
};
use robotech::api::RO_CODE_WARNING_DUPLICATE_KEY;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

use crate::config::PullJobConfig;
use crate::poll;

/// 心跳任务的执行器
///
/// 任务不带参数：哪些源到点了是 syn 自己的业务判断，不是调度参数。
/// 把「源 id」塞进 params 就退化成「一源一计划」，正是这里要避免的。
struct PullTickHandler;

#[async_trait]
impl JobxTaskHandler for PullTickHandler {
    async fn handle(&self, _task: &JobxTaskVo) -> anyhow::Result<String> {
        let (scanned, pulled) = poll::poll_due_sources().await;
        // 结果串会落进 jobx_task.result，排障时能直接看到「这拍扫了几个源、拉了几个」
        Ok(format!("扫描 {scanned} 个源，拉取 {pulled} 个"))
    }
}

/// # 注册取数心跳计划（启动时调用）
///
/// - `changed` 为 `None`：首次加载，起执行器 + 注册计划；
/// - `changed` 为 `Some`：热更新，执行器已在跑，只换配置（重复 `init` 会重复订阅 Stream）。
///
/// 调用前必须先 `setup_jobx_api_client`，否则拿不到客户端。
pub async fn setup_pull_wkr(
    cfg: &PullJobConfig,
    apis: &HashMap<String, robotech::api_client::ApiClientConfig>,
    changed: &Option<HashMap<String, config::Value>>,
) -> anyhow::Result<()> {
    // jobx 客户端是注册计划的前提；没配 `[api.jobx]` 时这里就报错，而不是等到注册时
    if !apis.contains_key("jobx") {
        anyhow::bail!(
            "配了 [syn.pull-job] 但缺少 [api.jobx]：无法注册取数计划任务，\
             要么补上 jobx 客户端配置，要么删掉 [syn.pull-job] 改用 self-schedule（仅单副本）"
        );
    }
    // 配置本身的问题（间隔、保留时长写错）在连 jobx 之前就查出来，别等到对方返回才暴露
    let exec = executor_config(cfg)?;
    let job = job_config(cfg)?;

    if changed.is_some() {
        set_jobx_executor_config(exec);
        info!("取数心跳任务的执行器配置已更新: executor={}", cfg.executor_code);
        return Ok(());
    }

    setup_jobx_api_client(apis.clone(), changed).await?;

    // 从这一步开始都是「对端/中间件」的问题：jobx 没起、Redis 连不上、分组建不了。
    // 记一条 error 就继续 —— sink 推送不依赖调度器，不该被它拖死。
    if let Err(e) = register(cfg, exec, job).await {
        error!(
            "取数心跳未注册，本次启动不启用自动取数（sink 推送不受影响，\
             `POST /syn/source/{{id}}/pull` 仍可手工触发）：{e:#}"
        );
    }
    Ok(())
}

/// 起执行器 + 建分组 + 注册计划。容忍「已存在」，其余一律返回错误由调用方降级
async fn register(
    cfg: &PullJobConfig,
    exec: JobxExecutorConfig,
    job: JobxJobConfig,
) -> anyhow::Result<()> {
    init_jobx_executor(exec, Arc::new(PullTickHandler)).await?;

    let group_id = ensure_job_group(&cfg.group_name, Some("syn 通用同步服务的周期任务")).await?;
    let client = get_jobx_api_client()?;
    let mut add_dto: jobx_api::dto::JobxJobAddDto = job.into();
    add_dto.group_id = Some(Some(robotech::api::U64::from(group_id)));

    match client.job.add(&add_dto).await {
        Ok(ro) if ro.is_ok() => info!(
            "取数心跳计划已注册: name={}, executor={}, interval={}, group={}",
            cfg.name, cfg.executor_code, cfg.interval_duration, cfg.group_name
        ),
        Ok(ro) if ro.is_warn_code(RO_CODE_WARNING_DUPLICATE_KEY) => {
            ensure_existing_job_group(&cfg.name, group_id).await?;
            info!(
                "取数心跳计划已存在，分组已确认: name={}, group={}",
                cfg.name, cfg.group_name
            );
        }
        Ok(ro) => anyhow::bail!("jobx 拒绝了计划: {ro:?}"),
        Err(e) => anyhow::bail!("调用 jobx 失败: {e:?}"),
    }

    Ok(())
}

/// 执行器配置。`executor_key` 等走 jobx-wkr 的默认值，与 jobx-svr 服务端保持一致
fn executor_config(cfg: &PullJobConfig) -> anyhow::Result<JobxExecutorConfig> {
    if cfg.executor_code.trim().is_empty() {
        anyhow::bail!("[syn.pull-job] executor-code 不能为空");
    }
    Ok(JobxExecutorConfig::builder()
        .executor_code(cfg.executor_code.clone())
        .build())
}

/// 计划配置。间隔与保留时长都用 humantime 串，与 syn 其它配置一致
fn job_config(cfg: &PullJobConfig) -> anyhow::Result<JobxJobConfig> {
    let interval = humantime::parse_duration(&cfg.interval_duration)
        .map_err(|e| anyhow::anyhow!("[syn.pull-job] interval-duration 不合法: {e}"))?;
    if interval < Duration::from_secs(1) {
        anyhow::bail!("[syn.pull-job] interval-duration 不能小于 1s");
    }
    let expire = humantime::parse_duration(&cfg.task_expire_duration)
        .map_err(|e| anyhow::anyhow!("[syn.pull-job] task-expire-duration 不合法: {e}"))?;
    if expire <= interval {
        // 保留时长比周期还短，任务刚建完就被清理，执行历史全丢
        warn!(
            "[syn.pull-job] task-expire-duration({}) 不大于 interval({})，执行历史会被很快清理",
            cfg.task_expire_duration, cfg.interval_duration
        );
    }

    Ok(JobxJobConfig::builder()
        .name(cfg.name.clone())
        .executor_code(cfg.executor_code.clone())
        .interval_duration(Some(interval))
        .task_expire_duration(Some(expire))
        // 默认提前 60s 分派：对 5s 的心跳等于每一拍都被提前塞进 Stream，
        // 白白多出一倍消息。心跳只要「现在执行一次」，不需要预热。
        .assign_lead_ms(Some(0))
        .remark(cfg.remark.clone())
        .build())
}
