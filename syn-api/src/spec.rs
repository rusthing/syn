//! # 五段规则
//!
//! 一条记录的处理被拆成五段，每段都是一张表，段内没有分支：
//!
//! | 段 | 输入 → 输出 | 形态 |
//! |---|---|---|
//! | 匹配 [`Assert`] | 记录 → 是否命中 | 条件表，首命中即停 |
//! | 映射 [`Mapping`] | 记录 → 请求体 | 字段表 + 变换链 |
//! | 动作 [`Action`] | op → 一次 HTTP 调用 | 4 行矩阵 |
//! | 判定 [`Outcome`] | 响应 → 结论 | 有序规则表 |
//! | 校验 [`Guard`] | 请求体 → 放行/拒绝 | 断言表 |
//!
//! 五段之外的东西（传输层失败分类、重试、幂等、并发）**不在这里**，
//! 那些是执行器的固定语义，不可配置。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use utoipa::ToSchema;

use crate::issue::{SpecIssue, SpecIssueKind};

/// # 一个同步任务
///
/// 对应 `syn_task.spec`，整个结构一次性进 jsonb；`topic` / `priority` /
/// `enabled` 另外提成关系列建索引，避免每个请求都反序列化一遍全表。
///
/// ## 示例
///
/// ```yaml
/// id: dtw_region
/// topic: dtw.dtw_region
/// priority: 100
/// enabled: true
/// target: { service: dtw-rs-svr, base: /dtw/region }
/// match:
///   - { field: "$.op", op: in, value: [c, r, u, d] }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    /// 任务标识，与 `syn_task.code` 同值
    ///
    /// 库里以 `code` 列为准，`spec` 里可以不写；加载时用列值覆盖。
    #[serde(default)]
    pub id: String,
    /// 来源 topic（sink 侧 `topics` 里的名字）
    pub topic: String,
    /// 匹配优先级，升序；首个命中即停
    pub priority: i32,
    /// 停用后不参与匹配，但保留配置
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 下游地址，只有服务引用与相对路径，host 由服务发现给
    pub target: Target,
    /// 匹配条件（合取）。空表示该 topic 的记录全部命中
    #[serde(rename = "match", default)]
    pub match_conds: Vec<Assert>,
    /// 命中本任务后是否停止匹配后续任务
    ///
    /// 默认 `true`（首命中即停）。一个记录要同步到多个下游时，把前面的任务设为
    /// `exclusive: false`，让它执行完继续往下走 —— 这是「一份数据多处同步」的表达方式，
    /// 比在一个任务里堆多个动作清晰：每个下游有自己的映射、判定与死信分类。
    #[serde(default = "default_true")]
    pub exclusive: bool,
    /// 字段映射
    pub mapping: Mapping,
    /// op → 调用
    #[serde(default)]
    pub actions: Vec<Action>,
    /// 发送前守卫
    #[serde(default)]
    pub guards: Vec<Guard>,
    /// 响应判定，有序
    #[serde(default)]
    pub outcomes: Vec<Outcome>,
}

/// # 投递方式
///
/// 五段是纯函数，产出「一行要写出去的字段」；**怎么出去**由这里决定。
/// 两种方式的区别只在最后一步，匹配/映射/校验/判定四段完全共用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    /// 调下游 HTTP 接口（默认）
    #[default]
    Http,
    /// 直写下游库表（`insert ... on conflict`）
    Db,
}

/// # 冲突处理（DB 直写）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnConflict {
    /// 冲突时覆盖其余列（等价 upsert）。默认
    #[default]
    Update,
    /// 冲突时什么也不做（已有行原样保留）
    Nothing,
    /// 冲突时报错，交给判定段分类
    Error,
}

