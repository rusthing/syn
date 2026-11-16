//! # 过期数据清理（jobx 计划任务）
//!
//! `syn_idem` 与 `syn_delivery_log` 都只增不减：前者每条成功/跳过的记录一行，
//! 后者每条失败/重试一行。不清理的话，两张表会跟着业务量线性长。
//!
//! 与取数心跳同一套注册方式（[`crate::wkr::pull_wkr`]）：
//!
//! - 只注册**一个**计划，handler 每次调用 `SynRetentionSvc::cleanup`；
//! - 注册是幂等的：`job.add` 撞唯一键就按名字回查并补齐分组；
//! - 缺 `[api.jobx]` / `[redis]` 时只 `warn!` 跳过，不让服务起不来；
//! - 热更新只换执行器配置，不重复订阅 Stream、不重复注册计划。
//!
//! 保留天数来自 `[syn.cleanup-job] retention-days`（默认 7 天），热更新时
//! 一并刷新到进程内的 `RETENTION_DAYS`，下一次执行就按新值清理。

use async_trait::async_trait;
use jobx_api::vo::JobxTaskVo;
use jobx_api_client::{get_jobx_api_client, setup_jobx_api_client};
use jobx_wkr::{
    ensure_existing_job_group, ensure_job_group, init_jobx_executor, set_jobx_executor_config,
    JobxExecutorConfig, JobxJobConfig, JobxTaskHandler,
};
use robotech::api::RO_CODE_WARNING_DUPLICATE_KEY;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

use crate::config::CleanupJobConfig;
use crate::svc::SynRetentionSvc;

/// 当前生效的保留天数。注册时写入，热更新时覆盖，handler 每次执行读一次
static RETENTION_DAYS: AtomicU32 = AtomicU32::new(7);

/// 单条 DELETE 最多删多少行。首次清理可能面对大量历史数据，分批删避免长事务
static BATCH_SIZE: AtomicU32 = AtomicU32::new(5000);

struct CleanupHandler;

#[async_trait]
impl JobxTaskHandler for CleanupHandler {
    async fn handle(&self, _task: &JobxTaskVo) -> anyhow::Result<String> {
        let days = RETENTION_DAYS.load(Ordering::Relaxed);
        let batch = BATCH_SIZE.load(Ordering::Relaxed);
        let (idem, delivery) = SynRetentionSvc::cleanup(days, batch).await?;
        Ok(format!(
            "保留 {days} 天，每批 {batch} 条，清理幂等台账 {idem} 条、投递明细 {delivery} 条"
        ))
    }
}

/// # 注册过期数据清理计划（启动时调用）
///
/// `changed` 为 `None` 时起执行器 + 注册计划；`Some` 时只换执行器配置、保留天数与批大小。
pub async fn setup_cleanup_wkr(
    cfg: &CleanupJobConfig,
    apis: &HashMap<String, robotech::api_client::ApiClientConfig>,
    changed: &Option<HashMap<String, config::Value>>,
) -> anyhow::Result<()> {
    if !cfg.enabled {
        info!("[syn.cleanup-job] enabled=false，不注册过期数据清理");
        return Ok(());
    }
    if !apis.contains_key("jobx") {
        warn!(
            "没有 [api.jobx] 客户端配置，跳过过期数据清理注册：\
             syn_idem / syn_delivery_log 需要手工清理"
        );
        return Ok(());
    }
    // 配置本身的问题在连 jobx 之前就查出来
    let exec = executor_config(cfg)?;
    let job = job_config(cfg)?;

    // 保留天数与批大小热更新也要立刻生效：先写入，再决定要不要重新注册
    RETENTION_DAYS.store(cfg.retention_days, Ordering::Relaxed);
    BATCH_SIZE.store(cfg.batch_size, Ordering::Relaxed);

    if changed.is_some() {
        set_jobx_executor_config(exec);
        info!(
            "过期数据清理任务的执行器配置已更新: executor={}, retention-days={}, batch-size={}",
            cfg.executor_code, cfg.retention_days, cfg.batch_size
        );
        return Ok(());
    }

    setup_jobx_api_client(apis.clone(), changed).await?;

    if let Err(e) = register(cfg, exec, job).await {
        error!("过期数据清理未注册，syn_idem / syn_delivery_log 本次启动不自动清理：{e:#}");
    }
    Ok(())
}

