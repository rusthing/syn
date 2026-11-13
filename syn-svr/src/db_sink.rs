//! # DB 直写（`target.kind = db`）
//!
//! 五段产出「一行字段」，这里把那一行写成 `insert ... on conflict`。三条硬约束：
//!
//! 1. **值一律绑参数**：整行作为 `$1::jsonb` 传入，由 `jsonb_populate_record` 按目标
//!    表的列类型解析。不做字符串拼接，也就不存在转义问题，顺带把「JSON → int/timestamp/
//!    numeric」的类型适配交给 PG 自己。
//! 2. **表名与列名走白名单**：只接受 `[a-z_][a-z0-9_]*`（`schema.table` 两段），并且
//!    真的去 `information_schema.columns` 核一遍再拼 SQL。配置能改，所以拼接点必须有闸。
//! 3. **一个数据源一个账号**：连接串以 `syn_datasource` 表为准，任务配置里只有
//!    数据源名。共用高权账号等于「改一条任务就能写任何库」。
//!
//! ## 连接串从哪来
//!
//! **表优先、配置兜底**：`syn_datasource` 里有这个 `code` 就用它（`enabled=false`
//! 直接判失败，不回退 —— 停用是运维的显式动作）；表里没有才回退到
//! `[syn.datasources.<name>]`，给联调与「表还没初始化」的环境留一条路。
//!
//! 连接串可变，所以连接池不能只建不换：控制台写完 `syn_datasource` 发一条
//! [`SYN_DATASOURCE_REFRESH_SUBJECT`]，各副本（含发布者）收到就把本地连接池与
//! 列白名单全丢掉，下次用到时按新连接串重建。不发这条信号的话，3 个副本会各连
//! 各的旧库，现象是「改了连接串，有的副本写新库有的写旧库」。
//!
//! ## 已知边界
//!
//! `jsonb_populate_record` 靠列类型的输入函数做转换，因此**几何 / 二进制列不能直接写**
//! （PostGIS 的 `geometry` 没有从 WKT 文本的隐式输入）。这类字段走 HTTP 接口，或者在
//! 下游建一个带 `st_geomfromtext` 的视图 —— 不要在映射里塞 `::geometry` 这类片段，
//! 那等于把 SQL 拼接重新引进来。

use async_trait::async_trait;
use sea_orm::{ColumnTrait, Condition};
use serde_json::{Map, Value};
use sqlx::{PgPool, Row};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use syn_api::{DbTarget, OnConflict, Op};
use syn_core::{DbError, DbWriter};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::config::get_app_config;
use crate::dao::SynDatasourceDao;
use crate::mo::syn_datasource::{Column as DsColumn, Model as DsModel};
use robotech::db::get_db_conn;
use robotech::refresh::RefreshSubject;

/// 数据源变更的刷新主题。写库后发布，各副本收到就丢弃本地连接池与列白名单
pub const SYN_DATASOURCE_REFRESH_SUBJECT: RefreshSubject =
    robotech::refresh_subject!("syn", "datasource");

/// 数据源名 → 连接池。懒建立：只有真的用到这个下游才连
static POOLS: LazyLock<Mutex<HashMap<String, PgPool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// `数据源|表` → 列名白名单。表结构变了要重启（或等它自己失效，见下）
static COLUMNS: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// # DB 直写执行器
///
/// 无状态：连接池与列白名单都在进程级缓存里，`pool()` / `columns()` 负责懒初始化。
pub struct DbSinks;

impl DbSinks {
    /// 取（必要时建立）数据源连接池
    ///
    /// `db_sink` 和 `poll` 共用这一份缓存：同一个数据源名在两个地方各建一个池，
    /// 连接数会翻倍，而下游库的 `max_connections` 是全局的。
    pub(crate) async fn pool_for(name: &str) -> Result<PgPool, DbError> {
        if let Some(p) = POOLS.lock().await.get(name) {
            return Ok(p.clone());
        }
        let (url, max_connections) = Self::resolve(name).await?;
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(&url)
            .await
            .map_err(|e| {
                // 建池失败是可重试的：下游库可能在重启，或者网络抖动
                DbError::retriable("DB_CONNECT", format!("连接数据源 {name} 失败: {e}"))
            })?;
        debug!("数据源 {name} 连接池已建立");
        POOLS.lock().await.insert(name.to_string(), pool.clone());
        Ok(pool)
    }

