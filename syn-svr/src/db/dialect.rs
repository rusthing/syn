//! # SQL 方言分叉
//!
//! 抽取与直写共用一套语义，三种库的语法差异收敛在这里：
//!
//! | 项 | PostgreSQL | MySQL | SQLite |
//! |----|------------|-------|--------|
//! | 标识符引号 | `"col"` | `` `col` `` | `"col"` |
//! | 整行包裹 JSON | `to_jsonb(s)` | `JSON_OBJECT(...)` | `json_object(...)` |
//! | 游标类型转换 | `$1::timestamptz` | `CAST(? AS DATETIME)` | `?` |
//! | 时间水位上限 | `now() - interval 'N seconds'` | `NOW() - INTERVAL N SECOND` | 不做重叠窗口 |
//! | 行内 upsert | `on conflict (...) do update set ... excluded.` | `on duplicate key update ...` | `on conflict (...) do update set ... excluded.` |
//!
//! 标识符仍走白名单校验（`[a-z_][a-z0-9_]*` / `schema.table`），这里只负责包引号与拼语法。

use syn_api::DbEngine;

/// # 数据库方言
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    /// 标识符引号：把裸标识包成带引号的形态
    pub fn quote_ident(self, ident: &str) -> String {
        match self {
            Self::Mysql => format!("`{ident}`"),
            _ => format!("\"{ident}\""),
        }
    }

    /// `schema.table` 两段分别包引号
    pub fn quote_table(self, table: &str) -> String {
        match table.split_once('.') {
            Some((schema, name)) => format!("{}.{}", self.quote_ident(schema), self.quote_ident(name)),
            None => self.quote_ident(table),
        }
    }

    /// 游标参数的类型转换表达式（占位符 `?` / `$n` 由调用方绑定，这里只给 CAST 目标）
    pub fn cast_expr(self, param: &str, ty: syn_api::FieldType) -> String {
        match self {
            Self::Postgres => format!("{param}::{}", ty.cast()),
            Self::Mysql => {
                let mysql_ty = match ty {
                    syn_api::FieldType::Bigint => "SIGNED",
                    syn_api::FieldType::Timestamptz => "DATETIME(3)",
                    syn_api::FieldType::Uuid => "CHAR(36)",
                    syn_api::FieldType::Varchar => "CHAR",
                };
                format!("CAST({param} AS {mysql_ty})")
            }
            // SQLite 动态类型，不做显式 CAST
            Self::Sqlite => param.to_string(),
        }
    }

    /// 时间戳游标的重叠窗口上限表达式；非时间戳游标或 SQLite 返回 `None`
    pub fn overlap_limit(self, cursor_col: &str, seconds: u32) -> Option<String> {
        match self {
            Self::Postgres => Some(format!("{cursor_col} <= now() - interval '{seconds} seconds'")),
            Self::Mysql => Some(format!("{cursor_col} <= NOW() - INTERVAL {seconds} SECOND")),
            // SQLite 没有 now() 内建时间比较口径，重叠窗口交给调用方不加条件
            Self::Sqlite => None,
        }
    }

    /// 是否支持 `on conflict ... do update`（PG / SQLite）；MySQL 走 `on duplicate key`
    pub fn supports_on_conflict(self) -> bool {
        !matches!(self, Self::Mysql)
    }
}

impl From<DbEngine> for Dialect {
    fn from(engine: DbEngine) -> Self {
        match engine {
            DbEngine::Postgres => Self::Postgres,
            DbEngine::Mysql => Self::Mysql,
            DbEngine::Sqlite => Self::Sqlite,
        }
    }
}
