//! # 自拉数据源的取数定义
//!
//! 对应 `syn_source.spec`（JSONB）。两种取数方式共用一层外壳，`kind` 决定用哪半边：
//!
//! ```yaml
//! # kind = sql：按游标增量查库
//! datasource: adm
//! select: select id, name, updated_at from adm_person where deleted = false
//! cursor_column: updated_at, id
//! cursor_type: timestamp
//!
//! # kind = http：全量分页拉接口（首次同步用，一轮翻到底后标记 done）
//! url: https://crm.example.com/api/person?page={cursor}&size={size}
//! data_path: $.data.list      # 数据数组在响应里的位置，缺省 $（响应本身就是数组）
//! next_path: $.data.next      # 有它就按 token 翻页；没有就按页码 1,2,3…
//! page_size: 200
//! method: GET                 # 缺省 GET
//! [headers]                   # 可选，鉴权用；不写进日志
//! Authorization = "Bearer …"
//! ```
//!
//! ## http 为什么是「全量」而不是「增量」
//!
//! HTTP 接口一般只有页码或 token 分页，没有 `(updated_at, id)` 这种稳定水位：
//! 翻页中途源端插入会让第 2 页漏行或重复，游标 token 还会过期。所以 http 源按
//! **全量一次性**同步设计：第一轮从第 1 页开始，一轮推一页，翻到底写
//! `{"full":"done"}`，此后调度跳过；要重跑得显式 reset。
//!
//! 这也决定了它的使用前提：**只用于首次同步**，增量交给 dbz。全量叠加 dbz 同时写
//! 同一张表会让旧快照覆盖新值、删除语义打架，见 `doc/syn-开发规范.md` §11.14。
//!
//! ## 为什么游标要声明类型
//!
//! 「水位」以字符串存（可能是时间戳、自增 ID、页码 token），但拼 SQL 时必须知道把它
//! 当什么类型比较：`(updated_at, id) > ($1, $2)` 里的 `$1` 没有类型上下文，PG 会直接
//! 报 `could not determine data type`。与其猜，不如让配置写明
//! [`CursorType`]，拼 SQL 时显式加 `::timestamptz` / `::int8` / `::text`。

