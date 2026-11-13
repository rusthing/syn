//! # 路径取值
//!
//! 只支持 JSONPath 的一个子集：`$.a.b`、`$.a[0].b`、`a.b`。
//!
//! 刻意不做通配、过滤表达式和递归下降。理由：配置里的路径必须能一眼看出取的是哪个
//! 字段，能写过滤器就意味着能写逻辑，那就退化成脚本了。

use serde_json::{Map, Value};

/// 路径中的一段
#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    /// 对象键
    Key(String),
    /// 数组下标
    Index(usize),
}

/// # 按路径取值
///
/// 取不到返回 `None`，与「取到 null」区分开：`exists` 与 `absent` 依赖这个区别。
pub fn get_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    walk(root, &parse(path)?)
}

/// # 在请求体（对象）上按路径取值
///
/// 请求体已经是展开的对象，少一层包装；单独开一个入口，避免为了取一个字段
/// 把整个 body 包成 `Value::Object` 再解。
pub fn get_path_in_map<'a>(map: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let segs = parse(path)?;
    let (first, rest) = segs.split_first()?;
    match first {
        Segment::Key(k) => walk(map.get(k)?, rest),
        Segment::Index(_) => None,
    }
}

fn walk<'a>(root: &'a Value, segs: &[Segment]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in segs {
        cur = match seg {
            Segment::Key(k) => cur.get(k)?,
            Segment::Index(i) => cur.get(*i)?,
        };
    }
    Some(cur)
}

fn parse(path: &str) -> Option<Vec<Segment>> {
    let s = path.trim();
    if s.is_empty() {
        return None;
    }
    let s = s.strip_prefix('$').unwrap_or(s);

    let mut segs = Vec::new();
    let mut key = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '.' => {
                if !key.is_empty() {
                    segs.push(Segment::Key(std::mem::take(&mut key)));
                }
            }
            '[' => {
                if !key.is_empty() {
                    segs.push(Segment::Key(std::mem::take(&mut key)));
                }
                let mut digits = String::new();
                for d in chars.by_ref() {
                    if d == ']' {
                        break;
                    }
                    digits.push(d);
                }
                segs.push(Segment::Index(digits.parse().ok()?));
            }
            _ => key.push(c),
        }
    }
    if !key.is_empty() {
        segs.push(Segment::Key(key));
    }

    // `$` 单独一个字符表示取根
    Some(segs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_nested_and_indexed() {
        let v = json!({"after": {"id": 1, "geo": {"wkb": "0103"}, "tags": [{"k": "a"}]}});
        assert_eq!(get_path(&v, "$.after.id"), Some(&json!(1)));
        assert_eq!(get_path(&v, "after.geo.wkb"), Some(&json!("0103")));
        assert_eq!(get_path(&v, "$.after.tags[0].k"), Some(&json!("a")));
    }

    #[test]
    fn missing_is_none_not_null() {
        let v = json!({"a": null});
        assert_eq!(get_path(&v, "$.a"), Some(&Value::Null));
        assert_eq!(get_path(&v, "$.b"), None);
        assert_eq!(get_path(&v, "$.a.b"), None);
    }

    #[test]
    fn root_path() {
        let v = json!({"a": 1});
        assert_eq!(get_path(&v, "$"), Some(&v));
    }
}
