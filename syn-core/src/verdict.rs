//! # 判定
//!
//! 响应 → 结论。规则有序，第一条命中即停。
//!
//! **传输层分类不在这里**：2xx / 408 / 429 / 5xx / 超时由执行器按固定语义处理，
//! 不给配置。这一层只管「HTTP 200 响应体里那个业务失败到底算什么」——
//! 下游把业务失败塞进 200 + `{"result": -1}` 是现状，只能逐服务配。

use syn_api::{Rule, TaskSpec, Verdict};

use crate::assertion::{eval_all, json_eq, value_at, Context};

/// # 判定结果
#[derive(Debug, Clone)]
pub struct Judgement {
    /// 命中的**顶层**语句序号（从 1 开始），0 表示兜底
    ///
    /// 嵌套块内部命中哪一臂不在这里暴露：对使用方来说「第几条语句管住了这条响应」
    /// 才是要写进死信与界面的话，再深的编号只会让人去数缩进。
    pub index: usize,
    /// 结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 是否走了兜底（配置正常时不该出现）
    pub fallback: bool,
}

/// # 执行判定
///
/// 语句树由 [`TaskSpec::verdict_rules`] 给出：新配置是 `rules`，老配置是
/// `outcomes` 映射成的一串 `if`，两种形状在这里没有分支。
pub fn judge(spec: &TaskSpec, status: u16, body: &serde_json::Value) -> Judgement {
    let record = serde_json::Value::Null;
    let ctx = Context::of(&record).with_status(status);
    let ctx = match body.as_object() {
        Some(map) => ctx.with_body(map),
        None => ctx,
    };

    let rules = spec.verdict_rules();
    for (i, rule) in rules.iter().enumerate() {
        if let Some((verdict, code)) = eval_rule(rule, &ctx) {
            return Judgement {
                index: i + 1,
                verdict,
                code,
                fallback: false,
            };
        }
    }

    // 配置校验要求每层块都以兜底收尾，正常走不到这里。真走到了就按失败处理：
    // 「不认识的响应」被当成成功，是这条链路上最贵的一种错误。
    Judgement {
        index: 0,
        verdict: Verdict::Fatal,
        code: "UNCLASSIFIED".into(),
        fallback: true,
    }
}

/// 顺序执行一个语句块，首个给出结论的语句胜出
fn eval_block(block: &[Rule], ctx: &Context<'_>) -> Option<(Verdict, String)> {
    block.iter().find_map(|r| eval_rule(r, ctx))
}

