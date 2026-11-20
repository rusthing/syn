//! # 取数心跳（jobx 计划任务）
//!
//! ## 一个计划，不是一源一计划
//!
//! 数据源是控制台随时增删的配置行，`interval-duration` 最小 1s。如果按数据抽取注册计划，
//! 每建一个源就要在写业务库的同时调一次 jobx，失败还得补偿；删源要反向停用；几十上百个源
//! 就是几十上百条计划，jobx 的计划表与扫描窗口都被无谓撑大。所以这里只注册**一个**
//! 「心跳」计划，handler 每次调用 `poll::poll_due_sources()` —— 读启用的源、看各自水位、
//! 到点的才拉。
//!
//! 一拍里到点的多个源是**并发**拉的（上限 `[syn] pull-concurrency`，缺省 4），
//! 每个源还能用 `spec.timeout_duration` 覆盖全局超时：一个慢源只占自己那份时间，
//! 不会把同拍的其它源排在它后面。
//!
//! ## 精度
//!
//! **实际精度 = max(计划 interval, 每个源的 interval)**。源配 1s、计划配 5s，就是 5s
//! 拉一次。
//!
//! jobx 本身**不限制** 1s：间隔小于 `high-freq-threshold`（默认 60s）的 FixedRate /
//! FixedDelay 计划会被判成高频，一次分派批成**一段**连续执行（`jobx_task` 一段一行，
//! 段长 `high-freq-assign-interval`，默认 5 分钟），执行器在段内按 `interval-duration`
//! 循环，段终点 `exec_deadline_ms = 预定开始 + 段长`，下一段正好接上。所以这里配 1s
//! 也能跑，`jobx_task` 一天只多 288 行。缺省用 5s 是省空转——每一拍都要读一遍所有源的
//! 水位（N 次查询），1s × N 个源的空转查询不划算；真要 1s 级取数，给那个源单独一条
//! 计划、单独一个 `executor-code` 更合适（一个执行器编码只能绑一个处理器，共用会让先
//! 注册的那个静默失效）。
//!
//! ## 分布式：同一段只在一个副本上跑
//!
//! 执行器用消费者组（`XREADGROUP ... ">"`，消费者名=实例 id）订阅 Stream，一条消息只投给
//! 组内**一个**消费者；`take` 成功即 ACK，配合 `jobx_task` 的
//! `unique (job_id, scheduled_exec_start_ms)` 与 take/recalc 同事务，多个 jobx-svr 副本
//! 重复发布同一计划也不会重复执行。所以同一段心跳只会落在一个 syn 副本上。
//!
//! syn 侧自己的保护只有两层：进程内 `IN_FLIGHT`（跨副本无效）和游标推进的
//! `update_ms` 乐观锁（只保证水位不回退，**不阻止**另一个副本先把行投出去）。跨副本
//! 重叠只可能来自「两条计划落到了不同副本」（例如改名前的旧计划没停用）、段交界处
//! 上一段最后一个拍子跑过 `exec_deadline_ms`、以及手工 `POST /pull` 打到另一个副本——
//! 这几种情况下重复行靠**下游 upsert** 吸收，pull 路径不带 `X-Idempotency-Key`，
//! `syn_idem` 帮不上忙。
//!
//! **不需要再加一层分布式锁**：正常路径已经由 jobx 的消费者组保证「一段只在一个副本」，
//! 剩下的窗口要么是配置错误（旧计划，启动时自动停用），要么是窄到一次拍子尾巴、
//! 会被源自己的 `last_run_ms` 跳过的重拍。为这点重叠把 Redis 塞进取数路径，换来的是
//! 一个新的故障面（锁 TTL 与源超时打架、Redis 抖动直接挡住取数），不划算。
//!
//! 这套结论依赖两个前提，配置时别改：执行器 `noack = false`、`last_only = false`，
//! 且**一个 `executor-code` 只注册一条计划**。
//!
//! ## 计划名与分组名
//!
//! 缺省是 `同步台取数心跳` / 分组 `同步台`（历史版本叫 `syn 取数心跳` / 分组 `syn`）。
//! 执行器编码仍是 `syn.pull`：它是 jobx 侧 Stream 的路由键，改它等于让**所有**旧计划
//! 分派到没人订阅的 Stream，比改名更糟。旧名字的计划在启动时会被**自动停用**（只改
//! `enabled`，计划和历史都留着），避免新旧两条计划打同一拍。
//!
//! ## 注册是幂等的
//!
//! 首次启动 `job.add`，撞唯一键（重复启动/换副本）时按名字回查并补齐分组，不报错。
//! 这与 dtw 的 `setup_region_alarm_wkr`、alarm 的补发任务是同一套写法。
//!
//! ## 注册失败不拖死整个服务
//!
//! 取数心跳是**默认可用的能力**，不需要配置就注册（见 `PullJobConfig` 的默认值）。
//! 但它依赖集群里的 jobx 与 Redis，本地单机、联调环境没有这两样：
//!
//! - **缺 `[api.jobx]` / `[redis]`**：只 `warn!` 一条并跳过 —— 环境里没有调度器，
//!   不是配置写错，更不该让服务起不来；
//! - **jobx 不可达**：`error!` 一条然后继续跑 —— sink 推送才是主链路，让它因为调度器
//!   没起而整体不可用，等于把 jobx 的可用性变成 syn 的启动前提。
//!
//! 两种情况下都不会自动取数（`POST /syn/source/{id}/pull` 仍可手工或由其它调度打），
//! 日志里各留了明确一行。

