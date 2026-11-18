//! # 执行编排
//!
//! 一条记录先走完共用的四段，再按 `target.kind` 分岔。顺序固定，短路点固定：
//!
//! ```text
//! 启用? → 匹配 → 映射 → 校验 → ┬─ http：选动作 → 发送 → 判定
//!    ↓否    ↓不命中  ↓失败   ↓拒绝 └─ db  ：写库        → 判定
//!   skip   skip   fatal   fatal        ↓没有动作 / IO 错  ↓规则
//!                                      fatal | retriable
//! ```
//!
//! db 直写**没有动作段**：`op` 由记录自带（`c` / `r` / `u` 走 upsert，`d` 走删除），
//! 写库形状由 `target.on_conflict` 决定，动作里的 method / path / query / headers
//! 一个都不参与。判定段的输入也不是下游响应，而是写库结果的合成响应
//! `200 + {"affected": n}` —— 所以 db 任务的判定只能看 `$.affected`，
//! 保存期由 `TaskSpec::validate` 拦掉其它写法。
//!
//! 短路之后**立刻返回**，不再尝试后面的段。这样每条失败只有一个明确的原因，
//! 死信里能看到到底是哪一段把它挡下来的。

use serde_json::{Map, Value};
use syn_api::{BodyMode, Condition, Method, Op, Scope, Target, TaskSpec, Verdict};

use crate::assertion::{Context, eval, eval_all, eval_condition};
use crate::mapping::map;
use crate::db::DbWriter;
use crate::transport::{HttpRequest, HttpResponse, Transport};
use crate::verdict::{Judgement, judge};

/// # 结论产生的阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// 匹配
    Match,
    /// 映射
    Mapping,
    /// 校验
    Guard,
    /// 动作选择/渲染
    Action,
    /// 传输
    Transport,
    /// 判定
    Verdict,
}

impl Stage {
    /// 小写表示，进日志与死信
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::Mapping => "mapping",
            Self::Guard => "guard",
            Self::Action => "action",
            Self::Transport => "transport",
            Self::Verdict => "verdict",
        }
    }
}

/// # 一次执行的结果
///
/// 这个结构就是「试跑」面板要的所有东西：请求、响应、请求体、命中的规则。
/// 线上也是同一个结构，只是不落库。
#[derive(Debug, Clone)]
pub struct Execution {
    /// 任务主键，落台账用
    pub task_id: i64,
    /// 任务名称，进日志与结果回显
    pub task: String,
    /// 最终结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 在哪一段得出结论
    pub stage: Stage,
    /// 补充说明（失败原因、守卫消息）
    pub detail: Option<String>,
    /// 映射后的请求体
    pub body: Option<Map<String, Value>>,
    /// 实际发出的请求
    pub request: Option<HttpRequest>,
    /// 下游响应
    pub response: Option<HttpResponse>,
    /// 判定命中情况
    pub judgement: Option<Judgement>,
}

impl Execution {
    /// 返回给 sink 的 HTTP 状态码
    pub fn http_status(&self) -> u16 {
        self.verdict.http_status()
    }

    /// # 构造一个「短路」结论
    ///
    /// 执行器在幂等命中时也要产出一个 `Execution`，否则 fanout 汇总会少一项。
    /// 公开给 svr 用，字段仍然只读：调用方不能自己编一个带 response 的假结果。
    pub fn stop(
        spec: &TaskSpec,
        verdict: Verdict,
        code: impl Into<String>,
        stage: Stage,
        detail: impl Into<String>,
    ) -> Self {
        let detail = detail.into();
        Self {
            task_id: spec.id,
            task: spec.name.clone(),
            verdict,
            code: code.into(),
            stage,
            detail: if detail.is_empty() {
                None
            } else {
                Some(detail)
            },
            body: None,
            request: None,
            response: None,
            judgement: None,
        }
    }
}