/// # 下游目标
///
/// `kind = http` 时只有 `service` / `base`，`service` 只作为服务发现/配置的键，
/// **不拼成 URL**；真正的 host 由执行器按环境解析，这样同一份配置在开发和线上都成立。
///
/// `kind = db` 时只有 `datasource` / `table` / `key` / `on_conflict`：
/// 表名与列名走白名单（启动时从 `information_schema` 读），值一律绑参数，
/// 绝不拼接 SQL 片段。
///
/// 两种形态共用一个结构而不是拆成 enum，是为了让「改投递方式」只改一个 `kind`
/// 字段 —— 拆 enum 会让 `<` 之外的字段全部消失，编辑器的表单也得多一套。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    /// 投递方式
    #[serde(default)]
    pub kind: TargetKind,
    /// 目标服务名，如 `dtw-rs-svr`（`kind = http` 必填）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub service: String,
    /// 路径前缀，必须以 `/` 开头（`kind = http` 必填）
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base: String,
    /// 数据源名，对应 `syn_datasource` 表的 `code`（`kind = db` 必填；
    /// 表里没有时回退 `[syn.datasources.<name>]`，见 `db_sink` 的模块文档）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datasource: Option<String>,
    /// 目标表，`schema.table` 或 `table`（`kind = db` 必填）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// 冲突键列（`kind = db` 必填）：`c` / `r` / `u` 走 `on conflict`，`d` 按它删除
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key: Vec<String>,
    /// 冲突处理方式
    #[serde(default)]
    pub on_conflict: OnConflict,
}

impl Default for Target {
    fn default() -> Self {
        Self {
            kind: TargetKind::Http,
            service: String::new(),
            base: String::new(),
            datasource: None,
            table: None,
            key: Vec::new(),
            on_conflict: OnConflict::Update,
        }
    }
}

/// # DB 直写目标（校验过的投影）
///
/// 从 [`Target`] 投影出来，字段保证非空且标识符合法。执行器只认这个结构，
/// 不再从 `Target` 里四处 `unwrap`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbTarget {
    /// 数据源名
    pub datasource: String,
    /// 目标表
    pub table: String,
    /// 冲突键列
    pub key: Vec<String>,
    /// 冲突处理方式
    pub on_conflict: OnConflict,
}

impl Target {
    /// 是否直写数据库
    pub fn is_db(&self) -> bool {
        self.kind == TargetKind::Db
    }

    /// 投影成 DB 目标。字段缺失或标识符非法时返回 `None`（保存时已校验，
    /// 这里再判一次是为了「库里存着老配置」的情况不 panic）
    pub fn db(&self) -> Option<DbTarget> {
        if !self.is_db() {
            return None;
        }
        let datasource = self.datasource.as_deref()?.trim();
        let table = self.table.as_deref()?.trim();
        if !is_qualified_ident(table) || self.key.is_empty() {
            return None;
        }
        if !self.key.iter().all(|k| is_ident(k)) {
            return None;
        }
        Some(DbTarget {
            datasource: datasource.to_string(),
            table: table.to_string(),
            key: self.key.clone(),
            on_conflict: self.on_conflict,
        })
    }
}

/// 小写标识符：`[a-z_][a-z0-9_]*`
fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `table` 或 `schema.table`
fn is_qualified_ident(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    matches!(parts.len(), 1 | 2) && parts.iter().all(|p| is_ident(p))
}

/// # 断言
///
/// 五段里所有条件都是这个形状：取值 + 操作符 + 期望值。
/// 没有嵌套布尔树，需要 OR 就加一行（匹配段则是加一个任务）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assert {
    /// JSONPath，如 `$.after.polygon_location.wkb`；`None` 表示对 HTTP 状态码断言
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// 操作符
    pub op: Operator,
    /// 期望值。`exists` / `absent` / `present` 不需要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    /// 取值来源。`None` 表示继承所在规则的作用域（匹配段恒为记录）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
}

/// # 操作符
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    /// 相等（数字按数值比较，`1` 等于 `1.0`）
    Eq,
    /// 不相等
    Ne,
    /// 属于集合
    In,
    /// 不属于集合
    NotIn,
    /// 路径存在且不为 null
    Exists,
    /// 路径不存在或为 null
    Absent,
    /// 存在且非空白字符串
    Present,
    /// 字符串前缀
    StartsWith,
    /// 字符串包含。**只用于分类型判定**，不用于流程控制
    Contains,
    /// 正则。同上，且编译失败按不匹配处理
    Regex,
    /// 数值大于
    Gt,
    /// 数值小于
    Lt,
}

