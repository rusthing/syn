//! 判定语义的共享用例。
//!
//! 用例只有一份：`syn/fixtures/verdict-cases.json`，前端
//! `syn-web/src/lib/spec/verdict-cases.test.ts` 读的是同一个文件。
//! 两边的求值器必须对每一行给出同一个结论 —— 之前 `scope` 默认值就踩过
//! 「前端贴心改了默认、两边对同一份配置判出不同结果」的坑，靠人眼比对是防不住的。

use serde_json::Value;

#[test]
fn shared_verdict_cases_hold_on_both_sides() {
    let raw: Value =
        serde_json::from_str(include_str!("../../fixtures/verdict-cases.json")).unwrap();
    let base = raw["base"].clone();
    let cases = raw["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().expect("name");

        let mut spec_json = base.clone();
        let dst = spec_json.as_object_mut().unwrap();
        for (k, v) in case["spec"].as_object().expect("spec") {
            dst.insert(k.clone(), v.clone());
        }
        let task: syn_api::TaskSpec = serde_json::from_value(spec_json)
            .unwrap_or_else(|e| panic!("{name}: 反序列化失败 {e}"));

        let status = case["status"].as_u64().expect("status") as u16;
        let j = syn_core::judge(&task, status, &case["body"]);

        let e = &case["expect"];
        assert_eq!(
            j.index,
            e["index"].as_u64().unwrap() as usize,
            "{name}: 命中的顶层语句序号"
        );
        assert_eq!(
            format!("{:?}", j.verdict).to_lowercase(),
            e["verdict"].as_str().unwrap(),
            "{name}: 结论"
        );
        assert_eq!(j.code, e["code"].as_str().unwrap(), "{name}: 分类码");
        assert_eq!(
            j.fallback,
            e["fallback"].as_bool().unwrap(),
            "{name}: 是否兜底"
        );
    }
}
