//! # 总览服务
//!
//! 统计口径只有一句话：**全部来自 `syn_idem` 的记账行**。执行器不落逐次投递明细，
//! 也不落耗时，所以没开幂等记账时 `total` 恒为 0、`p95_ms` 恒为 0 —— 这是事实，
//! 不是「没查到」。要真正的吞吐曲线得先建明细表（改 LDM），不要在这里编数字。
//!
//! 三条查询都是单表聚合，用 `Statement` 直接跑比把 `filter (where ...)` 硬翻译成
//! SeaORM 表达式清楚得多；值仍然绑参数，不拼字符串。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::collections::HashMap;
use syn_api::{
    SynOverviewFailureVo, SynOverviewHourVo, SynOverviewQueryDto, SynOverviewVo,
};
use wheel_rs::time_utils::now_ms;

use crate::dao::SynTaskDao;
use crate::mo::syn_task::{Column as TaskColumn, Model as TaskModel};
use sea_orm::{ColumnTrait, Condition};

/// # 总览服务
pub struct SynOverviewSvc;

impl SynOverviewSvc {
    /// # 统计一个时间窗
    pub async fn get(dto: SynOverviewQueryDto) -> Result<SynOverviewVo, SvcError> {
        let db = get_db_conn()?;
        let window_ms = dto.window_ms();
        let from = now_ms() as i64 - window_ms;
        let now = now_ms() as i64;

        // 1) 四类结论的合计
        let totals = db
            .query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select count(*) as n, \
                        count(*) filter (where verdict = 0) as success, \
                        count(*) filter (where verdict = 1) as skip, \
                        count(*) filter (where verdict = 2) as fatal, \
                        count(*) filter (where verdict = 3) as retriable \
                 from syn_idem where create_ms >= $1",
                [from.into()],
            ))
            .await.map_err(db_err)?;
        let (total, success, skip, fatal, retriable) = match totals {
            Some(r) => (
                get_i64(&r, "n"),
                get_i64(&r, "success"),
                get_i64(&r, "skip"),
                get_i64(&r, "fatal"),
                get_i64(&r, "retriable"),
            ),
            None => (0, 0, 0, 0, 0),
        };

        // 2) 每小时桶。先把窗口内每个整点都摆上 0，再用查询结果覆盖，
        //    这样前端画出来的曲线没有断点（也省得前端自己补桶）。
        //    **必须含当前小时**：from = now - N 小时，两端整点化后相差 N 个桶，
        //    只摆 N 个点会让刚发生的记账落在数组之外，曲线尾部恒为 0（真库联调发现）。
        let mut series: Vec<SynOverviewHourVo> = hour_buckets(from, window_ms)
            .into_iter()
            .map(|h| SynOverviewHourVo {
                hour_ms: U64::from(h),
                success: 0,
                fatal: 0,
                retriable: 0,
            })
            .collect();
        let buckets = db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select (create_ms / 3600000) * 3600000 as h, \
                        count(*) filter (where verdict = 0) as success, \
                        count(*) filter (where verdict = 2) as fatal, \
                        count(*) filter (where verdict = 3) as retriable \
                 from syn_idem where create_ms >= $1 group by h order by h",
                [from.into()],
            ))
            .await.map_err(db_err)?;
        let index: HashMap<i64, usize> = series
            .iter()
            .enumerate()
            .map(|(i, b)| (b.hour_ms.value() as i64, i))
            .collect();
        for r in buckets {
            if let Some(&i) = index.get(&get_i64(&r, "h")) {
                series[i].success = get_i64(&r, "success") as u64;
                series[i].fatal = get_i64(&r, "fatal") as u64;
                series[i].retriable = get_i64(&r, "retriable") as u64;
            }
        }

        // 3) 失败分类 Top 10。按「分类码 + 任务」分组，排障时这两项就够了
        let failure_rows = db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "select code, task_id, count(*) as n from syn_idem \
                 where verdict in (2, 3) and create_ms >= $1 \
                 group by code, task_id order by n desc limit 10",
                [from.into()],
            ))
            .await.map_err(db_err)?;
        let mut pairs = Vec::with_capacity(failure_rows.len());
        for r in &failure_rows {
            pairs.push((
                r.try_get::<String>("", "code").unwrap_or_default(),
                get_i64(r, "task_id"),
                get_i64(r, "n") as u64,
            ));
        }
        let task_ids: Vec<i64> = pairs
            .iter()
            .map(|(_, id, _)| *id)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let codes: HashMap<i64, String> = if task_ids.is_empty() {
            HashMap::new()
        } else {
            SynTaskDao::list_by_condition::<_, TaskModel>(
                Condition::all().add(TaskColumn::Id.is_in(task_ids)),
                &None,
                db.as_ref(),
            )
            .await?
            .into_iter()
            .map(|m| (m.id, m.code))
            .collect()
        };
        let top_failures = pairs
            .into_iter()
            .map(|(code, task_id, count)| SynOverviewFailureVo {
                code,
                task_code: codes.get(&task_id).cloned().unwrap_or_default(),
                count,
            })
            .collect();

        // 4) 配置侧的计数
        let task_row = db
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "select count(*) as n, count(*) filter (where enabled) as on from syn_task"
                    .to_string(),
            ))
            .await.map_err(db_err)?;
        let (tasks, enabled_tasks) = match &task_row {
            Some(r) => (get_i64(r, "n") as u64, get_i64(r, "on") as u64),
            None => (0, 0),
        };
        let source_row = db
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                "select count(*) as n from syn_source".to_string(),
            ))
            .await.map_err(db_err)?;
        let sources = source_row.as_ref().map(|r| get_i64(r, "n") as u64).unwrap_or(0);
        let stalled_sources = stalled_sources(db.as_ref(), now).await?;

        Ok(SynOverviewVo {
            window: dto.window().to_string(),
            total: total as u64,
            success: success as u64,
            skip: skip as u64,
            fatal: fatal as u64,
            retriable: retriable as u64,
            // 执行器不落耗时，恒 0；别用「平均值」冒充 P95
            p95_ms: 0,
            tasks,
            enabled_tasks,
            sources,
            stalled_sources,
            series,
            top_failures,
        })
    }
}