impl Operator {
    /// 是否需要 `value`
    pub fn needs_value(self) -> bool {
        !matches!(self, Self::Exists | Self::Absent | Self::Present)
    }

    /// 是否是「文本散文匹配」类操作符。编辑器要为此类规则标黄，提示上游补错误码
    pub fn is_textual(self) -> bool {
        matches!(self, Self::Contains | Self::Regex)
    }
}

/// # 取值作用域
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// 原始变更记录（sink 送进来的 payload）
    Record,
    /// 映射之后的请求体
    Body,
    /// HTTP 状态码
    Status,
}

/// # 字段映射
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    /// 来源为 null 时整行省略。这是**全局**语义，不逐行配
    #[serde(default = "default_true")]
    pub omit_null: bool,
    /// 映射行
    pub rows: Vec<MappingRow>,
}

/// # 一行映射
///
/// `from` 与 `const` 二选一。变换链按顺序执行，前一个的输出是后一个的输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingRow {
    /// 目标字段名
    pub to: String,
    /// 取值路径
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// 常量
    #[serde(rename = "const", default, skip_serializing_if = "Option::is_none")]
    pub const_value: Option<Value>,
    /// 变换链，元素形如 `trim` 或 `truncate(100)`
    #[serde(rename = "fn", default, skip_serializing_if = "Vec::is_empty")]
    pub transforms: Vec<String>,
    /// 变换后为空时的处理
    #[serde(default)]
    pub on_empty: OnEmpty,
    /// 变换失败时的处理。`None` 表示按 fatal 处理（`TRANSFORM_ERROR`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<OnError>,
}

/// # 变换结果为空
///
/// 只在「经过变换链之后变成空」时生效；来源本身就是 null 走 [`Mapping::omit_null`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnEmpty {
    /// 原样写入空值（空串就发空串）。默认行为，与老脚本一致
    #[default]
    Keep,
    /// 回退到变换前的原值（去掉后缀去空了就别去）
    KeepOriginal,
    /// 省略该字段
    Omit,
    /// 写成 null
    Null,
}

/// # 变换失败
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnError {
    /// 结论，通常 `fatal`
    pub verdict: Verdict,
    /// 分类码，进死信
    pub code: String,
}

/// # 一次 HTTP 调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    /// 对应的变更操作，四种之一，必填
    ///
    /// 这不是「只能处理 CDC」：自拉数据（poll）的每一行本身就是快照读，
    /// 用 `r` 表达。四种之外的差异属于「另一个任务」，用 match 条件区分，
    /// 不要在同一个动作上挂条件 —— 那样同一件事会有两种配法。
    pub op: Op,
    /// 方法
    pub method: Method,
    /// 相对 `target.base` 的路径，可为空
    #[serde(default)]
    pub path: String,
    /// 请求体来源
    #[serde(default)]
    pub body: BodyMode,
    /// 查询参数
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub query: Vec<Binding>,
    /// 请求头
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<Header>,
}

/// # 变更操作
///
/// `R` 是快照读，**必须显式配置**，不能靠「没写就当 C」：
/// 下游区分不了快照重放时，两者的路径与语义可能不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    /// 新增
    C,
    /// 快照读
    R,
    /// 修改
    U,
    /// 删除
    D,
}

impl Op {
    /// 全部操作，用于校验动作矩阵是否完整
    pub const ALL: [Self; 4] = [Self::C, Self::R, Self::U, Self::D];

    /// 单字符表示
    pub fn as_str(self) -> &'static str {
        match self {
            Self::C => "c",
            Self::R => "r",
            Self::U => "u",
            Self::D => "d",
        }
    }
}

/// # HTTP 方法
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    /// POST
    Post,
    /// PUT
    Put,
    /// PATCH
    Patch,
    /// DELETE
    Delete,
    /// GET
    Get,
}

impl Method {
    /// 大写字符串
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Get => "GET",
        }
    }
}

/// # 请求体来源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyMode {
    /// 发送映射结果
    #[default]
    Mapped,
    /// 不发送
    None,
    /// 原样透传整条记录
    Raw,
}

