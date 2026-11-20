//! # 数据抽取的抽取定义
//!
//! 对应 `syn_source.spec`（JSONB）。`kind` 决定用哪半边，都是「数据从源端怎么来」：
//!
//! ```yaml
//! # kind = sql, mode = cursor：游标增量（推荐）
//! datasource: adm
//! mode: cursor
//! table: dtw_polygon                # 填 sql 时可省略
//! sql: select id, update_timestamp from dtw_polygon where deleted = false   # 可选：手写覆盖
//! cursor_field: update_timestamp     # 主游标：时间戳 / 自增 ID / 编码
//! cursor_type: timestamptz
//! tie_field: id                      # 决胜字段：必须唯一，解决同一时间戳并发写入
//! tie_type: bigint
//!
//! # kind = sql, mode = snapshot：全量快照（首次同步用）
//! datasource: adm
//! mode: snapshot
//! table: dtw_polygon
//! snapshot_batched: true             # true = 按 batch_size 分批拉完；false = 一条 SQL 拉全表
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
//! ## SQL 由系统生成，不再手写
//!
//! 原型只让人填「源表名 + 主游标 + 决胜字段」，SQL 由执行器按模板拼：
//!
//! ```sql
//! -- mode = cursor
//! SELECT * FROM dtw_polygon
//! WHERE (update_timestamp, id) > ($1::timestamptz, $2::bigint)
//! ORDER BY update_timestamp ASC, id ASC
//! LIMIT $3
//!
//! -- mode = snapshot（snapshot_batched = false）
//! SELECT * FROM dtw_polygon
//!
//! -- mode = snapshot（snapshot_batched = true）
//! SELECT * FROM dtw_polygon LIMIT $1 OFFSET $2
//! ```
//!
//! 表名与字段名在保存时按标识符白名单校验，拼 SQL 前再校验一次；值一律绑参数，
//! 没有字符串拼接用户输入。
//!
//! ## 为什么游标要声明类型
//!
//! 「水位」以字符串存（可能是时间戳、自增 ID、UUID），但拼 SQL 时必须知道把它
//! 当什么类型比较：`(update_timestamp, id) > ($1, $2)` 里的 `$1` 没有类型上下文，
//! PG 会直接报 `could not determine data type`。与其猜，不如让配置写明
//! [`FieldType`]，拼 SQL 时显式加 `::timestamptz` / `::int8` / `::uuid` / `::text`。
//!
//! ## 全量快照的完成语义
//!
//! 一轮调用内把整表拉完（分批模式在调用内循环翻页），游标写
//! `{"snapshot":{"done":true,"rows":n}}`，此后调度跳过；要重跑得显式 reset。
//! 与 http 全量一样**只用于首次同步**，增量交给游标模式或 dbz；两边同时写同一张表
//! 会让旧快照覆盖新值、删除语义打架，见 `doc/syn-开发规范.md` §11.14。
//!
//! ## http 为什么是「全量」而不是「增量」
//!
//! HTTP 接口一般只有页码或 token 分页，没有 `(updated_at, id)` 这种稳定水位：
//! 翻页中途源端插入会让第 2 页漏行或重复，游标 token 还会过期。所以 http 源按
//! **全量一次性**同步设计：第一轮从第 1 页开始，一轮推一页，翻到底写
//! `{"http":{"done":true}}`，此后调度跳过；要重跑得显式 reset。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dic::SourceKind;
use crate::issue::{SpecIssue, SpecIssueKind};

/// # 抽取模式（`kind = sql` 时）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractMode {
    /// 游标增量：按 `(主游标, 决胜字段)` 复合游标一批一批往前推
    #[default]
    Cursor,
    /// 全量快照：把整表拉一遍，拉完标记完成
    Snapshot,
}

/// # 游标 / 决胜字段的类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    /// 整数列（自增 ID、毫秒时间戳）
    #[default]
    Bigint,
    /// 时间戳列（`timestamp` / `timestamptz`）
    Timestamptz,
    /// UUID 列
    Uuid,
    /// 文本列（编码）
    Varchar,
}

