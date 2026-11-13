//! # 自拉数据源的取数定义
//!
//! 对应 `syn_source.spec`（JSONB）。两种取数方式共用一层外壳，`kind` 决定用哪半边：
//!
//! ```yaml
//! # kind = sql：按游标查库
//! datasource: adm
//! select: select id, name, updated_at from adm_person where deleted = false
//! cursor_column: updated_at, id
//! cursor_type: timestamp
//!
//! # kind = http：分页拉接口（P5，当前只做配置与校验）
//! url: https://crm.example.com/api/person?page={{cursor}}
//! next_path: $.data.next
//! page_size: 200
//! ```
//!
//! ## 为什么游标要声明类型
//!
//! 「水位」以字符串存（可能是时间戳、自增 ID、页码 token），但拼 SQL 时必须知道把它
//! 当什么类型比较：`(updated_at, id) > ($1, $2)` 里的 `$1` 没有类型上下文，PG 会直接
//! 报 `could not determine data type`。与其猜，不如让配置写明
//! [`CursorType`]，拼 SQL 时显式加 `::timestamptz` / `::int8` / `::text`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dic::SourceKind;
use crate::issue::{SpecIssue, SpecIssueKind};

/// # 游标列的类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorType {
    /// 时间戳列（`timestamp` / `timestamptz`）
    #[default]
    Timestamp,
    /// 整数列（自增 ID）
    Int,
    /// 文本列（编码、UUID）
    Text,
}

impl CursorType {
    /// 拼 SQL 用的类型名
    pub fn cast(self) -> &'static str {
        match self {
            Self::Timestamp => "timestamptz",
            Self::Int => "int8",
            Self::Text => "text",
        }
    }
}

/// # 拉到的行怎么变成记录
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WrapMode {
    /// 包成 `{"op":"r","after":{...}}`。默认：查出来的是**快照读**，op 恒为 `r`
    #[default]
    Row,
    /// 原样当记录用（查询本身返回 `{"op":…,"after":…}` 形态）
    Cdc,
}

/// # 取数定义
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceSpec {
    /// 源库的数据源名，取 `[syn.datasources.<name>]`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datasource: Option<String>,
    /// 取数 SQL（必须是单条 `select` / `with`，不允许分号分隔多句）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    /// 游标列，复合时写成 `updated_at, id`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_column: Option<String>,
    /// 游标列的类型
    #[serde(default)]
    pub cursor_type: CursorType,
    /// 行 → 记录的包装方式
    #[serde(default)]
    pub wrap: WrapMode,
    /// 分页地址模板（http）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 下一页游标的取值路径（http）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_path: Option<String>,
    /// 单页条数（http）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i32>,
}

impl SourceSpec {
    /// # 解析
    pub fn parse(value: &Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value.clone())
    }

    /// # 游标列（已去空白）
    pub fn cursor_columns(&self) -> Vec<&str> {
        self.cursor_column
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// # 结构校验
    ///
    /// 只查自相矛盾，不查「这条 SQL 跑不跑得通」—— 那要连源库，放在「立即拉取」里做。
    pub fn validate(&self, kind: SourceKind) -> Result<(), Vec<SpecIssue>> {
        let mut issues = Vec::new();

        match kind {
            SourceKind::Sql => {
                // 只有库表取数才需要数据源连接；http 分页取数走 URL，没有 datasource 的概念
                if self
                    .datasource
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    issues.push(SpecIssue::new(
                        "spec.datasource",
                        SpecIssueKind::Missing,
                        "库表取数必须写数据源名（对应 [syn.datasources.<name>]）",
                    ));
                }
                match self.select.as_deref().map(str::trim) {
                    None | Some("") => issues.push(SpecIssue::new(
                        "spec.select",
                        SpecIssueKind::Missing,
                        "sql 取数必须写 select",
                    )),
                    Some(sql) => {
                        let lower = sql.trim_start().to_ascii_lowercase();
                        if !lower.starts_with("select") && !lower.starts_with("with") {
                            issues.push(SpecIssue::new(
                                "spec.select",
                                SpecIssueKind::Invalid,
                                "只支持 select / with 查询：自拉是只读的",
                            ));
                        }
                        // 分号只允许出现在结尾（用户习惯带），中间有分号说明是多条语句
                        if sql.trim_end_matches(';').contains(';') {
                            issues.push(SpecIssue::new(
                                "spec.select",
                                SpecIssueKind::Invalid,
                                "不允许多条语句：拼进子查询后会语法错",
                            ));
                        }
                    }
                }

                let cols = self.cursor_columns();
                if cols.is_empty() {
                    issues.push(SpecIssue::new(
                        "spec.cursor_column",
                        SpecIssueKind::Missing,
                        "必须写游标列：没有它无法增量拉取",
                    ));
                }
                if cols.len() > 2 {
                    issues.push(SpecIssue::new(
                        "spec.cursor_column",
                        SpecIssueKind::Invalid,
                        "游标列最多两列（时间戳 + ID）",
                    ));
                }
                for (i, c) in cols.iter().enumerate() {
                    if !is_ident(c) {
                        issues.push(SpecIssue::new(
                            format!("spec.cursor_column[{i}]"),
                            SpecIssueKind::Invalid,
                            "列名只能是小写字母/数字/下划线",
                        ));
                    }
                }
                // 单列游标用 int 时是自增主键；两列时第一列必须是时间戳，
                // 否则「回退重叠窗口」无从谈起
                if cols.len() == 2 && self.cursor_type != CursorType::Timestamp {
                    issues.push(SpecIssue::new(
                        "spec.cursor_type",
                        SpecIssueKind::Conflict,
                        "两列游标的第一列是时间戳，类型必须写 timestamp",
                    ));
                }
            }
            SourceKind::Http => {
                if self.url.as_deref().unwrap_or("").trim().is_empty() {
                    issues.push(SpecIssue::new(
                        "spec.url",
                        SpecIssueKind::Missing,
                        "http 取数必须写分页地址",
                    ));
                }
                if self.page_size.is_some_and(|n| n <= 0) {
                    issues.push(SpecIssue::new(
                        "spec.page_size",
                        SpecIssueKind::Invalid,
                        "单页条数必须大于 0",
                    ));
                }
            }
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