/// # 字段绑定（query 参数）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    /// 参数名
    pub name: String,
    /// 取值路径
    pub from: String,
}

/// # 请求头绑定
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    /// 头名
    pub name: String,
    /// 取值路径
    pub from: String,
    /// 取不到时的兜底
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// # 发送前守卫
///
/// 只回答「这条能不能发」。断言默认对**记录**求值；要检查映射之后的请求体
/// （比如清洗完的姓名是否为空），在断言上写 `scope: body`。
///
/// 「这条要不要同步」属于匹配，「字段带不带」属于映射，都不在这里重复。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Guard {
    /// 适用条件，对记录求值；不满足则整条守卫跳过
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Assert>,
    /// 断言（合取）
    #[serde(rename = "assert")]
    pub asserts: Vec<Assert>,
    /// 不通过时的结论与文案
    pub on_fail: OnFail,
}

/// # 守卫不通过
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnFail {
    /// 结论，只允许 `fatal` / `skip`
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 人话消息，`{path}` 会被替换成实际值，直接进死信 detail
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// # 判定规则
///
/// 有序，第一条命中即停。最后一条必须是兜底（无 `field`），
/// 否则「响应不认识」会被静默当成功。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Outcome {
    /// 作用域，断言默认继承
    pub scope: Scope,
    /// 断言（合取）
    #[serde(rename = "assert")]
    pub asserts: Vec<Assert>,
    /// 结论
    pub verdict: Verdict,
    /// 分类码，进死信与前端「能否改报文重投」
    #[serde(default)]
    pub code: String,
}

/// # 结论
///
/// 执行器把结论翻译成给 sink 的 HTTP 状态码，**自己从不重试**：
/// 重试预算只存在于 sink 的 `http.retry.*`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// 成功，提交 offset
    Success,
    /// 跳过（快照重放的重复主键等噪音），提交 offset，记日志
    Skip,
    /// 确定性失败，直接进 DLQ
    Fatal,
    /// 可重试，翻译成 503 交还 sink
    Retriable,
}

impl Verdict {
    /// 返回给 sink 的 HTTP 状态码
    pub fn http_status(self) -> u16 {
        match self {
            Self::Success | Self::Skip => 200,
            Self::Fatal => 400,
            Self::Retriable => 503,
        }
    }

    /// 小写表示
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Skip => "skip",
            Self::Fatal => "fatal",
            Self::Retriable => "retriable",
        }
    }
}

/// # 变换名白名单
///
/// 封闭集合：新增变换要改代码发版，不允许从配置里演化。
/// 这是数据正确性的最后一道闸，配置层只能选、不能写。
pub const TRANSFORMS: [&str; 11] = [
    "trim",
    "strip_nul",
    "strip_suffix",
    "strip_prefix",
    "truncate",
    "to_bool_01",
    "wkb_to_wkt",
    "to_ms",
    "upper",
    "lower",
    "map_enum",
];

fn default_true() -> bool {
    true
}

