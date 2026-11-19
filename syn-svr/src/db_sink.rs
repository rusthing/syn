//! # DB 直写（`target.kind = db`）
//!
//! 五段产出「一行字段」，这里把那一行写成 `insert ... upsert`。三条硬约束：
//!
//! 1. **值一律绑参数**：每列按占位符绑定，不做字符串拼接，也就不存在转义问题；
//!    类型适配交给目标库自己。方言差异（引号、upsert 语法、占位符形态）收敛在
//!    [`crate::db::dialect`]。
//! 2. **表名与列名走白名单**：只接受 `[A-Za-z_][A-Za-z0-9_]*`（`schema.table` 两段），并且
//!    真的去 `information_schema.columns`（SQLite 走 `pragma_table_info`）核一遍再拼 SQL。
//!    配置能改，所以拼接点必须有闸。大小写按目标库里的真实名字匹配（拼 SQL 时包引号，
//!    不会被折叠成小写），所以 `WS_PERSON` / `ID` 这类大写名字合法。
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
//! 绑定值按字符串 / 数值 / 布尔 / JSON 文本传入，**几何 / 二进制列不能直接写**
//! （PostGIS 的 `geometry` 没有从文本的隐式输入）。这类字段走 HTTP 接口，或者在
//! 下游建一个把 WKT 转成 geometry 的视图 —— 不要在映射里塞 `::geometry` 这类片段，
//! 那等于把 SQL 拼接重新引进来。

use async_trait::async_trait;
use sea_orm::{ColumnTrait, Condition};
use serde_json::{Map, Value};
use sqlx::Row;
use sqlx_core::any::AnyPool;
use std::collections::HashMap;
use std::sync::LazyLock;
use syn_api::{DbEngine, DbTarget, OnConflict, Op};
use syn_core::{DbError, DbWriter};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::config::get_app_config;
use crate::dao::SynDatasourceDao;
use crate::db::{self, dialect_of};
use crate::mo::syn_datasource::{Column as DsColumn, Model as DsModel};
use robotech::db::get_db_conn;
use robotech::refresh::RefreshSubject;

/// 数据源变更的刷新主题。写库后发布，各副本收到就丢弃本地连接池与列白名单
pub const SYN_DATASOURCE_REFRESH_SUBJECT: RefreshSubject =
    robotech::refresh_subject!("syn", "datasource");

/// 数据源名 → 连接池。懒建立：只有真的用到这个下游才连
static POOLS: LazyLock<Mutex<HashMap<String, AnyPool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// `数据源|表` → 列名白名单。表结构变了要重启（或等它自己失效，见下）
/// 列白名单：`数据源|表` → `列名 → 绑定占位符的转换后缀`
///
/// 后缀只对 Postgres 有意义：sqlx 的 Any 驱动把参数一律按 text 编码，
/// 直接绑 `$1` 会被 PG 判成 42804（`column "x" is of type bigint but expression is of type text`），
/// 所以占位符要按目标列类型补 `::int8` 这类显式转换。MySQL / SQLite 的隐式转换
/// 本来就够用，后缀留空。
static COLUMNS: LazyLock<Mutex<HashMap<String, HashMap<String, String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// # DB 直写执行器
///
/// 无状态：连接池与列白名单都在进程级缓存里，`pool()` / `columns()` 负责懒初始化。
pub struct DbSinks;

impl DbSinks {
    /// 取（必要时建立）数据源连接池，连同引擎一起返回
    ///
    /// `db_sink` 和 `poll` 共用这一份缓存：同一个数据源名在两个地方各建一个池，
    /// 连接数会翻倍，而下游库的 `max_connections` 是全局的。
    pub(crate) async fn pool_for(name: &str) -> Result<(AnyPool, DbEngine), DbError> {
        if let Some(p) = POOLS.lock().await.get(name) {
            let engine = Self::engine_of(name).await;
            return Ok((p.clone(), engine));
        }
        let (engine, url, max_connections) = Self::resolve(name).await?;
        let pool = db::build_pool(engine, &url, max_connections)
            .await
            .map_err(|e| {
                // 建池失败是可重试的：下游库可能在重启，或者网络抖动
                DbError::retriable("DB_CONNECT", format!("连接数据源 {name} 失败: {e}"))
            })?;
        debug!("数据源 {name} 连接池已建立（{}）", engine.label());
        POOLS.lock().await.insert(name.to_string(), pool.clone());
        Ok((pool, engine))
    }