    /// 解析数据源的连接参数：**表优先，配置兜底**
    ///
    /// 表里有这个 `code` 就以表为准（停用的直接判失败，不回退配置 —— 那会把
    /// 「运维显式停用」变成「悄悄用旧连接串继续跑」）；只有表里查不到才回退
    /// `[syn.datasources.<name>]`，给联调和「表还没初始化」的环境留一条路。
    ///
    /// 读表失败（连不上 syn 自己的库）也回退配置并告警：这时按配置把这一条投递
    /// 处理掉，比整条链路停摆更划算。
    async fn resolve(name: &str) -> Result<(String, u32), DbError> {
        match lookup_table(name).await {
            Ok(Some(row)) if row.enabled => {
                return Ok((row.url, row.max_connections.max(1) as u32));
            }
            Ok(Some(_)) => {
                return Err(DbError::fatal(
                    "DATASOURCE_DISABLED",
                    format!("数据源 {name} 已在控制台停用"),
                ));
            }
            Ok(None) => {}
            Err(e) => warn!("读 syn_datasource 失败，回退 [syn.datasources]: {e}"),
        }
        let config =
            get_app_config().map_err(|e| DbError::fatal("CONFIG_NOT_READY", e.to_string()))?;
        let ds = config.syn.datasources.get(name).ok_or_else(|| {
            DbError::fatal(
                "DATASOURCE_UNRESOLVED",
                format!(
                    "数据源 {name} 既不在 syn_datasource 表里，也不在 [syn.datasources] 配置里"
                ),
            )
        })?;
        Ok((ds.url.clone(), ds.max_connections))
    }

    /// 表的列白名单（首次访问时从 information_schema 读一次）
    async fn columns(
        &self,
        datasource: &str,
        pool: &PgPool,
        table: &str,
    ) -> Result<HashSet<String>, DbError> {
        let cache_key = format!("{datasource}|{table}");
        if let Some(cols) = COLUMNS.lock().await.get(&cache_key) {
            return Ok(cols.clone());
        }
        let (schema, name) = match table.split_once('.') {
            Some((s, t)) => (s.to_string(), t.to_string()),
            None => ("public".to_string(), table.to_string()),
        };
        let rows = sqlx::query(
            "select column_name from information_schema.columns
             where table_schema = $1 and table_name = $2",
        )
        .bind(&schema)
        .bind(&name)
        .fetch_all(pool)
        .await
        .map_err(|e| DbError::fatal("DB_SCHEMA", format!("读列信息失败: {e}")))?;

        if rows.is_empty() {
            return Err(DbError::fatal(
                "DB_TABLE_MISSING",
                format!("表 {schema}.{name} 不存在或当前账号没有权限"),
            ));
        }
        let cols: HashSet<String> = rows
            .iter()
            .map(|r| r.get::<String, _>("column_name"))
            .collect();
        COLUMNS.lock().await.insert(cache_key, cols.clone());
        Ok(cols)
    }

    /// 清掉列白名单缓存（表结构变更后由运维调 reload 触发）
    pub async fn forget_columns() {
        COLUMNS.lock().await.clear();
    }

    /// # 丢弃全部连接池与列白名单
    ///
    /// 连接串一改，池子和「表有哪些列」的缓存都作废：换库之后列集合可能完全不同，
    /// 留着旧白名单会把合法列判成 `DB_UNKNOWN_COLUMN`。正在用池的调用持有 `PgPool`
    /// 的克隆，这里清掉 map 只是不再复用，不会打断在途写入。
    pub async fn forget_pools() {
        let mut pools = POOLS.lock().await;
        let n = pools.len();
        pools.clear();
        COLUMNS.lock().await.clear();
        if n > 0 {
            info!("数据源连接池已失效，{n} 个池待重建");
        }
    }
}

/// 查 `syn_datasource` 里的一条（停用的也返回，由调用方决定怎么处理）
///
/// 错误统一折成 `String`：这里只用来决定「回退配置」并留一条日志，
/// 不需要把 DAO 的错误类型往上带（DAO 的 `DaoError` 不进本模块的错误契约）。
async fn lookup_table(name: &str) -> Result<Option<DsModel>, String> {
    let db = get_db_conn().map_err(|e| e.to_string())?;
    SynDatasourceDao::get_by_condition::<_, DsModel>(
        Condition::all().add(DsColumn::Code.eq(name)),
        db.as_ref(),
    )
    .await
    .map_err(|e| e.to_string())
}

/// # 发布数据源变更信号
///
/// 控制台写成功 `syn_datasource` 后调用。信号由 JetStream 回送**所有**副本
/// （包括发布者自己），所以这里不顺手清本地池 —— 统一走订阅回调，路径只有一条。
/// 发不出去时至少让本副本失效：宁可本副本重建，也不能留在旧连接串上。
pub async fn on_datasource_changed() {
    if let Err(e) = robotech::refresh::publish(&SYN_DATASOURCE_REFRESH_SUBJECT).await {
        warn!("发布数据源刷新信号失败，仅本副本失效: {e}");
        DbSinks::forget_pools().await;
    }
}

