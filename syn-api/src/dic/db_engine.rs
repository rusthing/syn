//! # 数据源引擎（数据库类型）
//!
//! 对应 `syn_datasource.engine`（INT2）。与 [`SourceKind`](super::SourceKind) 不同：
//! 那个是「数据怎么来」（SQL / HTTP），这个是「连的是哪种数据库」。
//!
//! sqlx 0.9 在本工程启用的驱动为 PostgreSQL / MySQL / SQLite（MSSQL 驱动未发布进
//! sqlx 0.9）。连接串 scheme 决定默认引擎，引擎字段用于在配置不显式带 scheme、
//! 或需要明确方言时覆盖默认值。

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use strum::{AsRefStr, Display, EnumString};
use utoipa::ToSchema;

/// # 数据源引擎
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, AsRefStr, Display, EnumString)]
#[derive(Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum DbEngine {
    /// PostgreSQL（`postgres://` / `postgresql://`）
    #[default]
    Postgres = 0,
    /// MySQL / MariaDB（`mysql://` / `mariadb://`）
    Mysql = 1,
    /// SQLite（`sqlite://` / `sqlite::memory:`）
    Sqlite = 2,
}

impl DbEngine {
    /// 按连接串 scheme 推断引擎；认不出返回 `None`
    pub fn from_url(url: &str) -> Option<Self> {
        let scheme = url.split_once("://")?.0.trim_end_matches(':').to_ascii_lowercase();
        match scheme.as_str() {
            "postgres" | "postgresql" => Some(Self::Postgres),
            "mysql" | "mariadb" => Some(Self::Mysql),
            "sqlite" => Some(Self::Sqlite),
            _ => None,
        }
    }

    /// 连接串示例，给前端占位符与校验提示用
    pub fn example(self) -> &'static str {
        match self {
            Self::Postgres => "postgres://user:password@host:5432/db",
            Self::Mysql => "mysql://user:password@host:3306/db",
            Self::Sqlite => "sqlite:///path/to/db.sqlite",
        }
    }

    /// 展示名，测试成功时拼在版本号前
    pub fn label(self) -> &'static str {
        match self {
            Self::Postgres => "PostgreSQL",
            Self::Mysql => "MySQL",
            Self::Sqlite => "SQLite",
        }
    }

    /// 探活 SQL：只取一个版本号字符串
    pub fn ping_sql(self) -> &'static str {
        match self {
            // PG 专有：读配置项；MySQL / SQLite 直接查版本函数
            Self::Postgres => "select current_setting('server_version')",
            Self::Mysql => "select version()",
            Self::Sqlite => "select sqlite_version()",
        }
    }
}

impl From<i16> for DbEngine {
    fn from(v: i16) -> Self {
        match v {
            1 => Self::Mysql,
            2 => Self::Sqlite,
            _ => Self::Postgres,
        }
    }
}

impl From<DbEngine> for i16 {
    fn from(v: DbEngine) -> Self {
        v as i16
    }
}

/// 解析引擎标识：数字、kebab-case 名字、或 scheme 名都认；都认不出返回默认 PG
pub fn parse_engine(raw: &str) -> Option<DbEngine> {
    let raw = raw.trim();
    if let Ok(n) = raw.parse::<i16>() {
        return Some(DbEngine::from(n));
    }
    DbEngine::from_str(raw).ok()
}