impl TaskSpec {
    /// # 结构校验
    ///
    /// 只查「配置自相矛盾」，不查业务对错。返回的每条都带 `path`，
    /// 编辑器可以直接定位到单元格。
    pub fn validate(&self) -> Result<(), Vec<SpecIssue>> {
        let mut issues = Vec::new();

        if self.id.trim().is_empty() {
            issues.push(SpecIssue::new(
                "id",
                SpecIssueKind::Missing,
                "任务标识不能为空",
            ));
        }
        if self.topic.trim().is_empty() {
            issues.push(SpecIssue::new(
                "topic",
                SpecIssueKind::Missing,
                "topic 不能为空",
            ));
        }
        match self.target.kind {
            TargetKind::Http => {
                if self.target.service.trim().is_empty() {
                    issues.push(SpecIssue::new(
                        "target.service",
                        SpecIssueKind::Missing,
                        "目标服务不能为空：host 由服务发现提供，这里只写服务名",
                    ));
                }
                if !self.target.base.starts_with('/') {
                    issues.push(SpecIssue::new(
                        "target.base",
                        SpecIssueKind::Invalid,
                        "路径前缀必须以 / 开头",
                    ));
                }
            }
            TargetKind::Db => {
                if self
                    .target
                    .datasource
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    issues.push(SpecIssue::new(
                        "target.datasource",
                        SpecIssueKind::Missing,
                        "db 目标必须写数据源名（对应控制台里的数据源编码）",
                    ));
                }
                match self.target.table.as_deref() {
                    None => issues.push(SpecIssue::new(
                        "target.table",
                        SpecIssueKind::Missing,
                        "db 目标必须写目标表",
                    )),
                    Some(t) if !is_qualified_ident(t.trim()) => issues.push(SpecIssue::new(
                        "target.table",
                        SpecIssueKind::Invalid,
                        "表名只能是「表」或「模式.表」，小写字母/数字/下划线",
                    )),
                    Some(_) => {}
                }
                if self.target.key.is_empty() {
                    issues.push(SpecIssue::new(
                        "target.key",
                        SpecIssueKind::Missing,
                        "db 目标必须写冲突键：没有它无法 upsert，也无法删除",
                    ));
                }
                for (i, k) in self.target.key.iter().enumerate() {
                    if !is_ident(k) {
                        issues.push(SpecIssue::new(
                            format!("target.key[{i}]"),
                            SpecIssueKind::Invalid,
                            "键列名只能是小写字母/数字/下划线",
                        ));
                    }
                }
            }
        }

