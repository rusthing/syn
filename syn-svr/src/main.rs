//! # syn 执行器入口
//!
//! 顺序是固定的：**迁移 → 配置 → ID → 连接 → 快照 → web → 后台任务**。
//! 迁移必须在连接之前（迁移脚本自己连库），ID 生成器必须在任何写库之前
//! （`#[dao]::insert` 会调 `idworker::next_id()`，没初始化就报错）。

use anyhow::anyhow;
use config::Value;
use robotech::app::setup_id_worker;
use robotech::db::setup_db_conn;
use robotech::macros::{bootstrap, db_migrate, log_call};
use robotech::mq::nats::setup_nats_client;
use robotech::redis::setup_redis_conn;
use robotech::web::setup_web_server;
use std::collections::HashMap;
use std::sync::Arc;
use syn_svr::config::{AppConfig, setup_app_config};
use syn_svr::{db_sink, store, wkr};

bootstrap!(AppConfig);

#[log_call]
async fn setup(
    app_config: &Arc<AppConfig>,
    changed: &Option<HashMap<String, Value>>,
    port: Option<u16>,
    old_pid: Option<u32>,
) -> Result<(), anyhow::Error> {
    let db_url = app_config.db.get_url();
    db_migrate!(db_url);

    setup_app_config(app_config.as_ref().clone(), changed);
    setup_id_worker(app_config.id_worker.clone(), changed).await?;
    setup_db_conn(app_config.db.clone(), changed).await?;

    // 刷新信号走 NATS：没配就退化成「只有写的那台重载」，单副本够用
    match app_config.nats.clone() {
        Some(nats) => setup_nats_client(nats, changed).await?,
        None => tracing::warn!("没有 [nats] 配置，任务刷新信号不可用（多副本需配）"),
    }

    // 数据源变更广播：控制台改连接串后各副本释放旧连接池，
    // 否则 3 个副本会各连各的旧库，现象是「改了连接串有的副本还在写旧库」。
    if let Err(e) = db_sink::setup_datasource_refresh().await {
        tracing::warn!("数据源刷新订阅未建立，改数据源后需重启生效: {e}");
    }

    // 预加载失败不阻止启动：库刚建好时表是空的，也可能正在导配置。
    // 服务起来后调一次 `/syn/task/reload` 即可，这比让容器起不来好排查。
    if app_config.syn.load_on_start {
        // 先订阅刷新信号再首次加载：顺序反了会漏掉「加载到订阅建立之间」的写入
        if let Err(e) = store::setup().await {
            tracing::warn!("启动加载任务失败，服务继续运行，可调 /syn/task/reload: {e}");
        }
    } else {
        tracing::warn!("[syn] load-on-start=false，启动时未加载任务");
    }

    setup_web_server(app_config.web.clone(), port, old_pid, changed).await?;

    // 取数心跳默认就注册，不需要配置；缺 jobx/redis 的环境里自动跳过。
    // 注册需要 Redis（jobx 执行器订阅 Stream）与 jobx 客户端，两者都在这里就绪。
    // 热更新只换执行器配置，不重复订阅 Stream、不重复注册计划。
    match app_config.redis.clone() {
        Some(redis) => setup_redis_conn(redis, changed).await?,
        None => tracing::warn!(
            "没有 [redis] 配置，跳过取数心跳：jobx 执行器从 Redis Stream 收任务，\
             没有 Redis 就收不到；sink 推送与手工 pull 不受影响"
        ),
    }
    if app_config.redis.is_some() {
        wkr::setup_pull_wkr(&app_config.syn.pull_job, &app_config.api, changed).await?;
    }
    Ok(())
}
