//! # 外部库多驱动连接与方言
//!
//! 数据源可能是 PostgreSQL / MySQL / SQLite 任意一种。连接与查询统一走 sqlx 的
//! [`AnyPool`]：驱动在进程启动时注册一次，运行时按连接串 scheme 选择，不再为每种库
//! 各写一套池与执行路径。
//!
//! 方言差异（标识符引号、类型转换、upsert 语法、取数包裹函数）集中在 [`Dialect`]，
//! 抽取（`poll`）与直写（`db_sink`）只跟方言打交道，不直接碰具体驱动类型。

pub mod dialect;

use std::sync::{OnceLock, RwLock};

use sqlx_core::any::{AnyPool, AnyPoolOptions};
use syn_api::DbEngine;

use dialect::Dialect;

/// 进程级连接池：`数据源 code → 池`。引擎与连接串绑定在池上，换库必须重建池
static POOLS: OnceLock<RwLock<std::collections::HashMap<String, AnyPool>>> = OnceLock::new();

fn pools() -> &'static RwLock<std::collections::HashMap<String, AnyPool>> {
    POOLS.get_or_init(|| RwLock::new(std::collections::HashMap::new()))
}

/// # 按引擎与连接串建池
pub async fn build_pool(
    engine: DbEngine,
    url: &str,
    max_connections: u32,
) -> Result<AnyPool, sqlx::Error> {
    let _ = engine; // 驱动由连接串 scheme 决定；engine 仅用于方言选择，见 resolve
    AnyPoolOptions::new()
        .max_connections(max_connections)
        .connect(url)
        .await
}

/// # 取（必要时建立）一个数据源的连接池
///
/// 池缓存与引擎绑定：连接串或引擎变了由调用方先 [`drop_pool`] 失效旧池。
pub async fn pool_for(
    code: &str,
    engine: DbEngine,
    url: &str,
    max_connections: u32,
) -> Result<AnyPool, String> {
    if let Ok(Some(pool)) = pools().read().map(|g| g.get(code).cloned()) {
        return Ok(pool);
    }
    let pool = build_pool(engine, url, max_connections)
        .await
        .map_err(|e| format!("连接数据源 {code} 失败: {e}"))?;
    if let Ok(mut g) = pools().write() {
        g.insert(code.to_string(), pool.clone());
    }
    Ok(pool)
}

/// # 丢弃指定数据源的池；传 `None` 清空全部（连接串变更后失效缓存用）
pub fn drop_pool(code: Option<&str>) {
    let Ok(mut g) = pools().write() else {
        return;
    };
    match code {
        Some(code) => {
            g.remove(code);
        }
        None => g.clear(),
    }
}

/// # 引擎 → 方言
pub fn dialect_of(engine: DbEngine) -> Dialect {
    engine.into()
}
