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
//! ## 为什么用刷新信号，不再轮询
//!
//! 重载接口只打到其中一台副本，多副本部署时「保存后别的副本还在跑旧规则」是最难
//! 发现的问题（现象是「有时候生效有时候不生效」）。
//!
//! 早期做法是每 10s 比对一次 `(条数, 最大 update_ms)`，变了就重载 —— 那是自造机制：
//! 框架本来就有刷新信号（`refresh.{服务}.{对象}`，JetStream 持久化广播），
//! 写库成功后发一条，**所有**副本（含发布者自己）收到后各自全量重建。
//!
//! 于是这里的约定是：
//! - 写入口（`SynTaskSvc`）提交事务后调 [`on_task_changed`] 发信号，自己不顺手重载；
//! - 启动时 [`setup`] 先订阅再首次加载 —— 顺序反了的话，加载到订阅建立之间的写入
//!   没人听，本副本会停在旧快照上，直到下一次变更；
//! - 信号允许丢（订阅断了、NATS 重启）：重建都是全量查库，事后抖一下就会收敛。
//!
//! 没有 `[nats]` 配置（本地单机、联调）时退化为「只有本进程重载」，
//! 见 [`setup`] 的返回值说明。
//!
//! 这是**每副本的本地缓存**，按约定归进程内 `tokio::spawn`，不占 jobx 的计划任务。

use arc_swap::ArcSwap;
use std::sync::{Arc, LazyLock};
use syn_api::TaskSpec;
use tracing::{error, info, warn};

use crate::dao::SynTaskDao;
use crate::mo::syn_task::Model as TaskModel;
use robotech::db::get_db_conn;
use robotech::refresh::RefreshSubject;

/// 任务配置的刷新主题。写库后发布，各副本收到就重建快照
pub const SYN_TASK_REFRESH_SUBJECT: RefreshSubject = robotech::refresh_subject!("syn", "task");

static SNAPSHOT: LazyLock<ArcSwap<Vec<TaskSpec>>> =
    LazyLock::new(|| ArcSwap::from_pointee(Vec::new()));

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
    info!("syn 快照已加载，共 {count} 个任务");
    Ok(count)
}

/// # 当前快照
pub fn snapshot() -> Arc<Vec<TaskSpec>> {
    SNAPSHOT.load_full()
}

/// # 启动快照：订阅刷新信号 + 首次加载
///
/// 先订阅再加载：反过来的话，加载到订阅建立之间的写操作会发出一条没人听的信号，
/// 本副本就停在旧快照上，直到下一次变更。
///
/// 没有 `[nats]` 配置时只做首次加载并返回 `false` —— 单副本本地开发/联调用不着广播，
/// 多副本部署必须配 nats，否则「别人改了配置我这边不生效」。
pub async fn setup() -> anyhow::Result<bool> {
    let mut subscribed = false;
    match robotech::refresh::subscribe(&SYN_TASK_REFRESH_SUBJECT, || async {
        match reload().await {
            Ok(n) => info!("收到任务刷新信号，快照重建完成：{n} 个任务"),
            Err(e) => error!("收到任务刷新信号但重建失败，继续用旧快照: {e}"),
        }
        Ok(())
    })
    .await
    {
        Ok(_) => {
            subscribed = true;
            info!("任务快照刷新订阅已建立: {SYN_TASK_REFRESH_SUBJECT}");
        }
        // 订阅建不起来不影响正确性（本副本仍会在写入口和重载接口上重建），
        // 但多副本下会退化成「只有写的那台生效」，必须留痕
        Err(e) => warn!("任务快照刷新订阅未建立，多副本下改任务需调 /syn/task/reload: {e}"),
    }

    reload().await?;
    Ok(subscribed)
}

/// # 发布任务刷新信号
///
/// `SynTaskSvc` 写事务提交后调用。信号由 JetStream 回送给**所有**节点
/// （包括发布者自己），所以这里不需要顺手 `store` 一次本地快照。
pub async fn on_task_changed() {
    if let Err(e) = robotech::refresh::publish(&SYN_TASK_REFRESH_SUBJECT).await {
        // 发不出去就不能保证别的副本跟上：至少让本副本立刻生效
        warn!("发布任务刷新信号失败，仅本副本重载: {e}");
        if let Err(e) = reload().await {
            warn!("任务刷新信号发布失败后重载快照也失败: {e}");
        }
    }
}
