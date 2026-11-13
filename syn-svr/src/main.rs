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
use robotech::web::setup_web_server;
use std::collections::HashMap;
use std::sync::Arc;
use syn_svr::config::{AppConfig, setup_app_config};
use syn_svr::{poll, store};

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

    // 预加载失败不阻止启动：库刚建好时表是空的，也可能正在导配置。
    // 服务起来后调一次 `/syn/task/reload` 即可，这比让容器起不来好排查。
    if app_config.syn.load_on_start {
        match store::reload().await {
            Ok(n) => tracing::info!("启动加载任务 {n} 个"),
            Err(e) => tracing::warn!("启动加载任务失败，服务继续运行，可调 /syn/task/reload: {e}"),
        }
    } else {
        tracing::warn!("[syn] load-on-start=false，启动时未加载任务");
    }

    setup_web_server(app_config.web.clone(), port, old_pid, changed).await?;

    // 后台任务只在首次启动时挂：配置热更新会再走一遍 setup，重复 spawn 会变成
    // 两个巡检 / 两套调度器同时推进同一个游标。
    if changed.is_none() {
        store::spawn_watcher(app_config.syn.reload_interval());
        // 生产由 jobx 打 pull 端点，这里默认不启；配置里显式打开才跑进程内调度
        if app_config.syn.self_schedule {
            poll::spawn_scheduler();
        }
    }
    Ok(())
}
