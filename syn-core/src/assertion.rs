//! # 条件求值
//!
//! 五段里的所有条件最终都走这里。叶子断言 = 取值 + 操作符 + 期望值；
//! `all` / `any` / `not` 只是布尔分组，没有函数调用、没有表达式字符串 ——
//! 这是「配置」与「脚本」的分界线。
//!
//! 数字比较按数值走（`1` 等于 `1.0`）：JSON 里这两种写法在不同生产者手里
//! 都常见，按字面量比会莫名其妙地判不等。

use serde_json::{Map, Value};
use syn_api::{Assert, Condition, Operator, Scope};

use crate::value::{get_path, get_path_in_map};

/// # 求值上下文
///
/// 三段作用域共用一份上下文，缺哪段就是 `None`。这样同一个 [`eval`]
/// 既能判匹配（只有 record）、也能判守卫（record + body）、还能判响应
/// （status + body），不必为每段复制一套比较逻辑。
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// 原始变更记录
    pub record: &'a Value,
    /// 映射后的请求体
    pub body: Option<&'a Map<String, Value>>,
    /// 下游返回的状态码
    pub status: Option<u16>,
}

impl<'a> Context<'a> {
    /// 只有记录
    pub fn of(record: &'a Value) -> Self {
        Self {
            record,
            body: None,
            status: None,
        }
    }

    /// 补上请求体
    pub fn with_body(mut self, body: &'a Map<String, Value>) -> Self {
        self.body = Some(body);
        self
    }

    /// 补上状态码
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }
}

/// # 求值一棵条件
///
/// 三段的条件数组都是隐式 AND 根节点，元素既可以是叶子断言，也可以是分组。
/// 分组只做布尔组合，不含任何副作用，所以递归深度由保存期的校验兜住。
pub fn eval_condition(cond: &Condition, ctx: &Context<'_>, default_scope: Scope) -> bool {
    match cond {
        Condition::Assert(a) => eval(a, ctx, default_scope),
        Condition::All(g) => g.all.iter().all(|c| eval_condition(c, ctx, default_scope)),
        Condition::Any(g) => g.any.iter().any(|c| eval_condition(c, ctx, default_scope)),
        Condition::Not(g) => !eval_condition(g.not.as_ref(), ctx, default_scope),
    }
}

/// 顶层条件数组：全部满足才算通过
pub fn eval_all(conds: &[Condition], ctx: &Context<'_>, default_scope: Scope) -> bool {
    conds.iter().all(|c| eval_condition(c, ctx, default_scope))
}

/// # 求值一条断言
///
/// `default_scope` 是断言没写 `scope` 时的作用域：匹配段是 `record`，
/// 判定段跟随规则，守卫是 `body`。
pub fn eval(assert: &Assert, ctx: &Context<'_>, default_scope: Scope) -> bool {
    let scope = assert.scope.unwrap_or(default_scope);
    match scope {
        Scope::Status => {
            // 带 field 的 status 断言是配置错误，validate 会拦；真跑到这里按不匹配处理
            if assert.field.is_some() {
                return false;
            }
            eval_value(assert, ctx.status.map(Value::from).as_ref())
        }
        Scope::Record => {
            let lhs = assert
                .field
                .as_deref()
                .and_then(|p| get_path(ctx.record, p));
            eval_value(assert, lhs)
        }
        Scope::Body => {
            let lhs = assert
                .field
                .as_deref()
                .and_then(|p| ctx.body.and_then(|b| get_path_in_map(b, p)));
            eval_value(assert, lhs)
        }
    }
}