impl FieldType {
    /// 拼 SQL 用的类型名
    pub fn cast(self) -> &'static str {
        match self {
            Self::Bigint => "int8",
            Self::Timestamptz => "timestamptz",
            Self::Uuid => "uuid",
            Self::Varchar => "text",
        }
    }

    /// 能否做主游标：UUID 单调性不可依赖
    pub fn allowed_for_cursor(self) -> bool {
        !matches!(self, Self::Uuid)
    }

    /// 能否做决胜字段：时间戳不唯一，不能决胜
    pub fn allowed_for_tie(self) -> bool {
        !matches!(self, Self::Timestamptz)
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

/// # 抽取定义
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceSpec {
    /// 源库的数据源名，对应 `syn_datasource` 表的 `code`
    /// （表里没有时回退 `[syn.datasources.<name>]`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datasource: Option<String>,
    /// sql 的抽取模式：游标增量 / 全量快照
    #[serde(default)]
    pub mode: ExtractMode,
    /// 源表名，允许 `schema.table`。填了 `sql` 时可省略
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// 手写 SQL（可选）：填了就用它当行来源，表名不再必填。
    /// 必须是单条 select / with；输出里要包含主游标字段与决胜字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// 主游标字段（时间戳 / 自增 ID / 编码），游标增量必填
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_field: Option<String>,
    /// 主游标字段的类型
    #[serde(default)]
    pub cursor_type: FieldType,
    /// 决胜字段（必须唯一），游标增量必填
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tie_field: Option<String>,
    /// 决胜字段的类型
    #[serde(default)]
    pub tie_type: FieldType,
    /// 全量快照是否分批拉：true = 按 `batch_size` 循环翻页，false = 一条 SQL 拉全表
    #[serde(default)]
    pub snapshot_batched: bool,
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
    /// 单源拉取超时（humantime，如 `10s` / `1m`）。留空用全局 `[syn] pull-timeout`
    ///
    /// 慢源（大表全量、慢接口）单独放宽，**不拖累同一次心跳里的其它源**；
    /// 写错的值不会生效，保存时由 [`Self::validate`] 报出来。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_duration: Option<String>,
}

impl SourceSpec {
    /// # 解析
    pub fn parse(value: &Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value.clone())
    }

    /// # 源表名（已去空白）
    pub fn table_or_empty(&self) -> &str {
        self.table
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
    }

    /// # 手写 SQL（已去空白与结尾分号），没填就是空
    pub fn custom_sql(&self) -> Option<&str> {
        self.sql
            .as_deref()
            .map(str::trim)
            .map(|s| s.trim_end_matches(';').trim())
            .filter(|s| !s.is_empty())
    }

    /// # 这个源自己的拉取超时
    ///
    /// 留空或写错都返回 `None`：调用方回落到全局 `[syn] pull-timeout`，
    /// 不因为一个手滑的值让整轮取数无限等下去。
    pub fn timeout(&self) -> Option<Duration> {
        self.timeout_duration
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| humantime::parse_duration(s).ok())
    }

    /// # 复合游标的两列：`[主游标, 决胜字段]`（已去空白，缺失的省略）
    pub fn cursor_fields(&self) -> Vec<&str> {
        [self.cursor_field.as_deref(), self.tie_field.as_deref()]
            .into_iter()
            .flatten()
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

        // 单源超时是可选项，但写了就必须能解析：写错值运行时只会静默回落全局值，
        // 界面却显示「已经单独配过」，属于最难查的那类不一致，所以在保存时就拦下
        if let Some(raw) = self
            .timeout_duration
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && humantime::parse_duration(raw).is_err()
        {
            issues.push(SpecIssue::new(
                "spec.timeout_duration",
                SpecIssueKind::Invalid,
                "拉取超时要写成 humantime 形式，例如 10s / 1m / 500ms",
            ));
        }

        match kind {
            SourceKind::Sql => {
                // 只有库表抽取才需要数据源连接；http 分页取数走 URL，没有 datasource 的概念
                if self.datasource.as_deref().unwrap_or("").trim().is_empty() {
                    issues.push(SpecIssue::new(
                        "spec.datasource",
                        SpecIssueKind::Missing,
                        "库表抽取必须写数据源名（对应控制台里的数据源编码）",
                    ));
                }

                // `sql` 存在即「手写模式」：空串是「切到手写但还没填」，报 Missing 而不是
                // 悄悄回退到表名，否则界面显示手写、实际按表名跑，最难查
                if self.sql.is_some() {
                    match self.custom_sql() {
                        None => issues.push(SpecIssue::new(
                            "spec.sql",
                            SpecIssueKind::Missing,
                            "手写 SQL 不能为空；不想手写就切回按表名生成",
                        )),
                        Some(sql) if !is_single_select(sql) => issues.push(SpecIssue::new(
                            "spec.sql",
                            SpecIssueKind::Invalid,
                            "手写 SQL 只能是单条 select / with，不能带分号或写操作",
                        )),
                        Some(_) => {}
                    }
                } else {
                    match self.table_or_empty() {
                        "" => issues.push(SpecIssue::new(
                            "spec.table",
                            SpecIssueKind::Missing,
                            "必须写源表名或手写 SQL：取数语句按它生成",
                        )),
                        table if !is_qualified_ident(table) => issues.push(SpecIssue::new(
                            "spec.table",
                            SpecIssueKind::Invalid,
                            "表名只能用字母（大小写）/数字/下划线，可用 schema.table",
                        )),
                        _ => {}
                    }
                }

                if self.mode == ExtractMode::Cursor {
                    let cursor = self.cursor_field.as_deref().unwrap_or("").trim();
                    let tie = self.tie_field.as_deref().unwrap_or("").trim();

                    if cursor.is_empty() {
                        issues.push(SpecIssue::new(
                            "spec.cursor_field",
                            SpecIssueKind::Missing,
                            "游标增量必须写主游标字段（时间戳 / 自增 ID）",
                        ));
                    } else if !is_ident(cursor) {
                        issues.push(SpecIssue::new(
                            "spec.cursor_field",
                            SpecIssueKind::Invalid,
                            "字段名只能用字母（大小写）/数字/下划线",
                        ));
                    }
                    if tie.is_empty() {
                        issues.push(SpecIssue::new(
                            "spec.tie_field",
                            SpecIssueKind::Missing,
                            "游标增量必须写决胜字段：同一主游标值靠它排出唯一顺序",
                        ));
                    } else if !is_ident(tie) {
                        issues.push(SpecIssue::new(
                            "spec.tie_field",
                            SpecIssueKind::Invalid,
                            "字段名只能用字母（大小写）/数字/下划线",
                        ));
                    }
                    if !cursor.is_empty() && cursor == tie {
                        issues.push(SpecIssue::new(
                            "spec.tie_field",
                            SpecIssueKind::Conflict,
                            "决胜字段必须与主游标字段不同",
                        ));
                    }
                    if !self.cursor_type.allowed_for_cursor() {
                        issues.push(SpecIssue::new(
                            "spec.cursor_type",
                            SpecIssueKind::Invalid,
                            "主游标不支持 uuid：UUID 没有可依赖的单调顺序",
                        ));
                    }
                    if !self.tie_type.allowed_for_tie() {
                        issues.push(SpecIssue::new(
                            "spec.tie_type",
                            SpecIssueKind::Invalid,
                            "决胜字段不支持 timestamptz：时间戳不唯一，无法决胜",
                        ));
                    }
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
                // 忽略这些字段，反过来按 sql 跑又缺表名，早点报出来
                for (field, present) in [
                    ("spec.datasource", self.datasource.is_some()),
                    ("spec.table", self.table.is_some()),
                    ("spec.sql", self.sql.is_some()),
                    ("spec.cursor_field", self.cursor_field.is_some()),
                    ("spec.tie_field", self.tie_field.is_some()),
                ] {
                    if present {
                        issues.push(SpecIssue::new(
                            field,
                            SpecIssueKind::Conflict,
                            "http 取数不使用该字段：分页拉接口没有库表与游标字段的概念",
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

/// 源库标识符（表名 / 字段名）。大小写都收：工业库、从别的系统迁过来的库常有
/// `WS_DEVICE` / `UPDATE_TIME` 这类大写名字。拼 SQL 时按方言包引号，大小写原样保留
/// （见 `syn-svr` 的 `quote_table` / `quote_col`），所以这里只挡引号与分号等注入字符。
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `table` 或 `schema.table`，两段都必须是合法标识符
fn is_qualified_ident(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    !parts.is_empty() && parts.len() <= 2 && parts.iter().all(|p| is_ident(p))
}

/// 手写 SQL 的底线：单条 `select` / `with`，去掉结尾分号后内部不能再有分号。
/// 不做语法解析 —— 真正的校验是「立即拉取」时源库报错。
fn is_single_select(sql: &str) -> bool {
    let s = sql.trim().trim_end_matches(';').trim();
    let first = s.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    matches!(first.as_str(), "select" | "with") && !s.contains(';')
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

    fn cursor_spec() -> serde_json::Value {
        json!({
            "datasource": "adm",
            "mode": "cursor",
            "table": "dtw_polygon",
            "cursor_field": "update_timestamp",
            "cursor_type": "timestamptz",
            "tie_field": "id",
            "tie_type": "bigint"
        })
    }

    #[test]
    fn cursor_minimal_ok() {
        assert!(check(cursor_spec(), SourceKind::Sql).is_empty());
    }

    #[test]
    fn cursor_requires_table_and_fields() {
        let issues = check(
            json!({ "datasource": "adm", "mode": "cursor" }),
            SourceKind::Sql,
        );
        let paths: Vec<&str> = issues.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"spec.table"), "{issues:?}");
        assert!(paths.contains(&"spec.cursor_field"), "{issues:?}");
        assert!(paths.contains(&"spec.tie_field"), "{issues:?}");
    }

    #[test]
    fn cursor_rejects_same_field_and_bad_types() {
        let mut v = cursor_spec();
        v["tie_field"] = json!("update_timestamp");
        v["cursor_type"] = json!("uuid");
        v["tie_type"] = json!("timestamptz");
        let issues = check(v, SourceKind::Sql);
        let paths: Vec<&str> = issues.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"spec.tie_field"), "{issues:?}");
        assert!(paths.contains(&"spec.cursor_type"), "{issues:?}");
        assert!(paths.contains(&"spec.tie_type"), "{issues:?}");
    }

    #[test]
    fn table_must_be_identifier() {
        let mut v = cursor_spec();
        v["table"] = json!("dtw_polygon; drop table x");
        assert_eq!(
            check(v, SourceKind::Sql),
            vec![("spec.table".into(), SpecIssueKind::Invalid)]
        );
        // schema.table 允许
        let mut ok = cursor_spec();
        ok["table"] = json!("public.dtw_polygon");
        assert!(check(ok, SourceKind::Sql).is_empty());
    }

    #[test]
    fn table_and_fields_accept_uppercase() {
        // 源库是从别的系统迁过来的：表名、列名都是大写，按真实名字填必须能保存
        let mut v = cursor_spec();
        v["table"] = json!("WS_DEVICE");
        v["cursor_field"] = json!("UPDATE_TIME");
        v["tie_field"] = json!("ID");
        assert!(check(v, SourceKind::Sql).is_empty());

        // schema 段同样收大写
        let mut qualified = cursor_spec();
        qualified["table"] = json!("CRM.WS_DEVICE");
        assert!(check(qualified, SourceKind::Sql).is_empty());

        // 放松大小写不等于放松字符集：引号、分号、空格仍旧拒绝
        let mut quoted = cursor_spec();
        quoted["table"] = json!("\"WS_DEVICE\"");
        assert!(
            check(quoted, SourceKind::Sql)
                .iter()
                .any(|(p, _)| p == "spec.table")
        );
    }

    #[test]
    fn snapshot_only_needs_table() {
        assert!(
            check(
                json!({ "datasource": "adm", "mode": "snapshot", "table": "dtw_polygon" }),
                SourceKind::Sql
            )
            .is_empty()
        );
        assert!(
            check(
                json!({ "datasource": "adm", "mode": "snapshot" }),
                SourceKind::Sql
            )
            .iter()
            .any(|(p, _)| p == "spec.table")
        );
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
        assert!(
            check(
                json!({ "url": "https://x", "method": "post" }),
                SourceKind::Http
            )
            .is_empty()
        );
    }

    #[test]
    fn custom_sql_replaces_table() {
        let mut v = cursor_spec();
        v.as_object_mut().unwrap().remove("table");
        v["sql"] = json!("select id, update_timestamp from dtw_polygon where deleted = false;");
        assert!(check(v, SourceKind::Sql).is_empty());
    }

    #[test]
    fn empty_custom_sql_is_missing_not_fallback_to_table() {
        let mut v = cursor_spec();
        v["sql"] = json!("");
        assert_eq!(
            check(v, SourceKind::Sql),
            vec![("spec.sql".into(), SpecIssueKind::Missing)]
        );
    }

    #[test]
    fn custom_sql_must_be_single_select() {
        let mut v = cursor_spec();
        v["sql"] = json!("update dtw_polygon set deleted = true");
        assert_eq!(
            check(v, SourceKind::Sql),
            vec![("spec.sql".into(), SpecIssueKind::Invalid)]
        );
        // 分号拼多条同样不行（结尾的分号会先被去掉，这个不算）
        let mut multi = cursor_spec();
        multi["sql"] = json!("select 1; drop table dtw_polygon");
        assert!(check(multi, SourceKind::Sql)
            .iter()
            .any(|(p, _)| p == "spec.sql"));
    }

    #[test]
    fn http_rejects_sql_fields() {
        // 复制 sql 源的配置改成 http 时最容易留下这堆字段：按 http 跑会静默忽略，
        // 早点报 Conflict 比跑出「0 行」好查
        let issues = check(
            json!({
                "url": "https://x/api?page={cursor}",
                "datasource": "adm",
                "table": "t",
                "sql": "select 1",
                "cursor_field": "id",
                "tie_field": "seq"
            }),
            SourceKind::Http,
        );
        let paths: Vec<&str> = issues.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths.len(), 5, "{issues:?}");
        assert!(paths.contains(&"spec.datasource"));
        assert!(paths.contains(&"spec.table"));
        assert!(paths.contains(&"spec.sql"));
        assert!(paths.contains(&"spec.cursor_field"));
        assert!(paths.contains(&"spec.tie_field"));
        assert!(issues.iter().all(|(_, k)| *k == SpecIssueKind::Conflict));
    }

    #[test]
    fn http_page_size_must_be_positive() {
        let issues = check(
            json!({ "url": "https://x", "page_size": 0 }),
            SourceKind::Http,
        );
        assert_eq!(
            issues,
            vec![("spec.page_size".into(), SpecIssueKind::Invalid)]
        );
    }

    #[test]
    fn sql_path_unaffected_by_http_rules() {
        assert!(check(cursor_spec(), SourceKind::Sql).is_empty());
    }

    #[test]
    fn http_accessors_have_stable_defaults() {
        let spec = serde_json::from_value::<SourceSpec>(json!({ "url": "https://x" })).unwrap();
        assert_eq!(spec.data_path_or_root(), "$");
        assert_eq!(spec.method_or_get(), "GET");
        assert!(!spec.token_paging(), "没有 next_path 就是页码模式");
    }

    #[test]
    fn cursor_fields_are_trimmed_and_optional() {
        let spec = serde_json::from_value::<SourceSpec>(cursor_spec()).unwrap();
        assert_eq!(spec.cursor_fields(), vec!["update_timestamp", "id"]);
        let snapshot =
            serde_json::from_value::<SourceSpec>(json!({ "mode": "snapshot" })).unwrap();
        assert!(snapshot.cursor_fields().is_empty());
        assert_eq!(snapshot.mode, ExtractMode::Snapshot);
    }
}