fn eval_rule(rule: &Rule, ctx: &Context<'_>) -> Option<(Verdict, String)> {
    match rule {
        Rule::Outcome { verdict, code } => Some((*verdict, code.clone())),
        // 空条件数组恒真，这就是「否则」分支
        Rule::If { branches } => branches.iter().find_map(|b| {
            if eval_all(&b.asserts, ctx, b.scope) {
                eval_block(&b.then, ctx)
            } else {
                None
            }
        }),
        Rule::Switch {
            on,
            scope,
            cases,
            default,
        } => {
            let lhs = value_at(ctx, *scope, on);
            for c in cases {
                // 相等语义与断言共用 `json_eq`：`1` 等于 `1.0`，别在这里另立一套
                if c.values.iter().any(|v| lhs.is_some_and(|l| json_eq(l, v))) {
                    return eval_block(&c.then, ctx);
                }
            }
            eval_block(default, ctx)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec() -> TaskSpec {
        serde_json::from_value(json!({
            "topic": "tp", "sort_order": 1, "enabled": true,
            "target": {"service": "s", "base": "/b"},
            "mapping": {"rows": [{"to": "id", "from": "$.after.id"}]},
            "actions": [{"op": "c", "method": "POST", "path": "/x"}],
            "outcomes": [
                {"scope": "body", "assert": [{"field": "$.extra.code", "op": "eq", "value": "RTW00001"}], "verdict": "skip", "code": "duplicate"},
                {"scope": "body", "assert": [{"field": "$.extra.code", "op": "eq", "value": "RTW00002"}], "verdict": "fatal", "code": "fk_missing"},
                {"scope": "body", "assert": [{"field": "$.result", "op": "lt", "value": 0}], "verdict": "fatal", "code": "business_error"},
                {"scope": "status", "assert": [{"op": "in", "value": [200, 201]}], "verdict": "success"}
            ]
        }))
        .unwrap()
    }

    fn rules_spec(rules: serde_json::Value) -> TaskSpec {
        serde_json::from_value(json!({
            "topic": "tp", "sort_order": 1,
            "target": {"service": "s", "base": "/b"},
            "mapping": {"rows": [{"to": "id", "from": "$.after.id"}]},
            "actions": [{"op": "c", "method": "POST", "path": "/x"}],
            "rules": rules
        }))
        .unwrap()
    }

    /// switch 的臂里再嵌 if：外层按 code 分流，内层按 msg 细分
    #[test]
    fn nested_if_narrows_within_an_arm() {
        let s = rules_spec(json!([
            {"kind": "switch", "on": "$.code", "scope": "body",
             "cases": [{"values": [500], "then": [
                 {"kind": "if", "branches": [
                     {"assert": [{"field": "$.msg", "op": "contains", "value": "timeout"}],
                      "then": [{"kind": "outcome", "verdict": "retriable", "code": "UPSTREAM_TIMEOUT"}]},
                     {"assert": [], "then": [{"kind": "outcome", "verdict": "fatal", "code": "UPSTREAM_500"}]}
                 ]}
             ]}],
             "default": [{"kind": "outcome", "verdict": "success"}]}
        ]));
        assert_eq!(
            judge(&s, 500, &json!({"code": 500, "msg": "gateway timeout"})).code,
            "UPSTREAM_TIMEOUT"
        );
        assert_eq!(judge(&s, 500, &json!({"code": 500, "msg": "boom"})).code, "UPSTREAM_500");
        let ok = judge(&s, 200, &json!({"code": 200}));
        assert_eq!(ok.verdict, Verdict::Success);
        assert!(!ok.fallback, "default 命中不算兜底");
    }

    /// case 与断言共用一套相等语义：`500` 与 `500.0` 相等
    #[test]
    fn switch_matches_numbers_by_value() {
        let s = rules_spec(json!([
            {"kind": "switch", "on": "$.code", "scope": "body",
             "cases": [{"values": [500], "then": [{"kind": "outcome", "verdict": "retriable"}]}],
             "default": [{"kind": "outcome", "verdict": "success"}]}
        ]));
        assert_eq!(
            judge(&s, 200, &json!({"code": 500.0})).verdict,
            Verdict::Retriable
        );
    }

    /// 嵌套里命中，序号仍指最外层那条语句：界面与死信都按「第几条」说话
    #[test]
    fn index_points_at_the_top_level_statement() {
        let s = rules_spec(json!([
            {"kind": "if", "branches": [
                {"assert": [{"op": "eq", "value": 400}], "then": [{"kind": "outcome", "verdict": "fatal"}]}
            ]},
            {"kind": "switch", "on": "$.code", "scope": "body",
             "cases": [{"values": [500], "then": [
                 {"kind": "if", "branches": [
                     {"assert": [{"field": "$.msg", "op": "contains", "value": "x"}],
                      "then": [{"kind": "outcome", "verdict": "retriable"}]},
                     {"assert": [], "then": [{"kind": "outcome", "verdict": "fatal"}]}
                 ]}
             ]}],
             "default": [{"kind": "outcome", "verdict": "success"}]}
        ]));
        assert_eq!(judge(&s, 500, &json!({"code": 500, "msg": "x"})).index, 2);
    }

    #[test]
    fn duplicate_is_skip() {
        let j = judge(
            &spec(),
            200,
            &json!({"result": -1, "extra": {"code": "RTW00001"}}),
        );
        assert_eq!(j.verdict, Verdict::Skip);
        assert_eq!(j.code, "duplicate");
        assert_eq!(j.index, 1);
    }

    #[test]
    fn fk_missing_is_fatal_before_generic() {
        let j = judge(
            &spec(),
            200,
            &json!({"result": -1, "extra": {"code": "RTW00002"}}),
        );
        assert_eq!(j.verdict, Verdict::Fatal);
        assert_eq!(j.code, "fk_missing");
    }

    #[test]
    fn generic_business_failure() {
        let j = judge(&spec(), 200, &json!({"result": -3, "extra": {"code": "X"}}));
        assert_eq!(j.code, "business_error");
    }

    #[test]
    fn ok_is_success() {
        let j = judge(&spec(), 200, &json!({"result": 0}));
        assert_eq!(j.verdict, Verdict::Success);
    }

    #[test]
    fn unknown_body_with_2xx_is_success_by_fallback_rule() {
        let j = judge(&spec(), 201, &json!({"whatever": true}));
        assert_eq!(j.verdict, Verdict::Success);
    }

    #[test]
    fn nested_group_can_classify_a_response() {
        let mut s = spec();
        s.outcomes.insert(
            0,
            serde_json::from_value(json!({
                "scope": "status",
                "assert": [
                    {"op": "eq", "value": 200},
                    {"any": [
                        {"scope": "body", "field": "$.result", "op": "gte", "value": 1},
                        {"scope": "body", "field": "$.extra.code", "op": "eq", "value": "OK"}
                    ]}
                ],
                "verdict": "success",
                "code": "ok_nested"
            }))
            .unwrap(),
        );
        // 200 + result=1 命中嵌套规则，抢在后面的业务码规则之前
        let j = judge(&s, 200, &json!({"result": 1}));
        assert_eq!(j.code, "ok_nested");
        // 200 + result=0 且没有 OK 码 → 分组不成立，落到后面的 status 兜底
        let j = judge(&s, 200, &json!({"result": 0}));
        assert_eq!(j.verdict, Verdict::Success);
        assert_ne!(j.code, "ok_nested");
    }
}