/// 取不到（`None`）与取到 `null` 都按 null 处理，但 `exists` / `absent` 区分两者
fn eval_value(assert: &Assert, lhs: Option<&Value>) -> bool {
    let expected = assert.value.as_ref();
    let null = Value::Null;
    let value = lhs.unwrap_or(&null);

    match assert.op {
        Operator::Exists => matches!(lhs, Some(v) if !v.is_null()),
        Operator::Absent => !matches!(lhs, Some(v) if !v.is_null()),
        Operator::Present => match lhs {
            Some(Value::String(s)) => !s.trim().is_empty(),
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::Object(o)) => !o.is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => true,
        },
        Operator::Eq => expected.is_some_and(|e| json_eq(value, e)),
        Operator::Ne => expected.is_some_and(|e| !json_eq(value, e)),
        Operator::In => expected
            .and_then(Value::as_array)
            .is_some_and(|arr| arr.iter().any(|e| json_eq(value, e))),
        Operator::NotIn => expected
            .and_then(Value::as_array)
            .is_some_and(|arr| !arr.iter().any(|e| json_eq(value, e))),
        Operator::StartsWith => {
            let (Some(Value::String(s)), Some(p)) = (lhs, expected.and_then(Value::as_str)) else {
                return false;
            };
            s.starts_with(p)
        }
        Operator::Contains => {
            let Some(needle) = expected.and_then(Value::as_str) else {
                return false;
            };
            text_of(value).is_some_and(|s| s.contains(needle))
        }
        Operator::Regex => {
            let Some(pattern) = expected.and_then(Value::as_str) else {
                return false;
            };
            // 正则编译失败按不匹配处理：配置写错了不该让整条记录的处理崩掉
            let Ok(re) = regex::Regex::new(pattern) else {
                return false;
            };
            text_of(value).is_some_and(|s| re.is_match(&s))
        }
        Operator::Gt => num_pair(value, expected).is_some_and(|(a, b)| a > b),
        Operator::Gte => num_pair(value, expected).is_some_and(|(a, b)| a >= b),
        Operator::Lt => num_pair(value, expected).is_some_and(|(a, b)| a < b),
        Operator::Lte => num_pair(value, expected).is_some_and(|(a, b)| a <= b),
    }
}

