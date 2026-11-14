//! # 判定
//!
//! 响应 → 结论。规则有序，第一条命中即停。
//!
//! **传输层分类不在这里**：2xx / 408 / 429 / 5xx / 超时由执行器按固定语义处理，
//! 不给配置。这一层只管「HTTP 200 响应体里那个业务失败到底算什么」——
//! 下游把业务失败塞进 200 + `{"result": -1}` 是现状，只能逐服务配。

use syn_api::{TaskSpec, Verdict};

use crate::assertion::{Context, eval_all};

/// # 判定结果
#[derive(Debug, Clone)]
pub struct Judgement {
    /// 命中的规则序号（从 1 开始），0 表示兜底
    pub index: usize,
    /// 结论
    pub verdict: Verdict,
    /// 分类码
    pub code: String,
    /// 是否走了兜底（配置正常时不该出现）
    pub fallback: bool,
}

/// # 执行判定
pub fn judge(spec: &TaskSpec, status: u16, body: &serde_json::Value) -> Judgement {
    let record = serde_json::Value::Null;
    let ctx = Context::of(&record).with_status(status);
    let ctx = match body.as_object() {
        Some(map) => ctx.with_body(map),
        None => ctx,
    };

    for (i, rule) in spec.outcomes.iter().enumerate() {
        if eval_all(&rule.asserts, &ctx, rule.scope) {
            return Judgement {
                index: i + 1,
                verdict: rule.verdict,
                code: rule.code.clone(),
                fallback: false,
            };
        }
    }

    // 配置校验要求最后一条是兜底，正常走不到这里。真走到了就按失败处理：
    // 「不认识的响应」被当成成功，是这条链路上最贵的一种错误。
    Judgement {
        index: 0,
        verdict: Verdict::Fatal,
        code: "UNCLASSIFIED".into(),
        fallback: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec() -> TaskSpec {
        serde_json::from_value(json!({
            "id": "t", "topic": "tp", "priority": 1, "enabled": true,
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
