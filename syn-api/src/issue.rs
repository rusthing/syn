//! # 配置校验问题
//!
//! 编辑期校验的返回值。每条都带一个能定位到单元格的 `path`，
//! 编辑器据此高亮；执行器加载期据此**只停用单个任务**，不让整份快照失败。

use serde::{Deserialize, Serialize};

/// # 一条配置问题
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecIssue {
    /// 定位路径，如 `mapping.rows[3].fn[0]`
    pub path: String,
    /// 问题类型
    pub kind: SpecIssueKind,
    /// 人话描述，直接展示
    pub message: String,
}

impl SpecIssue {
    /// 新建一条
    pub fn new(path: impl Into<String>, kind: SpecIssueKind, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SpecIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

/// # 问题类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecIssueKind {
    /// 必填项缺失
    Missing,
    /// 两个字段互相矛盾或重复
    Conflict,
    /// 值不合法（类型、前缀、方法）
    Invalid,
    /// 引用了未注册的变换
    UnknownTransform,
}