use std::collections::BTreeMap;

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
    /// 分页地址模板（http）。占位符：`{cursor}`（页码或 token）、`{size}`（单页条数）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 下一页游标的取值路径（http）。有它就按 token 翻页，没有就按页码递增
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_path: Option<String>,
    /// 数据数组在响应里的取值路径（http）。缺省 `$`，即响应体本身是数组
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_path: Option<String>,
    /// 请求方法（http），缺省 GET
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// 请求头（http），鉴权用。**不进日志**
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
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

    /// # 数据数组的取值路径（http），缺省整个响应体
    pub fn data_path_or_root(&self) -> &str {
        self.data_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("$")
    }

    /// # 请求方法（http），缺省 GET
    pub fn method_or_get(&self) -> &str {
        self.method
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("GET")
    }

    /// # 是否按 token 翻页（给了 `next_path` 就是）
    pub fn token_paging(&self) -> bool {
        self.next_path
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
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
                // 两个路径都走 syn-core 的同一套解析（只认 `$.a.b[0]`），写错的后果是
                // 每页都取不到数据、全量立刻「完成」，比报错更难发现
                for (field, v) in [
                    ("spec.data_path", self.data_path.as_deref()),
                    ("spec.next_path", self.next_path.as_deref()),
                ] {
                    let Some(p) = v.map(str::trim).filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if !p.starts_with('$') {
                        issues.push(SpecIssue::new(
                            field,
                            SpecIssueKind::Invalid,
                            "取值路径要以 $ 开头，例如 $.data.list",
                        ));
                    }
                }
                if let Some(m) = self
                    .method
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    && !m.eq_ignore_ascii_case("get")
                    && !m.eq_ignore_ascii_case("post")
                {
                    issues.push(SpecIssue::new(
                        "spec.method",
                        SpecIssueKind::Invalid,
                        "只支持 GET / POST：全量取数是只读的",
                    ));
                }
                // 两种取数的字段混在一起，说明配置是复制来的半成品：按 http 跑会静默
                // 忽略这些字段，反过来按 sql 跑又缺游标列，早点报出来
                for (field, present) in [
                    ("spec.datasource", self.datasource.is_some()),
                    ("spec.select", self.select.is_some()),
                    ("spec.cursor_column", self.cursor_column.is_some()),
                ] {
                    if present {
                        issues.push(SpecIssue::new(
                            field,
                            SpecIssueKind::Conflict,
                            "http 取数不使用该字段：分页拉接口没有库表与游标列的概念",
                        ));
                    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check(v: serde_json::Value, kind: SourceKind) -> Vec<(String, SpecIssueKind)> {
        let spec = serde_json::from_value::<SourceSpec>(v).expect("spec 结构不合法");
        match spec.validate(kind) {
            Ok(()) => Vec::new(),
            Err(issues) => issues.into_iter().map(|i| (i.path, i.kind)).collect(),
        }
    }

    #[test]
    fn http_minimal_ok() {
        let issues = check(
            json!({ "url": "https://x/api?page={cursor}&size={size}" }),
            SourceKind::Http,
        );
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn http_url_required() {
        let issues = check(json!({ "page_size": 100 }), SourceKind::Http);
        assert_eq!(issues, vec![("spec.url".into(), SpecIssueKind::Missing)]);
    }

    #[test]
    fn http_paths_must_start_with_dollar() {
        let issues = check(
            json!({
                "url": "https://x/api?page={cursor}",
                "data_path": "data.list",
                "next_path": "data.next"
            }),
            SourceKind::Http,
        );
        let paths: Vec<&str> = issues.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"spec.data_path"), "{issues:?}");
        assert!(paths.contains(&"spec.next_path"), "{issues:?}");
        assert!(issues.iter().all(|(_, k)| *k == SpecIssueKind::Invalid));
    }

    #[test]
    fn http_rejects_write_methods() {
        let issues = check(
            json!({ "url": "https://x/api", "method": "PUT" }),
            SourceKind::Http,
        );
        assert_eq!(issues, vec![("spec.method".into(), SpecIssueKind::Invalid)]);
        // 大小写不敏感
        assert!(check(json!({ "url": "https://x", "method": "post" }), SourceKind::Http).is_empty());
    }

    #[test]
    fn http_rejects_sql_fields() {
        // 复制 sql 源的配置改成 http 时最容易留下这堆字段：按 http 跑会静默忽略，
        // 早点报 Conflict 比跑出「0 行」好查
        let issues = check(
            json!({
                "url": "https://x/api?page={cursor}",
                "datasource": "adm",
                "select": "select 1",
                "cursor_column": "id"
            }),
            SourceKind::Http,
        );
        let paths: Vec<&str> = issues.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths.len(), 3, "{issues:?}");
        assert!(paths.contains(&"spec.datasource"));
        assert!(paths.contains(&"spec.select"));
        assert!(paths.contains(&"spec.cursor_column"));
        assert!(issues.iter().all(|(_, k)| *k == SpecIssueKind::Conflict));
    }

    #[test]
    fn http_page_size_must_be_positive() {
        let issues = check(
            json!({ "url": "https://x", "page_size": 0 }),
            SourceKind::Http,
        );
        assert_eq!(issues, vec![("spec.page_size".into(), SpecIssueKind::Invalid)]);
    }

    #[test]
    fn sql_path_unaffected_by_http_rules() {
        let issues = check(
            json!({
                "datasource": "adm",
                "select": "select id, updated_at from t",
                "cursor_column": "updated_at, id"
            }),
            SourceKind::Sql,
        );
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn http_accessors_have_stable_defaults() {
        let spec = serde_json::from_value::<SourceSpec>(json!({ "url": "https://x" })).unwrap();
        assert_eq!(spec.data_path_or_root(), "$");
        assert_eq!(spec.method_or_get(), "GET");
        assert!(!spec.token_paging(), "没有 next_path 就是页码模式");
    }
}
