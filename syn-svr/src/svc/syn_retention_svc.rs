//! # 保留期清理
//!
//! 两张只会增长的运行表：
//!
//! - `syn_idem`：每条成功/跳过的记录都记一行，用于重投去重；
//! - `syn_delivery_log`：每条失败/重试的明细，用于排障。
//!
//! 两者都没有业务上的「永久价值」，超过保留期就该删。这里只做一件事：按 `create_ms`
//! 分批删除，返回删掉的行数；调度交给 jobx 的清理计划（见 `crate::wkr::cleanup_wkr`），
//! 不在进程内起定时器 —— 多副本下每个副本都删一遍既浪费又会让审计数字对不上。
//!
//! **分批**而不是一条 `delete` 删到底：首次执行可能面对几个月的历史数据，一次性删
//! 会造成长事务、大量 WAL 与锁等待。每批是一个独立语句（自动提交），批大小可配
//! （默认 5000），删满一批就继续，直到不足一批为止。
//!
//! 保留口径是**创建时间**，与任务是否重投过无关：幂等台账命中后不会更新 `update_ms`，
//! 唯一稳定的时间基准就是 `create_ms`。

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use wheel_rs::time_utils::now_ms;

use robotech::db::get_db_conn;
use robotech::svc::SvcError;

use super::db_err;

/// # 过期数据清理
pub struct SynRetentionSvc;

impl SynRetentionSvc {
    /// # 清理早于保留期的幂等台账与投递明细
    ///
    /// `retention_days` 由配置给（默认 7 天），`batch_size` 是单条 DELETE 删除的上限
    /// （默认 5000）。调用方负责保证两者 ≥ 1：0 会把「刚刚写入」的数据也删掉，
    /// 属于误操作而不是清理。
    ///
    /// 返回 `(幂等台账, 投递明细)` 的删除行数，直接进 jobx 的任务结果。
    pub async fn cleanup(retention_days: u32, batch_size: u32) -> Result<(u64, u64), SvcError> {
        let cutoff = now_ms() as i64 - i64::from(retention_days) * 86_400_000;
        let batch = u64::from(batch_size.max(1));

        let idem = delete_in_batches("syn_idem", cutoff, batch).await?;
        let delivery = delete_in_batches("syn_delivery_log", cutoff, batch).await?;

        Ok((idem, delivery))
    }
}

/// # 按 `create_ms` 分批删除一张表
///
/// PostgreSQL 的 `delete` 不支持 `limit`，所以用 `ctid in (select ... limit n)` 圈定
/// 本批要删的行。`table` 只会传本文件里的常量名，不拼用户输入。
async fn delete_in_batches(table: &'static str, cutoff: i64, batch: u64) -> Result<u64, SvcError> {
    let db = get_db_conn()?;
    let mut total = 0u64;
    loop {
        let stmt = Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "delete from {table} where ctid in \
                 (select ctid from {table} where create_ms < $1 limit $2)"
            ),
            vec![cutoff.into(), (batch as i64).into()],
        );
        let n = db.execute_raw(stmt).await.map_err(db_err)?.rows_affected();
        total += n;
        if n < batch {
            break;
        }
    }
    Ok(total)
}