/// 数值相等，其余按 JSON 相等
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn num_pair(a: &Value, b: Option<&Value>) -> Option<(f64, f64)> {
    Some((a.as_f64()?, b?.as_f64()?))
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec() -> Value {
        json!({"op": "c", "after": {"id": 8821, "name": "一号围栏", "gw": null}})
    }

    fn check(field: &str, op: Operator, value: Option<Value>) -> bool {
        let r = rec();
        let a = Assert {
            field: Some(field.to_string()),
            op,
            value,
            scope: None,
        };
        eval(&a, &Context::of(&r), Scope::Record)
    }

    #[test]
    fn equality_coerces_numbers() {
        assert!(check("$.after.id", Operator::Eq, Some(json!(8821))));
        assert!(check("$.after.id", Operator::Eq, Some(json!(8821.0))));
        assert!(!check("$.after.id", Operator::Eq, Some(json!(8822))));
    }

    #[test]
    fn membership() {
        assert!(check("$.op", Operator::In, Some(json!(["c", "r"]))));
        assert!(!check("$.op", Operator::In, Some(json!(["u"]))));
    }

    #[test]
    fn existence_vs_null() {
        assert!(check("$.after.id", Operator::Exists, None));
        // 键存在但值是 null：exists 不成立，absent 成立
        assert!(!check("$.after.gw", Operator::Exists, None));
        assert!(check("$.after.gw", Operator::Absent, None));
        assert!(check("$.nope", Operator::Absent, None));
    }

    #[test]
    fn present_ignores_blank() {
        assert!(check("$.after.name", Operator::Present, None));
        assert!(!check("$.after.gw", Operator::Present, None));
    }

    #[test]
    fn numeric_compare() {
        assert!(check("$.after.id", Operator::Gt, Some(json!(8000))));
        assert!(check("$.after.id", Operator::Lt, Some(json!(9000))));
        // 非数字不参与比较
        assert!(!check("$.after.name", Operator::Gt, Some(json!(1))));
    }

    #[test]
    fn text_matchers_degrade_safely() {
        assert!(check(
            "$.after.name",
            Operator::Contains,
            Some(json!("围栏"))
        ));
        assert!(check("$.op", Operator::StartsWith, Some(json!("c"))));
        // 非法正则不 panic，直接不匹配
        assert!(!check(
            "$.after.name",
            Operator::Regex,
            Some(json!("[unclosed"))
        ));
    }

    #[test]
    fn status_scope() {
        let r = rec();
        let a = Assert {
            field: None,
            op: Operator::In,
            value: Some(json!([200, 201])),
            scope: Some(Scope::Status),
        };
        assert!(eval(&a, &Context::of(&r).with_status(200), Scope::Body));
        assert!(!eval(&a, &Context::of(&r).with_status(500), Scope::Body));
    }

    #[test]
    fn body_scope() {
        let r = rec();
        let body = json!({"name": "一号", "tags": "|电子围栏|"});
        let map = body.as_object().unwrap();
        let a = Assert {
            field: Some("name".into()),
            op: Operator::Eq,
            value: Some(json!("一号")),
            scope: None,
        };
        assert!(eval(&a, &Context::of(&r).with_body(map), Scope::Body));
    }

    #[test]
    fn inclusive_numeric_compare() {
        assert!(check("$.after.id", Operator::Gte, Some(json!(8821))));
        assert!(check("$.after.id", Operator::Gte, Some(json!(8821.0))));
        assert!(!check("$.after.id", Operator::Gte, Some(json!(8822))));
        assert!(check("$.after.id", Operator::Lte, Some(json!(8821))));
        assert!(!check("$.after.id", Operator::Lte, Some(json!(8000))));
        // 非数字仍然不参与比较
        assert!(!check("$.after.name", Operator::Gte, Some(json!(1))));
    }

    #[test]
    fn status_and_response_body_can_be_combined() {
        let conds: Vec<Condition> = serde_json::from_value(json!([
            {"op": "eq", "value": 200},
            {"scope": "body", "field": "$.result", "op": "gt", "value": 0}
        ]))
        .unwrap();
        let record = Value::Null;
        let good = json!({"result": 3});
        let ctx = Context::of(&record)
            .with_status(200)
            .with_body(good.as_object().unwrap());
        assert!(eval_all(&conds, &ctx, Scope::Status));

        let bad = json!({"result": 0});
        let ctx = Context::of(&record)
            .with_status(200)
            .with_body(bad.as_object().unwrap());
        assert!(!eval_all(&conds, &ctx, Scope::Status));
    }

    #[test]
    fn nested_any_and_not() {
        let conds: Vec<Condition> = serde_json::from_value(json!([
            {"op": "eq", "value": 200},
            {"any": [
                {"scope": "body", "field": "$.extra.code", "op": "eq", "value": "OK"},
                {"scope": "body", "field": "$.extra.code", "op": "absent"}
            ]},
            {"not": {"all": [{"scope": "body", "field": "$.blocked", "op": "eq", "value": true}]}}
        ]))
        .unwrap();
        let record = Value::Null;
        let body = json!({"extra": {"code": "X"}, "blocked": false});
        let ctx = Context::of(&record)
            .with_status(200)
            .with_body(body.as_object().unwrap());
        // code 是 X、字段存在 → any 不成立
        assert!(!eval_all(&conds, &ctx, Scope::Status));

        let body = json!({"blocked": false});
        let ctx = Context::of(&record)
            .with_status(200)
            .with_body(body.as_object().unwrap());
        assert!(eval_all(&conds, &ctx, Scope::Status));

        let body = json!({"blocked": true});
        let ctx = Context::of(&record)
            .with_status(200)
            .with_body(body.as_object().unwrap());
        assert!(!eval_all(&conds, &ctx, Scope::Status));
    }
}