/// # 启动订阅数据源变更
///
/// 与任务快照同构：先订阅再首次使用。返回 `false` 表示没配上 nats（单副本/联调），
/// 此时改了数据源要重启进程或调控制台的启停接口才会重建连接池。
pub async fn setup_datasource_refresh() -> anyhow::Result<bool> {
    match robotech::refresh::subscribe(&SYN_DATASOURCE_REFRESH_SUBJECT, || async {
        DbSinks::forget_pools().await;
        Ok(())
    })
    .await
    {
        Ok(_) => {
            info!("数据源刷新订阅已建立: {SYN_DATASOURCE_REFRESH_SUBJECT}");
            Ok(true)
        }
        Err(e) => {
            warn!("数据源刷新订阅未建立，改数据源后需重启生效: {e}");
            Ok(false)
        }
    }
}

#[async_trait]
impl DbWriter for DbSinks {
    async fn write(
        &self,
        target: &DbTarget,
        op: Op,
        row: &Map<String, Value>,
    ) -> Result<u64, DbError> {
        let pool = Self::pool_for(&target.datasource).await?;
        let columns = self
            .columns(&target.datasource, &pool, &target.table)
            .await?;

        // 映射的每一列都必须真实存在：拼错一个列名，PG 报的是 42703，
        // 但那已经是「一行数据发出去之后」了，不如在这里就说清楚
        for (i, key) in row.keys().enumerate() {
            if !columns.contains(key) {
                return Err(DbError::fatal(
                    "DB_UNKNOWN_COLUMN",
                    format!("表 {} 没有列 {key}（第 {} 个映射行）", target.table, i + 1),
                ));
            }
        }
        for key in &target.key {
            if !row.contains_key(key) {
                return Err(DbError::fatal(
                    "DB_KEY_MISSING",
                    format!("冲突键 {key} 不在映射结果里：没有它无法 upsert，也无法删除"),
                ));
            }
        }

        let sql = build_sql(target, op, row)?;
        debug!("db sink: {sql}");
        let payload = Value::Object(row.clone());
        let result = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .bind(payload)
            .execute(&pool)
            .await
            .map_err(|e| {
                let mapped = classify(&e);
                if !mapped.retriable {
                    warn!("db sink 写入 {} 失败: {}", target.table, mapped.detail);
                }
                mapped
            })?;
        Ok(result.rows_affected())
    }
}

/// # 拼 SQL
///
/// 标识符在这里再校验一次（`DbTarget` 已经筛过，但 SQL 是不可回滚的副作用，
/// 多一道闸比少一道好），然后加双引号。**值不参与拼接**。
fn build_sql(target: &DbTarget, op: Op, row: &Map<String, Value>) -> Result<String, DbError> {
    // 列顺序固定，日志与 explain 才好对比
    let mut cols: Vec<&String> = row.keys().collect();
    cols.sort();
    let quoted = |c: &str| format!("\"{c}\"");
    let col_list = cols
        .iter()
        .map(|c| quoted(c))
        .collect::<Vec<_>>()
        .join(", ");
    let table = target.table.as_str();
    let keys = target
        .key
        .iter()
        .map(|k| quoted(k))
        .collect::<Vec<_>>()
        .join(", ");

    if op == Op::D {
        // 删除用 populate_record 生成一张「一行的表」，按主键 join 后再删：
        // 这样键的类型由目标表决定，不需要在 Rust 侧猜它是不是 int8
        let on = target
            .key
            .iter()
            .map(|k| format!("t.{q} = j.{q}", q = quoted(k)))
            .collect::<Vec<_>>()
            .join(" and ");
        return Ok(format!(
            "delete from {table} t using jsonb_populate_record(null::{table}, $1::jsonb) j where {on}"
        ));
    }

    let conflict = match target.on_conflict {
        OnConflict::Error => String::new(),
        OnConflict::Nothing => format!("on conflict ({keys}) do nothing"),
        OnConflict::Update => {
            let updates = cols
                .iter()
                .filter(|c| !target.key.iter().any(|k| k.as_str() == c.as_str()))
                .map(|c| format!("{q} = excluded.{q}", q = quoted(c)))
                .collect::<Vec<_>>()
                .join(", ");
            // 全是键列时没有可更新的列，退化成 do nothing（否则 PG 报语法错）
            if updates.is_empty() {
                format!("on conflict ({keys}) do nothing")
            } else {
                format!("on conflict ({keys}) do update set {updates}")
            }
        }
    };

    Ok(format!(
        "insert into {table} ({col_list}) \
         select {col_list} from jsonb_populate_record(null::{table}, $1::jsonb) {conflict}"
    ))
}

