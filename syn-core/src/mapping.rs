//! # 映射
//!
//! 一条记录 → 一个请求体，**没有分支**。按表来源分变体的逻辑不在这里：
//! 那种分支应该上移到匹配段，拆成两个任务。
//!
//! 两个全局语义写在结构上而不是每行重复：
//! - `omit_null`：来源为 null 时整行省略；
//! - 变换失败：走该行的 `on_error`，默认 `fatal(TRANSFORM_ERROR)`。
//!
//! 变换失败**不抛到调用方再兜**，也不在这里 try/catch 成「跳过这行」——
//! 静默少一个字段比整条失败更危险。

use serde_json::{Map, Value};
use syn_api::{OnEmpty, TaskSpec, Verdict};

use crate::transform;
use crate::value::get_path;

/// # 一行映射的执行痕迹
///
/// 试跑面板直接展示这个：用户要能看见「这个值是怎么来的」。
#[derive(Debug, Clone)]
pub struct Trace {
    /// 目标字段
    pub to: String,
    /// 来源与变换链的人话描述
    pub note: String,
}

/// # 映射结果
#[derive(Debug, Clone)]
pub struct MappedBody {
    /// 请求体
    pub body: Map<String, Value>,
    /// 逐行痕迹
    pub trace: Vec<Trace>,
}

/// # 映射失败
#[derive(Debug, Clone)]
pub struct MapFailure {
    /// 出问题的目标字段
    pub field: String,
    /// 结论（通常 fatal）
    pub verdict: Verdict,
    /// 分类码，进死信
    pub code: String,
    /// 原因
    pub detail: String,
}

/// # 执行映射
pub fn map(spec: &TaskSpec, record: &Value) -> Result<MappedBody, MapFailure> {
    let mut body = Map::new();
    let mut trace = Vec::with_capacity(spec.mapping.rows.len());

    for row in &spec.mapping.rows {
        let (mut value, note) = match (&row.const_value, &row.from) {
            (Some(c), _) => (c.clone(), "常量".to_string()),
            (None, Some(path)) => match get_path(record, path) {
                Some(v) => (
                    v.clone(),
                    if row.transforms.is_empty() {
                        "直传".to_string()
                    } else {
                        row.transforms.join(" → ")
                    },
                ),
                None => (Value::Null, "路径不存在".to_string()),
            },
            // validate 已拦住，这里防御一下：宁可失败也不要悄悄丢字段
            (None, None) => {
                return Err(MapFailure {
                    field: row.to.clone(),
                    verdict: Verdict::Fatal,
                    code: "MAPPING_BROKEN".into(),
                    detail: "映射行既没有 from 也没有 const".into(),
                });
            }
        };

        if value.is_null() {
            if spec.mapping.omit_null {
                trace.push(Trace {
                    to: row.to.clone(),
                    note: format!("{note}（null 省略）"),
                });
                continue;
            }
            insert_path(&mut body, &row.to, Value::Null);
            trace.push(Trace {
                to: row.to.clone(),
                note: format!("{note}（null 保留）"),
            });
            continue;
        }

        let original = value.clone();
        for t in &row.transforms {
            match transform::apply(&value, t) {
                Ok(v) => value = v,
                Err(e) => {
                    let (verdict, code) = match &row.on_error {
                        Some(p) => (p.verdict, p.code.clone()),
                        None => (Verdict::Fatal, "TRANSFORM_ERROR".to_string()),
                    };
                    return Err(MapFailure {
                        field: row.to.clone(),
                        verdict,
                        code,
                        detail: format!("{t}: {e}"),
                    });
                }
            }
        }

        if is_blank(&value) {
            match row.on_empty {
                OnEmpty::Keep => {}
                OnEmpty::KeepOriginal => value = original,
                OnEmpty::Omit => {
                    trace.push(Trace {
                        to: row.to.clone(),
                        note: format!("{note}（空，省略）"),
                    });
                    continue;
                }
                OnEmpty::Null => value = Value::Null,
            }
        }

        insert_path(&mut body, &row.to, value);
        trace.push(Trace {
            to: row.to.clone(),
            note,
        });
    }

    Ok(MappedBody { body, trace })
}

