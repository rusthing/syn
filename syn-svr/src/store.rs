//! # 任务快照
//!
//! 配置读进内存后**只读**，按 `topic` 建索引、按 `priority` 排序，匹配时线性扫一个小列表。
//! 一个 topic 下通常只有个位数任务，线性扫比建 map 更快也更简单。
//!
//! ## 为什么列为准
//!
//! `topic` / `priority` / `enabled` / `exclusive` 既是列、也在 `spec` 里。加载时以
//! **列**为准，`spec` 里的同名字段被覆盖并记一条 warn —— 两份数据不一致时，行为不能
//! 取决于读取顺序。写入口（`SynTaskSvc`）保证两者一致，这里只是兜底。
//!
//! `syn_task.id` 是 idworker 生成的 INT8 主键，对外指代任务用 `code`
//! （`TaskSpec::id` 装的就是 `code`）：日志、配置、排障都不该出现一个雪花 ID。
//!
//! ## 为什么有巡检
//!
//! 重载接口只打到其中一台副本。多副本部署时，「保存后别的副本还在跑旧规则」是最难
//! 发现的问题（现象是「有时候生效有时候不生效」）。所以进程里另有一个巡检：每隔
//! `syn.reload-duration` 比对一次 `(条数, 最大 update_ms)`，变了就重载。
//!
//! 这是**每副本的本地缓存**，按约定归进程内 `tokio::spawn`，不占 jobx 的计划任务。

use arc_swap::ArcSwap;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use syn_api::TaskSpec;
use tracing::{info, warn};

use crate::dao::SynTaskDao;
use crate::mo::syn_task::Model as TaskModel;
use robotech::db::get_db_conn;

static SNAPSHOT: LazyLock<ArcSwap<Vec<TaskSpec>>> =
    LazyLock::new(|| ArcSwap::from_pointee(Vec::new()));
/// 上次加载时的 `(任务条数, 最大 update_ms)`，用于巡检时判断有没有变
static STAMP: LazyLock<ArcSwap<(i64, i64)>> = LazyLock::new(|| ArcSwap::from_pointee((0, 0)));

/// # 重新加载快照
///
/// 返回生效的任务数。单条配置非法**只跳过该条**并告警，不让整份快照失败：
/// 一个坏任务不能停掉整条链路。
pub async fn reload() -> anyhow::Result<usize> {
    let db = get_db_conn()?;
    let rows = SynTaskDao::list_by_condition::<_, TaskModel>(
        sea_orm::Condition::all(),
        &Some("priority:asc,id:asc".to_string()),
        db.as_ref(),
    )
    .await?;

    let mut tasks = Vec::with_capacity(rows.len());
    for row in rows {
        let code = row.code.clone();
        let mut task: TaskSpec = match serde_json::from_value(row.spec.clone()) {
            Ok(t) => t,
            Err(e) => {
                warn!("任务 {code} 配置反序列化失败，已跳过: {e}");
                continue;
            }
        };
        if task.id != row.code
            || task.topic != row.topic
            || task.priority != row.priority
            || task.enabled != row.enabled
            || task.exclusive != row.exclusive
        {
            warn!(
                "任务 {code} 的 spec 与列不一致（spec: {}/{}/{}/{}/{}，列: {}/{}/{}/{}/{}），以列为准",
                task.id,
                task.topic,
                task.priority,
                task.enabled,
                task.exclusive,
                row.code,
                row.topic,
                row.priority,
                row.enabled,
                row.exclusive
            );
            task.id = row.code;
            task.topic = row.topic;
            task.priority = row.priority;
            task.enabled = row.enabled;
            task.exclusive = row.exclusive;
        }
        if let Err(issues) = task.validate() {
            let detail = issues
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join("; ");
            warn!("任务 {code} 配置不合法，已跳过: {detail}");
            continue;
        }
        tasks.push(task);
    }

    let count = tasks.len();
    SNAPSHOT.store(Arc::new(tasks));
    // 记下这一刻的戳，巡检才不会因为「自己刚加载过」又触发一次
    if let Ok(stamp) = stamp().await {
        STAMP.store(Arc::new(stamp));
    }
    info!("syn 快照已加载，共 {count} 个任务");
    Ok(count)
}

/// # 当前快照
pub fn snapshot() -> Arc<Vec<TaskSpec>> {
    SNAPSHOT.load_full()
}

/// # 启动快照巡检
///
/// 每轮只查一行（`count` + `max(update_ms)`），代价可以忽略。查库失败只告警：
/// 库短暂不可用不该让进程退出，下一轮会自己恢复。
pub fn spawn_watcher(interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // 第一拍立刻到来，跳过：启动时已经加载过
        ticker.tick().await;
        loop {
            ticker.tick().await;
            match stamp().await {
                Ok(now) => {
                    let last = *STAMP.load().as_ref();
                    if now != last && now.0 > 0 {
                        info!(
                            "检测到任务配置变化（{} → {} 条，update_ms {} → {}），重载快照",
                            last.0, now.0, last.1, now.1
                        );
                        if let Err(e) = reload().await {
                            warn!("快照重载失败，继续用旧快照: {e}");
                        }
                    }
                }
                Err(e) => warn!("快照巡检查库失败，下一轮重试: {e}"),
            }
        }
    });
    info!("快照巡检已启动，间隔 {:?}", interval);
}

/// # 配置指纹
///
/// 用「条数 + 最大更新时间」而不是逐行比对：删除会让条数变小，增改会让最大时间变大，
/// 两个数一起足够区分，代价是**一次查询**。
async fn stamp() -> anyhow::Result<(i64, i64)> {
    let db = get_db_conn()?;
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        "select count(*) as n, coalesce(max(update_ms), 0) as m from syn_task".to_string(),
    );
    let row = db
        .query_one_raw(stmt)
        .await?
        .ok_or_else(|| anyhow::anyhow!("syn_task 指纹查询没有返回行"))?;
    let n: i64 = row.try_get("", "n")?;
    let m: i64 = row.try_get("", "m")?;
    Ok((n, m))
}