/// # 执行一条记录（HTTP 投递）
///
/// `base_url` 是 `target.service` 解析出来的真实地址，由调用方（执行器）按环境给；
/// 引擎不查服务发现，也不读全局配置。
pub async fn execute<T: Transport + ?Sized>(
    spec: &TaskSpec,
    record: &Value,
    base_url: &str,
    transport: &T,
) -> Execution {
    let prepared = match prepare(spec, record) {
        Ok(p) => p,
        Err(stop) => return stop,
    };

    // 动作是 http 出口自己的东西：db 直写不读它（见 `execute_db`）
    let Some(action) = spec.actions.iter().find(|a| a.op == prepared.op) else {
        return Execution::stop(
            spec,
            Verdict::Fatal,
            "NO_ACTION_FOR_OP",
            Stage::Action,
            format!("未配置 op={} 的动作", prepared.op.as_str()),
        );
    };

    let request = render(spec, record, &prepared.body, base_url, action);

    let response = match transport.send(&request).await {
        Ok(r) => r,
        Err(e) => {
            return Execution {
                task_id: spec.id,
                task: spec.name.clone(),
                verdict: Verdict::Retriable,
                code: format!("TRANSPORT_{}", e.kind.as_str()),
                stage: Stage::Transport,
                detail: Some(e.detail),
                body: Some(prepared.body),
                request: Some(request),
                response: None,
                judgement: None,
            };
        }
    };

    finish(spec, prepared.body, request, response)
}

/// # 执行一条记录（DB 直写）
///
/// 与 [`execute`] 共用前四段，然后**跳过动作段直接写库**：`op` 由记录自带，
/// 写库形状由 `target.on_conflict` 决定，动作里的 method / path / query / headers
/// 在这条链路上没有任何消费者（db 任务的 `actions` 必须为空，保存期就拦）。
///
/// 判定段照常跑，但输入是写库结果的合成响应 `200 + {"affected": n}` —— 不是下游响应。
/// 因此 db 任务的判定只能看 `$.affected`：「一行都没写进去」用 `$.affected eq 0` 表达。
/// 拿 status 或响应体其它字段写规则，在保存期就会被 `TaskSpec::validate` 拒掉。
///
/// 伪 URL `db://<数据源>/<表>` 只服务于试跑面板与日志 —— 让人一眼看出这条记录打算写哪儿，
/// 不参与任何真实请求。
pub async fn execute_db<D: DbWriter + ?Sized>(
    spec: &TaskSpec,
    record: &Value,
    writer: &D,
) -> Execution {
    let prepared = match prepare(spec, record) {
        Ok(p) => p,
        Err(stop) => return stop,
    };

    let Some(target) = spec.target.db() else {
        return Execution::stop(
            spec,
            Verdict::Fatal,
            "TARGET_NOT_DB",
            Stage::Action,
            "target.kind 不是 db，或 datasource/table/key 缺失",
        );
    };

    let preview = HttpRequest {
        method: Method::Post,
        url: format!("db://{}/{}", target.datasource, target.table),
        headers: Vec::new(),
        body: Some(Value::Object(prepared.body.clone())),
    };

    match writer.write(&target, prepared.op, &prepared.body).await {
        Ok(affected) => {
            let response = HttpResponse {
                status: 200,
                body: serde_json::json!({ "affected": affected }),
            };
            finish(spec, prepared.body, preview, response)
        }
        Err(e) => Execution {
            task_id: spec.id,
            task: spec.name.clone(),
            verdict: if e.retriable {
                Verdict::Retriable
            } else {
                Verdict::Fatal
            },
            code: e.code,
            stage: Stage::Transport,
            detail: Some(e.detail),
            body: Some(prepared.body),
            request: Some(preview),
            response: None,
            judgement: None,
        },
    }
}

/// # 前四段：启用 → 匹配 → 映射 → 校验 → 取变更操作
///
/// 两种投递共用这一段，**不含动作选择**：动作只在 http 出口存在，db 直写不要它。
/// 短路点固定，失败立刻返回，保证一条记录只有一个失败原因。
struct Prepared {
    /// 变更操作：http 用来挑动作，db 用来决定 upsert / 删除
    op: Op,
    /// 映射后的请求体 / 待写行
    body: Map<String, Value>,
}