        self.validate_asserts("match", &self.match_conds, Scope::Record, &mut issues);
        self.validate_mapping(&mut issues);
        self.validate_actions(&mut issues);
        self.validate_guards(&mut issues);
        self.validate_outcomes(&mut issues);

        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }

    fn validate_asserts(
        &self,
        path: &str,
        asserts: &[Assert],
        default: Scope,
        issues: &mut Vec<SpecIssue>,
    ) {
        for (i, a) in asserts.iter().enumerate() {
            let at = format!("{path}[{i}]");
            let scope = a.scope.unwrap_or(default);
            // status 作用域断言的是状态码，带 field 一定是配错了
            if scope == Scope::Status && a.field.is_some() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    "status 作用域的断言不能带 field",
                ));
            }
            if scope != Scope::Status && a.field.as_deref().unwrap_or("").trim().is_empty() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Missing,
                    "该作用域的断言必须写 field",
                ));
            }
            if a.op.needs_value() && a.value.is_none() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Missing,
                    format!("操作符 {} 需要 value", op_name(a.op)),
                ));
            }
            if matches!(a.op, Operator::In | Operator::NotIn)
                && !a.value.as_ref().is_some_and(Value::is_array)
            {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Invalid,
                    "in / not_in 的 value 必须是数组",
                ));
            }
        }
    }

    fn validate_mapping(&self, issues: &mut Vec<SpecIssue>) {
        if self.mapping.rows.is_empty() {
            issues.push(SpecIssue::new(
                "mapping.rows",
                SpecIssueKind::Missing,
                "至少要有一行映射，否则请求体恒为空",
            ));
        }
        let mut seen = Vec::new();
        for (i, row) in self.mapping.rows.iter().enumerate() {
            let at = format!("mapping.rows[{i}]");
            if row.to.trim().is_empty() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Missing,
                    "目标字段不能为空",
                ));
            }
            if seen.contains(&row.to) {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    format!("目标字段 {} 重复", row.to),
                ));
            }
            seen.push(row.to.clone());

            match (row.from.is_some(), row.const_value.is_some()) {
                (true, true) => issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    "from 与 const 只能有一个",
                )),
                (false, false) => issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Missing,
                    "from 与 const 必须有一个",
                )),
                _ => {}
            }
            if row.const_value.is_some() && !row.transforms.is_empty() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    "常量行不需要变换：变换链会让常量失去「常量」的意义",
                ));
            }
            for (k, t) in row.transforms.iter().enumerate() {
                let name = t.split('(').next().unwrap_or("").trim();
                if !TRANSFORMS.contains(&name) {
                    issues.push(SpecIssue::new(
                        format!("{at}.fn[{k}]"),
                        SpecIssueKind::UnknownTransform,
                        format!("未注册的变换 {name}：变换是封闭集合，新增需改代码"),
                    ));
                }
            }
        }
    }

    fn validate_actions(&self, issues: &mut Vec<SpecIssue>) {
        if self.actions.is_empty() {
            issues.push(SpecIssue::new(
                "actions",
                SpecIssueKind::Missing,
                "至少要有一个动作，否则任务无法发出任何请求",
            ));
        }
        let mut seen: Vec<Op> = Vec::new();
        for (i, a) in self.actions.iter().enumerate() {
            let at = format!("actions[{i}]");
            if seen.contains(&a.op) {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    format!("op={} 重复", a.op.as_str()),
                ));
            }
            seen.push(a.op);
            if a.body == BodyMode::Mapped && self.mapping.rows.is_empty() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Conflict,
                    "body=mapped 但没有任何映射行",
                ));
            }
            if self.target.kind == TargetKind::Http
                && a.method == Method::Get
                && a.body != BodyMode::None
            {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Invalid,
                    "GET 不应带请求体",
                ));
            }
        }
        // 快照重放是最容易被漏掉的一条：漏了它，历史数据永远补不上，而且不报错
        if !seen.contains(&Op::R) {
            issues.push(SpecIssue::new(
                "actions",
                SpecIssueKind::Invalid,
                "未配置 r（快照读）动作，快照重放的记录会找不到动作",
            ));
        }
    }

    fn validate_guards(&self, issues: &mut Vec<SpecIssue>) {
        for (i, g) in self.guards.iter().enumerate() {
            let at = format!("guards[{i}]");
            if g.asserts.is_empty() {
                issues.push(SpecIssue::new(
                    &at,
                    SpecIssueKind::Missing,
                    "守卫没有断言，等于没写",
                ));
            }
            if !matches!(g.on_fail.verdict, Verdict::Fatal | Verdict::Skip) {
                issues.push(SpecIssue::new(
                    format!("{at}.on_fail.verdict"),
                    SpecIssueKind::Invalid,
                    "守卫的结论只能是 fatal 或 skip",
                ));
            }
            if let Some(w) = &g.when {
                self.validate_asserts(
                    &format!("{at}.when"),
                    std::slice::from_ref(w),
                    Scope::Record,
                    issues,
                );
            }
            self.validate_asserts(&format!("{at}.asserts"), &g.asserts, Scope::Record, issues);
        }
    }

    fn validate_outcomes(&self, issues: &mut Vec<SpecIssue>) {
        if self.outcomes.is_empty() {
            issues.push(SpecIssue::new(
                "outcomes",
                SpecIssueKind::Missing,
                "没有判定规则：响应将无法分类",
            ));
            return;
        }
        for (i, o) in self.outcomes.iter().enumerate() {
            self.validate_asserts(
                &format!("outcomes[{i}].asserts"),
                &o.asserts,
                o.scope,
                issues,
            );
        }
        let last = self.outcomes.last().expect("已判空");
        let is_fallback = last
            .asserts
            .iter()
            .all(|a| a.field.is_none() && matches!(a.op, Operator::In | Operator::Eq));
        if !is_fallback {
            issues.push(SpecIssue::new(
                format!("outcomes[{}]", self.outcomes.len() - 1),
                SpecIssueKind::Invalid,
                "最后一条必须是兜底规则（不带 field）：响应不认识时必须失败，不能静默成功",
            ));
        }
    }
}

impl Mapping {
    /// 空映射
    pub fn empty() -> Self {
        Self {
            omit_null: true,
            rows: Vec::new(),
        }
    }
}

/// 请求体类型别名，便于在签名里读
pub type Body = Map<String, Value>;

fn op_name(op: Operator) -> &'static str {
    match op {
        Operator::Eq => "eq",
        Operator::Ne => "ne",
        Operator::In => "in",
        Operator::NotIn => "not_in",
        Operator::Exists => "exists",
        Operator::Absent => "absent",
        Operator::Present => "present",
        Operator::StartsWith => "starts_with",
        Operator::Contains => "contains",
        Operator::Regex => "regex",
        Operator::Gt => "gt",
        Operator::Lt => "lt",
    }
}
