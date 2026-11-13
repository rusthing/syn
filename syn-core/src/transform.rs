//! # 变换注册表
//!
//! 映射行上的 `fn` 只能从这个封闭集合里选。**新增变换要改代码发版**，
//! 不允许从配置里演化 —— 变换是数据正确性的最后一道闸，让它在配置里自由生长，
//! 等于把脏数据的责任推给实施人员。
//!
//! 每个变换都遵守两条约定：
//! - **不改变类型语义**：字符串变换遇到非字符串原样返回，不偷偷 `to_string()`；
//! - **失败要抛错**：解析不了就报错，由映射行的 `on_error` 决定后果，绝不返回空值糊过去。

use serde_json::Value;

/// # 变换失败
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TransformError {
    /// 变换名
    pub transform: String,
    /// 失败原因
    pub message: String,
}

impl TransformError {
    fn new(transform: &str, message: impl Into<String>) -> Self {
        Self {
            transform: transform.to_string(),
            message: message.into(),
        }
    }
}

/// # 执行一个变换
///
/// `spec` 形如 `trim`、`truncate(100)`、`strip_suffix("电子围栏区")`。
pub fn apply(value: &Value, spec: &str) -> Result<Value, TransformError> {
    let (name, args) = parse(spec);
    match name {
        "trim" => Ok(match value {
            Value::String(s) => Value::String(s.trim().to_string()),
            other => other.clone(),
        }),
        "strip_nul" => Ok(match value {
            Value::String(s) => Value::String(s.replace('\u{0}', "")),
            other => other.clone(),
        }),
        "strip_suffix" => {
            let suffix = arg_str(&args, 0, name)?;
            let Value::String(s) = value else {
                return Ok(value.clone());
            };
            Ok(Value::String(match s.strip_suffix(suffix.as_str()) {
                Some(rest) => rest.to_string(),
                None => s.clone(),
            }))
        }
        "strip_prefix" => {
            let prefix = arg_str(&args, 0, name)?;
            let Value::String(s) = value else {
                return Ok(value.clone());
            };
            Ok(Value::String(match s.strip_prefix(prefix.as_str()) {
                Some(rest) => rest.to_string(),
                None => s.clone(),
            }))
        }
        "truncate" => {
            // 按字符截，不是按字节：中文名按字节截会把字截断成乱码
            let n: usize = arg_num(&args, 0, name)? as usize;
            Ok(match value {
                Value::String(s) => Value::String(s.chars().take(n).collect()),
                other => other.clone(),
            })
        }
        "to_bool_01" => match value {
            Value::Null => Ok(Value::Null),
            Value::Bool(b) => Ok(Value::Bool(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(1) => Ok(Value::Bool(true)),
                Some(0) => Ok(Value::Bool(false)),
                _ => Err(TransformError::new(name, format!("{n} 不是 0/1"))),
            },
            Value::String(s) => match s.trim() {
                "1" | "true" | "TRUE" | "t" => Ok(Value::Bool(true)),
                "0" | "false" | "FALSE" | "f" => Ok(Value::Bool(false)),
                other => Err(TransformError::new(name, format!("{other} 不是 0/1"))),
            },
            other => Err(TransformError::new(name, format!("{other} 不是 0/1"))),
        },
        "to_ms" => {
            let n = value
                .as_f64()
                .ok_or_else(|| TransformError::new(name, "不是数字"))?;
            // 秒级时间戳补成毫秒；已经是毫秒的不动，避免乘两次
            let ms = if n > 0.0 && n < 1e11 { n * 1000.0 } else { n };
            Ok(Value::from(ms as i64))
        }
        "upper" | "lower" => Ok(match value {
            Value::String(s) if name == "upper" => Value::String(s.to_uppercase()),
            Value::String(s) => Value::String(s.to_lowercase()),
            other => other.clone(),
        }),
        "map_enum" => {
            // 参数形如 map_enum(1=男,2=女)；未命中就保持原值，不做二次猜测
            let src = scalar_text(value);
            for pair in &args {
                if let Some((from, to)) = pair.split_once('=')
                    && from.trim() == src
                {
                    return Ok(Value::String(to.trim().to_string()));
                }
            }
            Ok(value.clone())
        }
        "wkb_to_wkt" => {
            let s = value
                .as_str()
                .ok_or_else(|| TransformError::new(name, "WKB 不是字符串"))?;
            let wkt = wkb_to_wkt(s).map_err(|e| TransformError::new(name, e))?;
            Ok(Value::String(wkt))
        }
        other => Err(TransformError::new(other, "未注册的变换")),
    }
}

/// # WKB / EWKB → WKT
///
/// 解析细节在 [`crate::wkb`]：那是唯一需要逐字节较真的地方，单独放、单独测。
fn wkb_to_wkt(hex: &str) -> Result<String, String> {
    crate::wkb::to_wkt(hex)
}

/// 取用于比较的文本形式：数字不带小数点，便于写 `1=男` 这种映射
fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn parse(spec: &str) -> (&str, Vec<String>) {
    let spec = spec.trim();
    match spec.find('(') {
        Some(open) if spec.ends_with(')') => {
            let name = spec[..open].trim();
            let inner = &spec[open + 1..spec.len() - 1];
            let args = if inner.trim().is_empty() {
                Vec::new()
            } else {
                inner
                    .split(',')
                    .map(|a| unquote(a.trim()).to_string())
                    .collect()
            };
            (name, args)
        }
        _ => (spec, Vec::new()),
    }
}

fn unquote(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

fn arg_str(args: &[String], i: usize, name: &str) -> Result<String, TransformError> {
    args.get(i)
        .cloned()
        .ok_or_else(|| TransformError::new(name, format!("缺少第 {} 个参数", i + 1)))
}

fn arg_num(args: &[String], i: usize, name: &str) -> Result<f64, TransformError> {
    let raw = arg_str(args, i, name)?;
    raw.parse::<f64>()
        .map_err(|_| TransformError::new(name, format!("参数 {raw} 不是数字")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 一个真实的 WKB Polygon：北京某处，5 个点闭合
    const WKB_POLYGON: &str = "010300000001000000050000001B2FDD2406195D406ABC749318F44340C520B07268195D406ABC749318F44340C520B07268195D40DBF97E6ABCF443401B2FDD2406195D40DBF97E6ABCF443401B2FDD2406195D406ABC749318F44340";

    #[test]
    fn string_transforms() {
        assert_eq!(apply(&json!("  a "), "trim").unwrap(), json!("a"));
        assert_eq!(
            apply(&json!("ab\u{0}c"), "strip_nul").unwrap(),
            json!("abc")
        );
        assert_eq!(
            apply(&json!("一号电子围栏区"), "strip_suffix(\"电子围栏区\")").unwrap(),
            json!("一号")
        );
        assert_eq!(
            apply(&json!("二号围栏"), "strip_suffix(\"电子围栏区\")").unwrap(),
            json!("二号围栏")
        );
        assert_eq!(
            apply(&json!("abcdef"), "truncate(3)").unwrap(),
            json!("abc")
        );
        assert_eq!(
            apply(&json!("一二三四五"), "truncate(2)").unwrap(),
            json!("一二")
        );
        assert_eq!(apply(&json!("ab"), "upper").unwrap(), json!("AB"));
    }

    #[test]
    fn non_string_passes_through() {
        assert_eq!(apply(&json!(12), "trim").unwrap(), json!(12));
        assert_eq!(apply(&json!(true), "truncate(3)").unwrap(), json!(true));
    }

    #[test]
    fn bool_01() {
        assert_eq!(apply(&json!(1), "to_bool_01").unwrap(), json!(true));
        assert_eq!(apply(&json!(0), "to_bool_01").unwrap(), json!(false));
        assert_eq!(apply(&json!("1"), "to_bool_01").unwrap(), json!(true));
        assert_eq!(apply(&json!(null), "to_bool_01").unwrap(), Value::Null);
        assert!(apply(&json!(2), "to_bool_01").is_err());
    }

    #[test]
    fn milliseconds() {
        assert_eq!(
            apply(&json!(1762900000), "to_ms").unwrap(),
            json!(1762900000000i64)
        );
        assert_eq!(
            apply(&json!(1762900000000i64), "to_ms").unwrap(),
            json!(1762900000000i64)
        );
    }

    #[test]
    fn wkb_becomes_wkt() {
        let wkt = apply(&json!(WKB_POLYGON), "wkb_to_wkt").unwrap();
        let s = wkt.as_str().unwrap();
        assert!(s.starts_with("POLYGON"), "{s}");
        assert!(s.contains("116.391"), "{s}");
    }

    #[test]
    fn wkb_accepts_backslash_prefix() {
        let with_prefix = format!("\\x{WKB_POLYGON}");
        assert!(apply(&json!(with_prefix), "wkb_to_wkt").is_ok());
    }

    #[test]
    fn broken_geometry_errors_out() {
        assert!(apply(&json!("BADDATA"), "wkb_to_wkt").is_err());
        assert!(apply(&json!("0103"), "wkb_to_wkt").is_err());
        assert!(apply(&json!(123), "wkb_to_wkt").is_err());
    }

    #[test]
    fn unknown_transform_errors_out() {
        assert!(apply(&json!("x"), "nope").is_err());
    }
}