// `Execution` 带请求/响应快照，体积大；这里只在进程内传一次，装箱反而多一次分配
#[allow(clippy::result_large_err)]
fn prepare(spec: &TaskSpec, record: &Value) -> Result<Prepared, Execution> {
    if !spec.enabled {
        return Err(Execution::stop(
            spec,
            Verdict::Skip,
            "disabled",
            Stage::Match,
            "任务已停用",
        ));
    }

    // 1 匹配
    let ctx = Context::of(record);
    if let Some(failed) = spec
        .match_conds
        .iter()
        .find(|c| !eval_condition(c, &ctx, Scope::Record))
    {
        return Err(Execution::stop(
            spec,
            Verdict::Skip,
            "no_match",
            Stage::Match,
            format!("{} 不满足", condition_label(failed)),
        ));
    }

    // 2 映射
    let mapped = match map(spec, record) {
        Ok(m) => m,
        Err(f) => {
            return Err(Execution::stop(
                spec,
                f.verdict,
                f.code,
                Stage::Mapping,
                format!("{}: {}", f.field, f.detail),
            ));
        }
    };

    // 3 校验
    // 守卫的断言与门槛都能看请求体：`when` 的 scope 显式写 body 时也要生效，
    // 否则这种配置会被静默跳过（守卫等于没配），排查起来极难
    let guard_ctx = ctx.with_body(&mapped.body);
    for guard in &spec.guards {
        if let Some(w) = &guard.when
            && !eval(w, &guard_ctx, Scope::Record)
        {
            continue;
        }
        // 守卫默认看记录，看请求体要显式 scope: body
        if let Some(failed) = guard
            .asserts
            .iter()
            .find(|c| !eval_condition(c, &guard_ctx, Scope::Record))
        {
            let message = guard.on_fail.message.clone().unwrap_or_else(|| {
                format!("{} 不满足", condition_label(failed))
            });
            return Err(Execution::stop(
                spec,
                guard.on_fail.verdict,
                guard.on_fail.code.clone(),
                Stage::Guard,
                message,
            ));
        }
    }

    // 4 取变更操作
    // op 是记录自带的（sink 或 poll 写进来的 `c` / `r` / `u` / `d`），不是动作上的字段。
    // http 拿它挑动作，db 拿它决定 upsert 还是删除；缺 op 谁都发不出去。
    let Some(op) = op_of(record) else {
        return Err(Execution::stop(
            spec,
            Verdict::Fatal,
            "NO_OP",
            Stage::Action,
            "记录缺少 op 或取值不合法",
        ));
    };

    Ok(Prepared {
        op,
        body: mapped.body,
    })
}

/// # 最后一段：判定 + 组装结果
fn finish(
    spec: &TaskSpec,
    body: Map<String, Value>,
    request: HttpRequest,
    response: HttpResponse,
) -> Execution {
    let judgement = judge(spec, response.status, &response.body);
    Execution {
        task_id: spec.id,
        task: spec.name.clone(),
        verdict: judgement.verdict,
        code: judgement.code.clone(),
        stage: Stage::Verdict,
        detail: verdict_detail(&judgement, &response),
        body: Some(body),
        request: Some(request),
        response: Some(response),
        judgement: Some(judgement),
    }
}

/// 判定段的说明文字
///
/// 走兜底时是配置没覆盖到这条响应；命中规则时也不能留空 —— 死信里只剩
/// `business_error / HTTP 400`，排障必须去翻对端日志才知道是「createrId不能为空」。
/// 把响应摘要带上，`syn_delivery_log.detail` 与 `syn_cursor.last_error` 才有可读原因。
///
/// 成功 / 跳过不写：那两种结论没有排障价值，写了只会把明细表刷满。
fn verdict_detail(judgement: &Judgement, response: &HttpResponse) -> Option<String> {
    if judgement.fallback {
        return Some("响应未命中任何规则，按失败处理".to_string());
    }
    if !matches!(judgement.verdict, Verdict::Fatal | Verdict::Retriable) {
        return None;
    }
    Some(format!(
        "HTTP {}: {}",
        response.status,
        body_digest(&response.body)
    ))
}

/// 响应体摘要的字符上限。死信是给人看的，不是存档，超长就截断
const BODY_DIGEST_CHARS: usize = 300;

/// 响应体 → 一行可读摘要；非 JSON 的响应在传输层已包成 `{"raw": "..."}`
fn body_digest(body: &Value) -> String {
    let text = body.to_string();
    if text.chars().count() <= BODY_DIGEST_CHARS {
        return text;
    }
    let mut out: String = text.chars().take(BODY_DIGEST_CHARS).collect();
    out.push('…');
    out
}