/// 起执行器 + 建分组 + 注册计划，容忍「已存在」
async fn register(
    cfg: &CleanupJobConfig,
    exec: JobxExecutorConfig,
    job: JobxJobConfig,
) -> anyhow::Result<()> {
    init_jobx_executor(exec, Arc::new(CleanupHandler)).await?;

    let group_id = ensure_job_group(&cfg.group_name, Some("syn 通用同步服务的周期任务")).await?;
    let client = get_jobx_api_client()?;
    let mut add_dto: jobx_api::dto::JobxJobAddDto = job.into();
    add_dto.group_id = Some(Some(robotech::api::U64::from(group_id)));

    match client.job.add(&add_dto).await {
        Ok(ro) if ro.is_ok() => info!(
            "过期数据清理计划已注册: name={}, executor={}, interval={}, retention-days={}, batch-size={}",
            cfg.name, cfg.executor_code, cfg.interval_duration, cfg.retention_days, cfg.batch_size
        ),
        Ok(ro) if ro.is_warn_code(RO_CODE_WARNING_DUPLICATE_KEY) => {
            ensure_existing_job_group(&cfg.name, group_id).await?;
            info!(
                "过期数据清理计划已存在，分组已确认: name={}, group={}",
                cfg.name, cfg.group_name
            );
        }
        Ok(ro) => anyhow::bail!("jobx 拒绝了计划: {ro:?}"),
        Err(e) => anyhow::bail!("调用 jobx 失败: {e:?}"),
    }

    Ok(())
}

fn executor_config(cfg: &CleanupJobConfig) -> anyhow::Result<JobxExecutorConfig> {
    if cfg.executor_code.trim().is_empty() {
        anyhow::bail!("[syn.cleanup-job] executor-code 不能为空");
    }
    Ok(JobxExecutorConfig::builder()
        .executor_code(cfg.executor_code.clone())
        .build())
}

fn job_config(cfg: &CleanupJobConfig) -> anyhow::Result<JobxJobConfig> {
    // 0 天会把「刚刚写入」的数据也删掉，属于误操作，不是清理
    if cfg.retention_days == 0 {
        anyhow::bail!("[syn.cleanup-job] retention-days 必须 ≥ 1");
    }
    if cfg.batch_size == 0 {
        anyhow::bail!("[syn.cleanup-job] batch-size 必须 ≥ 1");
    }

    let interval = humantime::parse_duration(&cfg.interval_duration)
        .map_err(|e| anyhow::anyhow!("[syn.cleanup-job] interval-duration 不合法: {e}"))?;
    if interval < Duration::from_secs(60) {
        anyhow::bail!("[syn.cleanup-job] interval-duration 不能小于 1m");
    }
    let expire = humantime::parse_duration(&cfg.task_expire_duration)
        .map_err(|e| anyhow::anyhow!("[syn.cleanup-job] task-expire-duration 不合法: {e}"))?;
    if expire <= interval {
        // 保留时长比周期还短，任务刚建完就被清理，执行历史全丢
        warn!(
            "[syn.cleanup-job] task-expire-duration({}) 不大于 interval({})，执行历史会被很快清理",
            cfg.task_expire_duration, cfg.interval_duration
        );
    }

    Ok(JobxJobConfig::builder()
        .name(cfg.name.clone())
        .executor_code(cfg.executor_code.clone())
        .interval_duration(Some(interval))
        .task_expire_duration(Some(expire))
        // 清理只要「现在执行一次」，不需要提前分派预热
        .assign_lead_ms(Some(0))
        .remark(cfg.remark.clone())
        .build())
}