/// # 卡住的数据源
///
/// 判据：启用的数据源，跑过至少一轮，但「距上次开跑」超过 3 个调度周期。
/// 没跑过的不算（还没轮到它）；停用是人为决定，也不算。
async fn stalled_sources<C: ConnectionTrait>(db: &C, now: i64) -> Result<u64, SvcError> {
    let rows = db
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "select s.interval_duration as itv, c.last_run_ms as last_ms \
             from syn_source s left join syn_cursor c on c.source_id = s.id \
             where s.enabled = true"
                .to_string(),
        ))
        .await.map_err(db_err)?;
    let mut n = 0u64;
    for r in rows {
        let Some(last_ms) = r.try_get::<Option<i64>>("", "last_ms").ok().flatten() else {
            continue;
        };
        let itv = r.try_get::<String>("", "itv").unwrap_or_default();
        let period = humantime::parse_duration(&itv)
            .unwrap_or(std::time::Duration::from_secs(60))
            .as_millis() as i64;
        if now - last_ms > period.saturating_mul(3) {
            n += 1;
        }
    }
    Ok(n)
}

/// # 窗口内的整点桶（含当前小时）
///
/// `from = now - window_ms`，且窗口长度是整小时，所以 `floor(from)` 与 `floor(now)`
/// 正好相差 `hours` 个桶 —— 覆盖两端需要 `hours + 1` 个点。窗口内任意一条记账的
/// 整点都在这个列表里，桶查询的结果不会被 `index.get()` 丢掉。
fn hour_buckets(from: i64, window_ms: i64) -> Vec<i64> {
    const HOUR: i64 = 3_600_000;
    let hours = (window_ms / HOUR).max(1);
    let first = (from / HOUR) * HOUR;
    (0..=hours).map(|i| first + i * HOUR).collect()
}

fn get_i64(row: &sea_orm::QueryResult, col: &str) -> i64 {
    row.try_get("", col).unwrap_or(0)
}

/// `ConnectionTrait` 直接返回的 `DbErr` 不在 `SvcError` 的 `From` 列表里，
/// 统一在这里转成 Runtime（DAO 路径走 `DaoError`，不需要这一层）
fn db_err(e: sea_orm::DbErr) -> SvcError {
    SvcError::Runtime(anyhow::anyhow!(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::hour_buckets;

    const HOUR: i64 = 3_600_000;

    #[test]
    fn one_hour_window_includes_current_hour() {
        let now = HOUR * 10 + 999;
        let from = now - HOUR;
        let buckets = hour_buckets(from, HOUR);
        assert_eq!(buckets, vec![HOUR * 9, HOUR * 10]);
        // 刚刚发生的那条记账，整点必须能在桶里找到
        assert_eq!(buckets.last().copied(), Some((now / HOUR) * HOUR));
    }

    #[test]
    fn day_window_covers_both_endpoints() {
        let now = HOUR * 100 + 1234;
        let window = 24 * HOUR;
        let from = now - window;
        let buckets = hour_buckets(from, window);
        assert_eq!(buckets.len(), 25);
        assert_eq!(buckets[0], HOUR * 76);
        assert_eq!(buckets[24], HOUR * 100);
        for t in [from, now - HOUR, now] {
            assert!(buckets.contains(&((t / HOUR) * HOUR)), "{t} 的整点缺桶");
        }
    }
}