fn render(
    spec: &TaskSpec,
    record: &Value,
    body: &Map<String, Value>,
    base_url: &str,
    action: &syn_api::Action,
) -> HttpRequest {
    let expanded_path = expand_path(&action.path, &action.path_bindings, record);
    let mut url = join_url(base_url, &spec.target, &expanded_path);

    let mut query = Vec::new();
    for q in &action.query {
        // 取不到值、或者值为 null 都不拼进 query：`?a=null` 和「没传 a」在下游是两件事
        if let Some(v) = crate::value::get_path(record, &q.from)
            && !v.is_null()
        {
            query.push((q.name.clone(), scalar(v)));
        }
    }
    if !query.is_empty() {
        let qs = query
            .iter()
            .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&qs);
    }

    let mut headers = Vec::new();
    for h in &action.headers {
        let v = crate::value::get_path(record, &h.from)
            .filter(|v| !v.is_null())
            .map(scalar)
            .or_else(|| h.default.clone());
        if let Some(v) = v {
            headers.push((h.name.clone(), v));
        }
    }

    let body = match action.body {
        BodyMode::None => None,
        BodyMode::Mapped => Some(Value::Object(body.clone())),
        BodyMode::Raw => Some(record.clone()),
    };

    HttpRequest {
        method: action.method,
        url,
        headers,
        body,
    }
}

/// # 展开路径占位符
///
/// `path` 里的 `{name}` 按 `path_bindings` 同名绑定取记录值并按路径段编码；
/// 未声明绑定、取不到值或为 null 的占位符保留原样，避免拼出半截 URL。
fn expand_path(path: &str, bindings: &[syn_api::Binding], record: &Value) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('}') else {
            // 没有配对的闭括号：按字面量收尾
            out.push_str(rest);
            return out;
        };
        let name = &after_open[..close];
        let resolved = bindings
            .iter()
            .find(|b| b.name == name)
            .and_then(|b| crate::value::get_path(record, &b.from))
            .filter(|v| !v.is_null());
        match resolved {
            Some(v) => out.push_str(&encode(&scalar(v))),
            None => out.push_str(&rest[open..open + 1 + close + 1]),
        }
        rest = &after_open[close + 1..];
    }
    out.push_str(rest);
    out
}

fn join_url(base_url: &str, target: &Target, path: &str) -> String {
    let mut url = String::with_capacity(base_url.len() + target.base.len() + path.len() + 1);
    url.push_str(base_url.trim_end_matches('/'));
    url.push_str(target.base.trim_end_matches('/'));
    if !path.is_empty() {
        if !path.starts_with('/') {
            url.push('/');
        }
        url.push_str(path);
    }
    url
}