use async_trait::async_trait;
use jobx_api::vo::JobxTaskVo;
use jobx_api_client::{get_jobx_api_client, setup_jobx_api_client};
use jobx_wkr::{
    ensure_existing_job_group, ensure_job_group, init_jobx_executor, set_jobx_executor_config,
    JobxExecutorConfig, JobxJobConfig, JobxTaskHandler,
};
use robotech::api::RO_CODE_WARNING_DUPLICATE_KEY;
use robotech::cst::user_id_cst::SYS_OPERATOR_USER_ID;
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
    if !cfg.enabled {
        info!("[syn.pull-job] enabled=false，不注册取数心跳（手工 pull 仍可用）");
        return Ok(());
    }
    // 环境里没有 jobx（本地单机 / 联调）不是配置写错：跳过即可
    if !apis.contains_key("jobx") {
        warn!(
            "没有 [api.jobx] 客户端配置，跳过取数心跳注册：sink 推送不受影响，\
             自动取数需手工 POST /syn/source/{{id}}/pull"
        );
        return Ok(());
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
    } else {
        // 改名后 jobx 里可能还留着旧的同名同周期计划，直接停用，避免两条计划打同一拍
        retire_legacy_jobs().await;
    }
    Ok(())
}

/// 改名前的计划名。启动时若发现仍启用，直接停用（只改 enabled，计划和历史都保留）
const LEGACY_JOB_NAMES: [&str; 2] = ["syn 取数心跳", "syn 过期数据清理"];

/// # 停用改名前的旧计划
///
/// 计划名从「syn …」改成「同步台…」后，jobx 里那条旧计划仍然是**启用**的：它照样按周期
/// 分派，和新计划打同一拍。同一个执行器的消息走消费者组、一条只投给一个副本，正常情况下
/// 不会双跑；但两条计划完全可能落在**不同副本**上 —— 那时 syn 只有「游标 CAS + 下游 upsert」
/// 兜底，下游会收到重复行。所以这里把旧的直接停用。
///
/// 用 `modify` 只改 `enabled`，其余字段一个不动：计划、分组、执行历史都还在控制台里，
/// 只是不再分派；要恢复也只是点一下启用。
async fn retire_legacy_jobs() {
    let Ok(client) = get_jobx_api_client() else {
        return;
    };
    for name in LEGACY_JOB_NAMES {
        let query = jobx_api::dto::JobxJobQueryDto {
            name: Some(name.to_string()),
            ..Default::default()
        };
        match client
            .job
            .get_by_query_dto(&query, SYS_OPERATOR_USER_ID)
            .await
        {
            Ok(ro) if ro.is_ok() => {
                let Some(job) = ro.extra else { continue };
                if !job.enabled {
                    continue;
                }
                let dto = jobx_api::dto::JobxJobModifyDto {
                    id: Some(job.id),
                    enabled: Some(false),
                    _current_user_id: SYS_OPERATOR_USER_ID.into(),
                    ..Default::default()
                };
                match client.job.modify(&dto).await {
                    Ok(ro) if ro.is_ok() => info!(
                        "已停用改名前的旧计划「{name}」(id={})，避免与「同步台…」计划重复分派",
                        job.id
                    ),
                    Ok(ro) => warn!("停用旧计划「{name}」(id={}) 失败: {ro:?}", job.id),
                    Err(e) => warn!("停用旧计划「{name}」(id={}) 失败: {e:?}", job.id),
                }
            }
            // 「没查到」在 jobx 里用非 0 code 表达，不是错误：旧计划已经清干净了
            Ok(_) => {}
            Err(e) => warn!("检查旧计划「{name}」是否残留失败（不影响取数）：{e:?}"),
        }
    }
}

/// 起执行器 + 建分组 + 注册计划。容忍「已存在」，其余一律返回错误由调用方降级
async fn register(
    cfg: &PullJobConfig,
    exec: JobxExecutorConfig,
    job: JobxJobConfig,
) -> anyhow::Result<()> {
    init_jobx_executor(exec, Arc::new(PullTickHandler)).await?;

    let group_id = ensure_job_group(&cfg.group_name, Some("同步台通用同步服务的周期任务")).await?;
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