/// # 按点路径写入
///
/// `to: "addr.city"` 会写成 `{"addr":{"city":...}}`。下游报文经常是嵌套结构，
/// 只支持顶层键会逼着人给每个嵌套字段单独建任务 —— 那就不叫抽象了。
fn insert_path(body: &mut Map<String, Value>, path: &str, value: Value) {
    let mut segs = path.split('.').filter(|s| !s.is_empty()).peekable();
    let Some(first) = segs.next() else { return };
    if segs.peek().is_none() {
        body.insert(first.to_string(), value);
        return;
    }
    let cur = body
        .entry(first.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !cur.is_object() {
        *cur = Value::Object(Map::new());
    }
    let mut node = cur.as_object_mut().expect("已保证是对象");
    while let Some(seg) = segs.next() {
        if segs.peek().is_none() {
            node.insert(seg.to_string(), value);
            return;
        }
        let next = node
            .entry(seg.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !next.is_object() {
            *next = Value::Object(Map::new());
        }
        node = next.as_object_mut().expect("已保证是对象");
    }
}

fn is_blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use syn_api::{Mapping, MappingRow, OnError};

    fn spec_with(rows: Vec<MappingRow>) -> TaskSpec {
        serde_json::from_value(json!({
            "id": "t", "topic": "tp", "priority": 1, "enabled": true,
            "target": {"service": "s", "base": "/b"},
            "mapping": {"omit_null": true, "rows": []},
            "actions": [{"op": "c", "method": "POST", "path": "/x"}],
            "outcomes": [{"scope": "status", "assert": [{"op": "in", "value": [200]}], "verdict": "success"}]
        }))
        .map(|mut s: TaskSpec| {
            s.mapping = Mapping { omit_null: true, rows };
            s
        })
        .unwrap()
    }

    #[test]
    fn renames_and_omits_null() {
        let spec = spec_with(vec![
            MappingRow {
                to: "id".into(),
                from: Some("$.after.id".into()),
                const_value: None,
                transforms: vec![],
                on_empty: OnEmpty::Keep,
                on_error: None,
            },
            MappingRow {
                to: "remark".into(),
                from: Some("$.after.remark".into()),
                const_value: None,
                transforms: vec![],
                on_empty: OnEmpty::Keep,
                on_error: None,
            },
        ]);
        let rec = json!({"after": {"id": 7}});
        let out = map(&spec, &rec).unwrap();
        assert_eq!(out.body.get("id"), Some(&json!(7)));
        assert!(!out.body.contains_key("remark"));
    }

    #[test]
    fn constant_and_suffix_strip() {
        let spec = spec_with(vec![
            MappingRow {
                to: "tags".into(),
                from: None,
                const_value: Some(json!("|电子围栏|")),
                transforms: vec![],
                on_empty: OnEmpty::Keep,
                on_error: None,
            },
            MappingRow {
                to: "name".into(),
                from: Some("$.after.name".into()),
                const_value: None,
                transforms: vec!["strip_suffix(\"电子围栏区\")".into(), "trim".into()],
                on_empty: OnEmpty::Keep,
                on_error: None,
            },
        ]);
        let out = map(&spec, &json!({"after": {"name": "一号电子围栏区"}})).unwrap();
        assert_eq!(out.body.get("tags"), Some(&json!("|电子围栏|")));
        assert_eq!(out.body.get("name"), Some(&json!("一号")));
    }

    #[test]
    fn keep_original_when_strip_empties_it() {
        let spec = spec_with(vec![MappingRow {
            to: "name".into(),
            from: Some("$.after.name".into()),
            const_value: None,
            transforms: vec!["strip_suffix(\"电子围栏区\")".into(), "trim".into()],
            on_empty: OnEmpty::KeepOriginal,
            on_error: None,
        }]);
        let out = map(&spec, &json!({"after": {"name": "电子围栏区"}})).unwrap();
        assert_eq!(out.body.get("name"), Some(&json!("电子围栏区")));
    }

    #[test]
    fn transform_failure_uses_row_policy() {
        let spec = spec_with(vec![MappingRow {
            to: "geom".into(),
            from: Some("$.after.wkb".into()),
            const_value: None,
            transforms: vec!["wkb_to_wkt".into()],
            on_empty: OnEmpty::Keep,
            on_error: Some(OnError {
                verdict: Verdict::Fatal,
                code: "WKB_INVALID".into(),
            }),
        }]);
        let err = map(&spec, &json!({"after": {"wkb": "BADDATA"}})).unwrap_err();
        assert_eq!(err.code, "WKB_INVALID");
        assert_eq!(err.field, "geom");
    }

    #[test]
    fn empty_path_is_a_failure_not_silence() {
        let spec = spec_with(vec![MappingRow {
            to: "x".into(),
            from: Some("$.after.missing".into()),
            const_value: None,
            transforms: vec![],
            on_empty: OnEmpty::Keep,
            on_error: None,
        }]);
        let out = map(&spec, &json!({"after": {}})).unwrap();
        // 路径不存在 → null → omit_null 生效，字段被省略，但 trace 里留了原因
        assert!(!out.body.contains_key("x"));
        assert!(out.trace[0].note.contains("路径不存在"));
    }
}
