//! # 执行编排
//!
//! 一次 `execute` 就是一条记录走完五段。顺序固定，短路点固定：
//!
//! ```text
//! 启用? → 匹配 → 映射 → 校验 → 选动作 → 发送 → 判定
//!    ↓否    ↓不命中  ↓失败   ↓拒绝    ↓没有    ↓IO 错   ↓规则
//!   skip   skip   fatal   fatal   fatal  retriable
//! ```
//!
//! 短路之后**立刻返回**，不再尝试后面的段。这样每条失败只有一个明确的原因，
//! 死信里能看到到底是哪一段把它挡下来的。

use serde_json::{Map, Value};
use syn_api::{BodyMode, Method, Op, Scope, Target, TaskSpec, Verdict};

use crate::assertion::{Context, eval};
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
    /// 任务标识
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
            task: spec.id.clone(),
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

    let request = render(spec, record, &prepared.body, base_url, prepared.action);

    let response = match transport.send(&request).await {
        Ok(r) => r,
        Err(e) => {
            return Execution {
                task: spec.id.clone(),
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
/// 与 [`execute`] 共用前四段，只把最后一步换成写库。判定段照常生效：写库成功合成一个
/// `200 + {"affected": n}` 的响应，所以「一行都没写进去」可以用 `$.affected eq 0` 表达。
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
            task: spec.id.clone(),
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

/// # 前四段：启用 → 匹配 → 映射 → 校验 → 选动作
///
/// 两种投递共用这一段。短路点固定，失败立刻返回，保证一条记录只有一个失败原因。
struct Prepared<'a> {
    /// 选中的动作
    action: &'a syn_api::Action,
    /// 变更操作
    op: Op,
    /// 映射后的请求体 / 待写行
    body: Map<String, Value>,
}

// `Execution` 带请求/响应快照，体积大；这里只在进程内传一次，装箱反而多一次分配
#[allow(clippy::result_large_err)]
fn prepare<'a>(spec: &'a TaskSpec, record: &Value) -> Result<Prepared<'a>, Execution> {
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
        .find(|a| !eval(a, &ctx, Scope::Record))
    {
        return Err(Execution::stop(
            spec,
            Verdict::Skip,
            "no_match",
            Stage::Match,
            format!(
                "{} 不满足 {}",
                failed.field.as_deref().unwrap_or("-"),
                op_label(failed)
            ),
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
    for guard in &spec.guards {
        if let Some(w) = &guard.when
            && !eval(w, &ctx, Scope::Record)
        {
            continue;
        }
        let guard_ctx = ctx.with_body(&mapped.body);
        // 守卫默认看记录，看请求体要显式 scope: body
        if let Some(failed) = guard
            .asserts
            .iter()
            .find(|a| !eval(a, &guard_ctx, Scope::Record))
        {
            let message = guard.on_fail.message.clone().unwrap_or_else(|| {
                format!(
                    "{} 不满足 {}",
                    failed.field.as_deref().unwrap_or("-"),
                    op_label(failed)
                )
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

    // 4 选动作
    let Some(op) = op_of(record) else {
        return Err(Execution::stop(
            spec,
            Verdict::Fatal,
            "NO_OP",
            Stage::Action,
            "记录缺少 op 或取值不合法",
        ));
    };
    let Some(action) = spec.actions.iter().find(|a| a.op == op) else {
        return Err(Execution::stop(
            spec,
            Verdict::Fatal,
            "NO_ACTION_FOR_OP",
            Stage::Action,
            format!("未配置 op={} 的动作", op.as_str()),
        ));
    };

    Ok(Prepared {
        action,
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
        task: spec.id.clone(),
        verdict: judgement.verdict,
        code: judgement.code.clone(),
        stage: Stage::Verdict,
        detail: judgement
            .fallback
            .then(|| "响应未命中任何规则，按失败处理".to_string()),
        body: Some(body),
        request: Some(request),
        response: Some(response),
        judgement: Some(judgement),
    }
}

fn render(
    spec: &TaskSpec,
    record: &Value,
    body: &Map<String, Value>,
    base_url: &str,
    action: &syn_api::Action,
) -> HttpRequest {
    let mut url = join_url(base_url, &spec.target, &action.path);

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
    spec.match_conds
        .iter()
        .all(|a| eval(a, &ctx, Scope::Record))
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
            "id": "dtw_region", "topic": "dtw.dtw_region", "priority": 100, "enabled": true,
            "target": {"service": "dtw-rs-svr", "base": "/dtw/region"},
            "match": [{"field": "$.op", "op": "in", "value": ["c", "r", "u", "d"]}],
            "mapping": {"omit_null": true, "rows": [
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
    fn db_spec() -> TaskSpec {
        let mut spec = region_spec();
        spec.target = Target {
            kind: syn_api::TargetKind::Db,
            datasource: Some("dtw".into()),
            table: Some("public.dtw_region".into()),
            key: vec!["id".into()],
            ..Target::default()
        };
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
    async fn db_zero_affected_can_be_skip() {
        // 「没写进去任何行」由判定段表达，不需要为 db 另造一套语义
        let mut spec = db_spec();
        spec.outcomes.insert(
            0,
            syn_api::Outcome {
                scope: Scope::Body,
                asserts: vec![syn_api::Assert {
                    field: Some("$.affected".into()),
                    op: syn_api::Operator::Eq,
                    value: Some(serde_json::json!(0)),
                    scope: None,
                }],
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
}