    /// 数据源当前引擎：池缓存里不带引擎，以表 / 配置解析结果为准
    ///
    /// 与 [`resolve`](Self::resolve) 走同一份解析；读库不可用时不阻断在途写入，
    /// 方言回退默认 PG。
    async fn engine_of(name: &str) -> DbEngine {
        match lookup_table(name).await {
            Ok(Some(row)) => DbEngine::from(row.engine),
            _ => match get_app_config() {
                Ok(c) => c
                    .syn
                    .datasources
                    .get(name)
                    .and_then(|ds| ds.engine)
                    .unwrap_or_default(),
                Err(_) => DbEngine::default(),
            },
        }
    }

    /// 解析数据源的连接参数：**表优先，配置兜底**
    ///
    /// 表里有这个 `code` 就以表为准（停用的直接判失败，不回退配置 —— 那会把
    /// 「运维显式停用」变成「悄悄用旧连接串继续跑」）；只有表里查不到才回退
    /// `[syn.datasources.<name>]`，给联调和「表还没初始化」的环境留一条路。
    ///
    /// 读表失败（连不上 syn 自己的库）也回退配置并告警：这时按配置把这一条投递
    /// 处理掉，比整条链路停摆更划算。
    async fn resolve(name: &str) -> Result<(DbEngine, String, u32), DbError> {
        match lookup_table(name).await {
            Ok(Some(row)) if row.enabled => {
                let engine = DbEngine::from(row.engine);
                return Ok((engine, row.url, row.max_connections.max(1) as u32));
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
        let engine = ds
            .engine
            .or_else(|| DbEngine::from_url(&ds.url))
            .unwrap_or_default();
        Ok((engine, ds.url.clone(), ds.max_connections))
    }

    /// 表的列白名单（首次访问时从 information_schema 读一次）
    ///
    /// `pub(crate)`：DB 直写与 SQL 快照抽取共用 —— MySQL 快照要按真实列名拼整行
    /// JSON 表达式，列名同样必须先在内省结果里核过，不能从配置里直接拼进 SQL。
    pub(crate) async fn columns(
        datasource: &str,
        pool: &AnyPool,
        engine: DbEngine,
        table: &str,
    ) -> Result<HashMap<String, String>, DbError> {
        let cache_key = format!("{datasource}|{table}");
        if let Some(cols) = COLUMNS.lock().await.get(&cache_key) {
            return Ok(cols.clone());
        }
        let (schema, name) = match table.split_once('.') {
            Some((s, t)) => (s.to_string(), t.to_string()),
            None => default_schema(engine, table),
        };
        let rows = match engine {
            // MySQL / SQLite 的 information_schema 口径与 PG 不同，走各自的内省 SQL
            DbEngine::Mysql => {
                // 未指定 schema 时按当前库兜底：`table_schema = database()`
                let sql = if schema == "NULL" {
                    "select column_name, data_type from information_schema.columns
                     where table_schema = database() and table_name = ?"
                } else {
                    "select column_name, data_type from information_schema.columns
                     where table_schema = ? and table_name = ?"
                };
                let mut q = sqlx::query(sql);
                if schema != "NULL" {
                    q = q.bind(&schema);
                }
                q.bind(&name).fetch_all(pool).await
            }
            DbEngine::Sqlite => {
                sqlx::query(
                    "select name as column_name, type as data_type from pragma_table_info($1)",
                )
                .bind(&name)
                .fetch_all(pool)
                .await
            }
            DbEngine::Postgres => {
                // 两个 select 列都是 PG 的 `name` / 域类型，而 sqlx 的 Any 驱动只认
                // text/varchar/int/float/bool/bytea，直接 select 会在解码阶段报
                // 「Any driver does not support the Postgres type Name」，
                // 让每一次 PG 直写都止步于读列信息。这里显式转成 text。
                sqlx::query(
                    "select column_name::text as column_name, data_type::text as data_type
                     from information_schema.columns
                     where table_schema = $1 and table_name = $2",
                )
                .bind(&schema)
                .bind(&name)
                .fetch_all(pool)
                .await
            }
        }
        .map_err(|e| DbError::fatal("DB_SCHEMA", format!("读列信息失败: {e}")))?;

        if rows.is_empty() {
            return Err(DbError::fatal(
                "DB_TABLE_MISSING",
                format!("表 {schema}.{name} 不存在或当前账号没有权限"),
            ));
        }
        let cols: HashMap<String, String> = rows
            .iter()
            .map(|r| {
                let col: String = r.get::<String, _>("column_name");
                let ty: Option<String> = r.try_get::<Option<String>, _>("data_type").ok().flatten();
                let suffix = if engine == DbEngine::Postgres {
                    ty.as_deref().map(pg_cast_suffix).unwrap_or_default()
                } else {
                    String::new()
                };
                (col, suffix)
            })
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
    /// 留着旧白名单会把合法列判成 `DB_UNKNOWN_COLUMN`。正在用池的调用持有 `AnyPool`
    /// 的克隆，这里清掉 map 只是不再复用，不会打断在途写入。
    pub async fn forget_pools() {
        let mut pools = POOLS.lock().await;
        let n = pools.len();
        pools.clear();
        COLUMNS.lock().await.clear();
        db::drop_pool(None);
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
        let (pool, engine) = Self::pool_for(&target.datasource).await?;
        let columns = Self::columns(&target.datasource, &pool, engine, &target.table).await?;

        // 映射的每一列都必须真实存在：拼错一个列名，PG 报的是 42703，
        // 但那已经是「一行数据发出去之后」了，不如在这里就说清楚
        for key in row.keys() {
            if !columns.contains_key(key) {
                return Err(DbError::fatal(
                    "DB_UNKNOWN_COLUMN",
                    format!(
                        "表 {} 没有列 {key}：映射的 to 必须是目标表的真实列名",
                        target.table
                    ),
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

        let mut cols: Vec<&String> = row.keys().collect();
        cols.sort();
        let sql = build_sql(target, op, row, engine, &columns)?;
        debug!("db sink: {sql}");
        let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for col in &cols {
            let value = row.get(*col).cloned().unwrap_or(Value::Null);
            query = query.bind(json_to_bind(value));
        }
        let result = query.execute(&pool).await.map_err(|e| {
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
/// 多一道闸比少一道好），引号按方言包。**值不参与拼接**：每行的值按列绑占位符，
/// 不再走 PG 的 `jsonb_populate_record` 单行 JSON 构造（MySQL / SQLite 没有等价物）。
fn build_sql(
    target: &DbTarget,
    op: Op,
    row: &Map<String, Value>,
    engine: DbEngine,
    columns: &HashMap<String, String>,
) -> Result<String, DbError> {
    let dialect = dialect_of(engine);
    // 列的绑定转换后缀：PG 的 param 一律是 text，必须补 `::int8` 这类显式转换
    let cast = |c: &str| columns.get(c).cloned().unwrap_or_default();
    // 列顺序固定，日志与 explain 才好对比
    let mut cols: Vec<&String> = row.keys().collect();
    cols.sort();
    let quote = |c: &str| dialect.quote_ident(c);
    let col_list = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
    let table = dialect.quote_table(target.table.as_str());
    let keys = target
        .key
        .iter()
        .map(|k| quote(k.as_str()))
        .collect::<Vec<_>>()
        .join(", ");

    if op == Op::D {
        // 按冲突键逐条等值删除：键值由参数绑定，PG 侧同样要按键列类型显式转换
        let on = target
            .key
            .iter()
            .zip(1..)
            .map(|(k, i)| format!("{q} = ${i}{c}", q = quote(k), c = cast(k)))
            .collect::<Vec<_>>()
            .join(" and ");
        return Ok(format!("delete from {table} where {on}"));
    }

    // 占位符：PG / SQLite 用 $n，MySQL 用 ?；PG 补上按列类型的转换后缀
    let placeholders = cols
        .iter()
        .zip(1..)
        .map(|(c, i)| {
            let p = param_placeholder(engine, i);
            if engine == DbEngine::Postgres {
                format!("{p}{}", cast(c))
            } else {
                p
            }
        })
        .collect::<Vec<_>>()
        .join(", ");

    let conflict = match target.on_conflict {
        OnConflict::Error => String::new(),
        OnConflict::Nothing => {
            if dialect.supports_on_conflict() {
                format!("on conflict ({keys}) do nothing")
            } else {
                // MySQL 没有 on conflict：重复键默认忽略（客户端不感知重复）
                "on duplicate key update ".to_string()
                    + &target
                        .key
                        .iter()
                        .map(|k| format!("{q} = {q}", q = quote(k.as_str())))
                        .collect::<Vec<_>>()
                        .join(", ")
            }
        }
        OnConflict::Update => {
            let updates = cols
                .iter()
                .filter(|c| !target.key.iter().any(|k| k.as_str() == c.as_str()))
                .collect::<Vec<_>>();
            if dialect.supports_on_conflict() {
                let set = updates
                    .iter()
                    .map(|c| format!("{q} = excluded.{q}", q = quote(c)))
                    .collect::<Vec<_>>()
                    .join(", ");
                // 全是键列时没有可更新的列，退化成 do nothing（否则 PG 报语法错）
                if set.is_empty() {
                    "on conflict (...) do nothing".to_string()
                } else {
                    format!("on conflict ({keys}) do update set {set}")
                }
            } else {
                // MySQL：on duplicate key update 非键列 = values(列)
                let set = updates
                    .iter()
                    .map(|c| format!("{q} = values({q})", q = quote(c)))
                    .collect::<Vec<_>>()
                    .join(", ");
                if set.is_empty() {
                    "on duplicate key update ".to_string()
                        + &target
                            .key
                            .iter()
                            .map(|k| format!("{q} = {q}", q = quote(k)))
                            .collect::<Vec<_>>()
                            .join(", ")
                } else {
                    format!("on duplicate key update {set}")
                }
            }
        }
    };

    Ok(format!(
        "insert into {table} ({col_list}) values ({placeholders}) {conflict}"
    ))
}

/// # 占位符形态
///
/// PG / SQLite 用 `$n`，MySQL 用 `?`（序号在拼接时按列顺序对应绑定顺序）
fn param_placeholder(engine: DbEngine, n: usize) -> String {
    match engine {
        DbEngine::Mysql => "?".to_string(),
        _ => format!("${n}"),
    }
}

/// # 未带 schema 时的默认 schema
fn default_schema(engine: DbEngine, table: &str) -> (String, String) {
    let schema = match engine {
        DbEngine::Mysql => "NULL".to_string(), // MySQL 由当前库兜底，内省条件见 SQL
        DbEngine::Sqlite => "main".to_string(),
        DbEngine::Postgres => "public".to_string(),
    };
    (schema, table.to_string())
}

/// # PG 列类型 → 占位符的显式转换后缀
///
/// sqlx 的 Any 驱动把参数统一按 text 编码（见 [`json_to_bind`]），而 PG 的预处理语句
/// 会按目标列推断参数类型，两边对不上就是 42804
/// （`column "create_ms" is of type bigint but expression is of type text`）。
/// 所以占位符末端按目标列的真实类型补一次转换，让 text 参数在服务端完成解析。
///
/// 未列出的类型返回空串：宁可让 PG 自己报类型不匹配，也不猜一个错误的转换。
fn pg_cast_suffix(data_type: &str) -> String {
    let cast = match data_type {
        "bigint" => "::int8",
        "integer" => "::int4",
        "smallint" => "::int2",
        "boolean" => "::bool",
        "text" | "character varying" | "character" | "citext" => "::text",
        "numeric" | "decimal" | "money" => "::numeric",
        "real" => "::float4",
        "double precision" => "::float8",
        "date" => "::date",
        "time without time zone" => "::time",
        "time with time zone" => "::timetz",
        "timestamp without time zone" => "::timestamp",
        "timestamp with time zone" => "::timestamptz",
        "json" | "jsonb" => "::jsonb",
        "uuid" => "::uuid",
        "bytea" => "::bytea",
        _ => "",
    };
    cast.to_string()
}

/// # JSON 值 → sqlx 绑定值
///
/// 标量直接绑；对象 / 数组序列化成 JSON 文本绑（目标列若是 JSON 类型由驱动/库解析，
/// 若是文本列则原样落字符串）；`Null` 绑 `None::<String>`。
fn json_to_bind(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if b { "1".to_string() } else { "0".to_string() }),
        other => Some(other.to_string()),
    }
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

    /// 不补类型转换的列信息：拼 SQL 的形状测试只关心占位符与子句
    fn no_casts() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn upsert_updates_non_key_columns() {
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::U,
            &row(),
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert!(sql.starts_with(
            "insert into \"public\".\"dtw_person\" (\"id\", \"name\", \"updated_at\")"
        ));
        // 逐列占位符绑定，不再走 jsonb_populate_record 整行 JSON
        assert!(sql.contains("values ($1, $2, $3)"));
        // 键列不参与 set
        assert!(sql.contains(
            "do update set \"name\" = excluded.\"name\", \"updated_at\" = excluded.\"updated_at\""
        ));
        assert!(!sql.contains("\"id\" = excluded.\"id\""));
    }

    #[test]
    fn nothing_and_error_differ() {
        let nothing = build_sql(
            &t(&["id"], OnConflict::Nothing),
            Op::C,
            &row(),
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert!(nothing.ends_with("do nothing"));
        let error = build_sql(
            &t(&["id"], OnConflict::Error),
            Op::C,
            &row(),
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert!(!error.contains("on conflict"));
    }

    #[test]
    fn all_key_columns_degrades_to_nothing() {
        // 映射里只有键列时没有可更新的列，不能拼出 `do update set` 空子句
        let mut m = Map::new();
        m.insert("id".into(), serde_json::json!(1));
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::C,
            &m,
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert!(sql.ends_with("do nothing"));
    }

    #[test]
    fn delete_uses_key_placeholders() {
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::D,
            &row(),
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert_eq!(
            sql,
            "delete from \"public\".\"dtw_person\" where \"id\" = $1"
        );
    }

    #[test]
    fn composite_key_is_and_joined() {
        let mut m = Map::new();
        m.insert("a".into(), serde_json::json!(1));
        m.insert("b".into(), serde_json::json!(2));
        let sql = build_sql(
            &t(&["a", "b"], OnConflict::Update),
            Op::D,
            &m,
            DbEngine::Postgres,
            &no_casts(),
        )
        .unwrap();
        assert!(sql.contains("\"a\" = $1 and \"b\" = $2"));
    }

    #[test]
    fn pg_placeholders_carry_column_type_casts() {
        // Any 驱动把参数按 text 编码，占位符必须按目标列类型补转换，否则 PG 报 42804
        let mut casts = HashMap::new();
        casts.insert("id".to_string(), "::int8".to_string());
        casts.insert("name".to_string(), "::text".to_string());
        casts.insert("updated_at".to_string(), "::timestamptz".to_string());
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::U,
            &row(),
            DbEngine::Postgres,
            &casts,
        )
        .unwrap();
        assert!(sql.contains("values ($1::int8, $2::text, $3::timestamptz)"));
    }

    #[test]
    fn pg_delete_key_carries_cast() {
        let mut casts = HashMap::new();
        casts.insert("id".to_string(), "::int8".to_string());
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::D,
            &row(),
            DbEngine::Postgres,
            &casts,
        )
        .unwrap();
        assert_eq!(
            sql,
            "delete from \"public\".\"dtw_person\" where \"id\" = $1::int8"
        );
    }

    #[test]
    fn pg_type_mapping_covers_common_types() {
        assert_eq!(pg_cast_suffix("bigint"), "::int8");
        assert_eq!(pg_cast_suffix("timestamp with time zone"), "::timestamptz");
        assert_eq!(pg_cast_suffix("bad_type"), "");
    }

    #[test]
    fn mysql_uses_question_placeholders_and_duplicate_key() {
        let sql = build_sql(
            &t(&["id"], OnConflict::Update),
            Op::U,
            &row(),
            DbEngine::Mysql,
            &no_casts(),
        )
        .unwrap();
        assert!(sql.contains("values (?, ?, ?)"));
        assert!(sql.contains(
            "on duplicate key update `name` = values(`name`), `updated_at` = values(`updated_at`)"
        ));
    }
}