fn op_of(record: &Value) -> Option<Op> {
    match record.get("op").and_then(Value::as_str)? {
        "c" => Some(Op::C),
        "r" => Some(Op::R),
        "u" => Some(Op::U),
        "d" => Some(Op::D),
        _ => None,
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn op_label(a: &syn_api::Assert) -> String {
    format!("{:?}", a.op).to_lowercase()
}

/// 失败描述。分组没有唯一「失败原因」，只给分组名，避免把 OR 里某条未命中
/// 说成整条规则失败的原因。
fn condition_label(c: &Condition) -> String {
    match c {
        Condition::Assert(a) => format!(
            "{} {}",
            a.field.as_deref().unwrap_or("status"),
            op_label(a)
        ),
        Condition::All(_) => "全部分组".into(),
        Condition::Any(_) => "任意分组".into(),
        Condition::Not(_) => "取反分组".into(),
    }
}

/// 最小百分号编码：只保留 unreserved，其余全部转义。
///
/// 不引 `percent-encoding` 是因为这里只有 query 的键值，规则简单且必须有单测固定。
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// # 只做匹配
///
/// 服务端要在「一个 topic 多个任务」里选出该由谁执行，选的时候不能有副作用，
/// 所以匹配单独暴露出来。
pub fn matches(spec: &TaskSpec, record: &Value) -> bool {
    if !spec.enabled {
        return false;
    }
    let ctx = Context::of(record);
    eval_all(&spec.match_conds, &ctx, Scope::Record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbError;
    use crate::transport::{HttpResponse, TransportError, TransportErrorKind};
    use syn_api::DbTarget;
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// 记录请求、返回固定响应的传输
    struct Mock {
        status: u16,
        body: Value,
        fail: Option<TransportErrorKind>,
        last: Mutex<Option<HttpRequest>>,
    }

    impl Mock {
        fn new(status: u16, body: Value) -> Self {
            Self {
                status,
                body,
                fail: None,
                last: Mutex::new(None),
            }
        }

        fn failing(kind: TransportErrorKind) -> Self {
            Self {
                status: 0,
                body: Value::Null,
                fail: Some(kind),
                last: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl Transport for Mock {
        async fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
            *self.last.lock().unwrap() = Some(req.clone());
            match self.fail {
                Some(kind) => Err(TransportError::new(kind, "boom")),
                None => Ok(HttpResponse {
                    status: self.status,
                    body: self.body.clone(),
                }),
            }
        }
    }

    fn region_spec() -> TaskSpec {
        serde_json::from_value(serde_json::json!({
            "topic": "dtw.dtw_region", "sort_order": 100, "enabled": true,
            "target": {"service": "dtw-rs-svr", "base": "/dtw/region"},
            "match": [{"field": "$.op", "op": "in", "value": ["c", "r", "u", "d"]}],
            "mapping": {"rows": [
                {"to": "id", "from": "$.after.id"},
                {"to": "name", "from": "$.after.name", "fn": ["strip_suffix(\"电子围栏区\")", "trim"], "on_empty": "keep_original"},
                {"to": "geom", "from": "$.after.polygon_location.wkb", "fn": ["wkb_to_wkt"], "on_error": {"verdict": "fatal", "code": "WKB_INVALID"}},
                {"to": "tags", "const": "|电子围栏|"},
                {"to": "updaterId", "from": "$.after.updator_id"}
            ]},
            "actions": [
                {"op": "c", "method": "POST", "path": "/upsert", "headers": [{"name": "X-User-Id", "from": "$.after.updator_id", "default": "0"}]},
                {"op": "u", "method": "POST", "path": "/sync", "headers": [{"name": "X-User-Id", "from": "$.after.updator_id", "default": "0"}]},
                {"op": "d", "method": "DELETE", "path": "", "body": "none", "query": [{"name": "id", "from": "$.before.id"}]}
            ],
            "guards": [
                {"when": {"field": "$.op", "op": "ne", "value": "d"},
                 "assert": [{"field": "$.after", "op": "exists"}, {"field": "$.after.polygon_location.wkb", "op": "present"}],
                 "on_fail": {"verdict": "fatal", "code": "POLYGON_MISSING", "message": "几何为空"}}
            ],
            "outcomes": [
                {"scope": "body", "assert": [{"field": "$.extra.code", "op": "eq", "value": "RTW00001"}], "verdict": "skip", "code": "duplicate"},
                {"scope": "body", "assert": [{"field": "$.extra.code", "op": "eq", "value": "RTW00002"}], "verdict": "fatal", "code": "fk_missing"},
                {"scope": "status", "assert": [{"op": "in", "value": [200, 201]}], "verdict": "success"}
            ]
        }))
        .unwrap()
    }

    fn ok_record() -> Value {
        serde_json::json!({
            "op": "c",
            "after": {
                "id": 8821,
                "name": "一号电子围栏区",
                "updator_id": 2002,
                "polygon_location": {"wkb": "010300000001000000050000001B2FDD2406195D406ABC749318F44340C520B07268195D406ABC749318F44340C520B07268195D40DBF97E6ABCF443401B2FDD2406195D40DBF97E6ABCF443401B2FDD2406195D406ABC749318F44340"}
            }
        })
    }

    #[tokio::test]
    async fn happy_path_renders_request() {
        let mock = Mock::new(200, serde_json::json!({"result": 0}));
        let ex = execute(&region_spec(), &ok_record(), "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Success);
        assert_eq!(ex.http_status(), 200);
        let req = ex.request.unwrap();
        assert_eq!(req.url, "http://gw/dtw/region/upsert");
        // 原脚本的 after.UPDATOR_ID 大写取不到，这里必须是真实值
        assert_eq!(req.headers[0].1, "2002");
        let body = req.body.unwrap();
        assert_eq!(body.get("name"), Some(&serde_json::json!("一号")));
        assert_eq!(body.get("tags"), Some(&serde_json::json!("|电子围栏|")));
    }

    #[tokio::test]
    async fn rule_hit_failure_keeps_downstream_reason() {
        // `fk_missing` 是规则命中（不是兜底），detail 以前被判成 None：
        // 死信里只剩一个 code，排障必须去翻对端日志才知道下游说了什么。
        let mock = Mock::new(
            400,
            serde_json::json!({"result": -1, "extra": {"code": "RTW00002"}, "msg": "createrId不能为空"}),
        );
        let ex = execute(&region_spec(), &ok_record(), "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        let detail = ex.detail.expect("规则命中也要留下可读原因");
        assert!(detail.starts_with("HTTP 400: "), "{detail}");
        assert!(detail.contains("createrId不能为空"), "{detail}");
    }

    #[tokio::test]
    async fn success_has_no_detail() {
        let mock = Mock::new(200, serde_json::json!({"result": 0}));
        let ex = execute(&region_spec(), &ok_record(), "http://gw", &mock).await;
        assert!(ex.detail.is_none(), "{:?}", ex.detail);
    }

    #[tokio::test]
    async fn duplicate_response_is_skip() {
        let mock = Mock::new(
            200,
            serde_json::json!({"result": -1, "extra": {"code": "RTW00001"}}),
        );
        let ex = execute(&region_spec(), &ok_record(), "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Skip);
        assert_eq!(ex.code, "duplicate");
    }

    #[tokio::test]
    async fn guard_blocks_before_sending() {
        let mock = Mock::new(200, serde_json::json!({}));
        let rec =
            serde_json::json!({"op": "c", "after": {"id": 1, "polygon_location": {"wkb": null}}});
        let ex = execute(&region_spec(), &rec, "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "POLYGON_MISSING");
        assert_eq!(ex.stage, Stage::Guard);
        assert!(
            mock.last.lock().unwrap().is_none(),
            "守卫拦下时不应发出请求"
        );
    }

    #[tokio::test]
    async fn guard_when_can_gate_on_mapped_body() {
        let mut spec = region_spec();
        // `when` 显式 scope: body 时必须看映射后的请求体；否则这条守卫会被静默跳过
        spec.guards = vec![syn_api::Guard {
            when: Some(syn_api::Assert {
                field: Some("$.tags".to_string()),
                op: syn_api::Operator::Eq,
                value: Some(serde_json::json!("|电子围栏|")),
                scope: Some(Scope::Body),
            }),
            asserts: vec![Condition::Assert(syn_api::Assert {
                field: Some("$.after.missing".to_string()),
                op: syn_api::Operator::Exists,
                value: None,
                scope: None,
            })],
            on_fail: syn_api::OnFail {
                verdict: Verdict::Fatal,
                code: "BODY_GATE".to_string(),
                message: None,
            },
        }];

        let mock = Mock::new(200, serde_json::json!({}));
        let ex = execute(&spec, &ok_record(), "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "BODY_GATE");
        assert_eq!(ex.stage, Stage::Guard);
        assert!(mock.last.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn broken_wkb_is_mapping_failure() {
        let mock = Mock::new(200, serde_json::json!({}));
        let mut rec = ok_record();
        rec["after"]["polygon_location"]["wkb"] = serde_json::json!("BADDATA");
        let ex = execute(&region_spec(), &rec, "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "WKB_INVALID");
        assert_eq!(ex.stage, Stage::Mapping);
    }

    #[tokio::test]
    async fn delete_uses_before_and_query() {
        let mock = Mock::new(200, serde_json::json!({"result": 0}));
        let rec = serde_json::json!({"op": "d", "before": {"id": 8821}});
        let ex = execute(&region_spec(), &rec, "http://gw", &mock).await;
        let req = ex.request.unwrap();
        assert_eq!(req.method, syn_api::Method::Delete);
        assert_eq!(req.url, "http://gw/dtw/region?id=8821");
        assert!(req.body.is_none());
    }

    #[tokio::test]
    async fn not_matched_is_skip() {
        let mock = Mock::new(200, serde_json::json!({}));
        let rec = serde_json::json!({"op": "x"});
        let ex = execute(&region_spec(), &rec, "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Skip);
        assert_eq!(ex.code, "no_match");
    }

    #[tokio::test]
    async fn transport_error_is_retriable() {
        let mock = Mock::failing(TransportErrorKind::Timeout);
        let ex = execute(&region_spec(), &ok_record(), "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Retriable);
        assert_eq!(ex.code, "TRANSPORT_TIMEOUT");
        assert_eq!(ex.http_status(), 503);
    }

    #[tokio::test]
    async fn missing_action_is_fatal() {
        let mock = Mock::new(200, serde_json::json!({}));
        // 快照读 op=r 没配动作：守卫通过之后才应该报 NO_ACTION_FOR_OP
        let mut rec = ok_record();
        rec["op"] = serde_json::json!("r");
        let ex = execute(&region_spec(), &rec, "http://gw", &mock).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "NO_ACTION_FOR_OP");
        assert_eq!(ex.stage, Stage::Action);
    }

    /// 记录写入、按预设返回影响行数或失败的 DB 实现
    #[allow(clippy::type_complexity)]
    struct MockDb {
        affected: u64,
        fail: Option<DbError>,
        last: Mutex<Option<(String, String, Op, Map<String, Value>)>>,
    }

    impl MockDb {
        fn new(affected: u64) -> Self {
            Self {
                affected,
                fail: None,
                last: Mutex::new(None),
            }
        }

        fn failing(e: DbError) -> Self {
            Self {
                affected: 0,
                fail: Some(e),
                last: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl DbWriter for MockDb {
        async fn write(
            &self,
            target: &DbTarget,
            op: Op,
            row: &Map<String, Value>,
        ) -> Result<u64, DbError> {
            *self.last.lock().unwrap() = Some((
                target.datasource.clone(),
                target.table.clone(),
                op,
                row.clone(),
            ));
            match &self.fail {
                Some(e) => Err(e.clone()),
                None => Ok(self.affected),
            }
        }
    }

    /// 把 region_spec 改成直写 `dtw.dtw_region`
    ///
    /// 顺带把动作清空、判定换成只看 `$.affected`：这才是 db 任务合法的形状
    /// （保存期就是这么校验的，见 `TaskSpec::validate`）。
    fn db_spec() -> TaskSpec {
        let mut spec = region_spec();
        spec.target = Target {
            kind: syn_api::TargetKind::Db,
            datasource: Some("dtw".into()),
            table: Some("public.dtw_region".into()),
            key: vec!["id".into()],
            ..Target::default()
        };
        // db 直写没有动作段：op 由记录自带
        spec.actions.clear();
        spec.outcomes = vec![
            syn_api::Outcome {
                scope: Scope::Body,
                asserts: vec![syn_api::Condition::Assert(syn_api::Assert {
                    field: Some("$.affected".into()),
                    op: syn_api::Operator::Gte,
                    value: Some(serde_json::json!(1)),
                    scope: None,
                })],
                verdict: Verdict::Success,
                code: "db_ok".into(),
            },
            // 兜底：affected 不是正数就别当成功（空断言 = 无 field 的兜底）
            syn_api::Outcome {
                scope: Scope::Body,
                asserts: vec![],
                verdict: Verdict::Fatal,
                code: "no_row".into(),
            },
        ];
        spec
    }

    #[tokio::test]
    async fn db_target_writes_mapped_row() {
        let db = MockDb::new(1);
        let ex = execute_db(&db_spec(), &ok_record(), &db).await;
        assert_eq!(ex.verdict, Verdict::Success);
        let (ds, table, op, row) = db.last.lock().unwrap().clone().unwrap();
        assert_eq!(ds, "dtw");
        assert_eq!(table, "public.dtw_region");
        assert_eq!(op, Op::C);
        // mapping 的 to 就是列名，值原样给过去（不含 HTTP 那套 query/header）
        assert_eq!(row.get("name"), Some(&serde_json::json!("一号")));
        assert_eq!(row.get("tags"), Some(&serde_json::json!("|电子围栏|")));
        // 试跑面板要能显示「写哪儿」
        assert_eq!(ex.request.unwrap().url, "db://dtw/public.dtw_region");
    }

    #[tokio::test]
    async fn db_target_needs_no_action_at_all() {
        // 动作清空后照样能写库：db 链路上「动作」没有消费者，op 来自记录本身
        let db = MockDb::new(1);
        let spec = db_spec();
        assert!(spec.actions.is_empty(), "db 任务不应带动作");
        let ex = execute_db(&spec, &ok_record(), &db).await;
        assert_eq!(ex.verdict, Verdict::Success);
        assert_eq!(ex.code, "db_ok");
    }

    #[tokio::test]
    async fn db_record_without_op_is_fatal() {
        // op 是记录自带的：缺了它，写库连 upsert 还是删除都定不了。
        // 这里把 match 段清空，让记录真的走到第 4 步，否则会先按 no_match 跳过。
        let db = MockDb::new(1);
        let mut spec = db_spec();
        spec.match_conds.clear();
        let mut record = ok_record();
        record.as_object_mut().unwrap().remove("op");
        let ex = execute_db(&spec, &record, &db).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "NO_OP");
        assert_eq!(ex.stage, Stage::Action);
        assert!(db.last.lock().unwrap().is_none(), "没 op 就不该碰库");
    }

    #[tokio::test]
    async fn db_zero_affected_can_be_skip() {
        // 「没写进去任何行」由判定段表达，不需要为 db 另造一套语义
        let mut spec = db_spec();
        spec.outcomes.insert(
            0,
            syn_api::Outcome {
                scope: Scope::Body,
                asserts: vec![syn_api::Condition::Assert(syn_api::Assert {
                    field: Some("$.affected".into()),
                    op: syn_api::Operator::Eq,
                    value: Some(serde_json::json!(0)),
                    scope: None,
                })],
                verdict: Verdict::Skip,
                code: "no_change".into(),
            },
        );
        let ex = execute_db(&spec, &ok_record(), &MockDb::new(0)).await;
        assert_eq!(ex.verdict, Verdict::Skip);
        assert_eq!(ex.code, "no_change");
    }

    #[tokio::test]
    async fn db_constraint_error_is_fatal() {
        let db = MockDb::failing(DbError::fatal("DB_CONSTRAINT", "23503 fk 不存在"));
        let ex = execute_db(&db_spec(), &ok_record(), &db).await;
        assert_eq!(ex.verdict, Verdict::Fatal);
        assert_eq!(ex.code, "DB_CONSTRAINT");
        assert_eq!(ex.http_status(), 400);
    }

    #[tokio::test]
    async fn db_connection_error_is_retriable() {
        let db = MockDb::failing(DbError::retriable("DB_CONNECT", "连接超时"));
        let ex = execute_db(&db_spec(), &ok_record(), &db).await;
        assert_eq!(ex.verdict, Verdict::Retriable);
        assert_eq!(ex.http_status(), 503);
    }

    #[test]
    fn url_join_handles_slashes() {
        let t = Target {
            service: "s".into(),
            base: "/dtw/region".into(),
            ..Target::default()
        };
        assert_eq!(
            join_url("http://gw/", &t, "/upsert"),
            "http://gw/dtw/region/upsert"
        );
        assert_eq!(join_url("http://gw", &t, ""), "http://gw/dtw/region");
        assert_eq!(
            join_url("http://gw", &t, "sync"),
            "http://gw/dtw/region/sync"
        );
    }

    #[test]
    fn path_placeholder_expands_from_record() {
        let record = serde_json::json!({"op": "d", "before": {"id": 1594890099385042366u64}});
        let bindings = vec![syn_api::Binding {
            name: "id".into(),
            from: "$.before.id".into(),
        }];
        let expanded = expand_path("/{id}", &bindings, &record);
        assert_eq!(expanded, "/1594890099385042366");
    }

    #[test]
    fn path_placeholder_missing_value_is_left_intact() {
        let record = serde_json::json!({"op": "d", "before": {"id": null}});
        let bindings = vec![syn_api::Binding {
            name: "id".into(),
            from: "$.before.id".into(),
        }];
        let expanded = expand_path("/{id}", &bindings, &record);
        assert_eq!(expanded, "/{id}");

        // 未声明绑定的占位符原样保留
        let expanded = expand_path("/{id}", &[], &record);
        assert_eq!(expanded, "/{id}");
    }

    #[test]
    fn path_placeholder_value_is_encoded() {
        let record = serde_json::json!({"code": "桂 B/45303"});
        let bindings = vec![syn_api::Binding {
            name: "code".into(),
            from: "$.code".into(),
        }];
        let expanded = expand_path("/{code}", &bindings, &record);
        assert_eq!(expanded, "/%E6%A1%82%20B%2F45303");
    }
}