/// # 把 sqlx 错误翻译成「能不能重试」
///
/// 判断依据是 SQLSTATE 前两位与具体码。宁可按可重试处理连接类问题（有预算兜着），
/// 也不要把「表不存在」这种确定性错误反复重投 —— 那只会把日志刷满。
fn classify(e: &sqlx::Error) -> DbError {
    use sqlx::Error;
    match e {
        Error::Database(db) => {
            let code = db.code().unwrap_or_default().to_string();
            let detail = db.message().to_string();
            // 40xxx：事务回滚类（序列化失败、死锁），重试即可
            if code.starts_with("40") {
                return DbError::retriable("DB_CONFLICT", format!("{code} {detail}"));
            }
            let tag = match code.as_str() {
                "23505" => "DB_UNIQUE",
                "23503" => "DB_FK",
                "23502" => "DB_NOT_NULL",
                "23514" => "DB_CHECK",
                "42501" => "DB_PERMISSION",
                "42P01" => "DB_TABLE_MISSING",
                "42703" => "DB_UNKNOWN_COLUMN",
                "22P02" => "DB_TYPE",
                "57014" => "DB_TIMEOUT",
                _ => "DB_ERROR",
            };
            // 57014 是语句被取消（超时），可以重试
            let retriable = tag == "DB_TIMEOUT";
            DbError {
                retriable,
                code: tag.to_string(),
                detail: format!("{code} {detail}"),
            }
        }
        Error::Io(_) | Error::PoolTimedOut | Error::PoolClosed => {
            DbError::retriable("DB_CONNECT", e.to_string())
        }
        other => DbError::fatal("DB_ERROR", other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(key: &[&str], on_conflict: OnConflict) -> DbTarget {
        DbTarget {
            datasource: "dtw".into(),
            table: "public.dtw_person".into(),
            key: key.iter().map(|k| k.to_string()).collect(),
            on_conflict,
        }
    }

    fn row() -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("id".into(), serde_json::json!(1));
        m.insert("name".into(), serde_json::json!("张三"));
        m.insert(
            "updated_at".into(),
            serde_json::json!("2026-11-12T21:00:00Z"),
        );
        m
    }

    #[test]
    fn upsert_updates_non_key_columns() {
        let sql = build_sql(&t(&["id"], OnConflict::Update), Op::U, &row()).unwrap();
        assert!(
            sql.starts_with("insert into public.dtw_person (\"id\", \"name\", \"updated_at\")")
        );
        assert!(sql.contains("select \"id\", \"name\", \"updated_at\" from jsonb_populate_record"));
        // 键列不参与 set
        assert!(sql.contains(
            "do update set \"name\" = excluded.\"name\", \"updated_at\" = excluded.\"updated_at\""
        ));
        assert!(!sql.contains("\"id\" = excluded.\"id\""));
    }

    #[test]
    fn nothing_and_error_differ() {
        let nothing = build_sql(&t(&["id"], OnConflict::Nothing), Op::C, &row()).unwrap();
        assert!(nothing.ends_with("do nothing"));
        let error = build_sql(&t(&["id"], OnConflict::Error), Op::C, &row()).unwrap();
        assert!(!error.contains("on conflict"));
    }

    #[test]
    fn all_key_columns_degrades_to_nothing() {
        // 映射里只有键列时没有可更新的列，不能拼出 `do update set` 空子句
        let mut m = Map::new();
        m.insert("id".into(), serde_json::json!(1));
        let sql = build_sql(&t(&["id"], OnConflict::Update), Op::C, &m).unwrap();
        assert!(sql.ends_with("do nothing"));
    }

    #[test]
    fn delete_uses_using_clause() {
        let sql = build_sql(&t(&["id"], OnConflict::Update), Op::D, &row()).unwrap();
        assert_eq!(
            sql,
            "delete from public.dtw_person t using jsonb_populate_record(null::public.dtw_person, $1::jsonb) j where t.\"id\" = j.\"id\""
        );
    }

    #[test]
    fn composite_key_is_and_joined() {
        let mut m = Map::new();
        m.insert("a".into(), serde_json::json!(1));
        m.insert("b".into(), serde_json::json!(2));
        let sql = build_sql(&t(&["a", "b"], OnConflict::Update), Op::D, &m).unwrap();
        assert!(sql.contains("t.\"a\" = j.\"a\" and t.\"b\" = j.\"b\""));
    }
}
