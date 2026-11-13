use robotech::macros::dic;
use strum::{AsRefStr, Display, EnumString};

use crate::spec::Verdict;

/// 一条记录在某个任务上的最终结论，对应 `syn_idem.verdict`。
///
/// 与 [`Verdict`]（`spec` 里写 `"success"` / `"skip"` / …）是同一组语义的两种表示：
/// 表列用整数（稳定、省空间、可索引），配置文件用字符串（可读、可评审）。
/// 两者的映射就在下面 [`From`] 的两个 impl 里，**不要**在业务代码里再写一遍 `match`。
#[dic(default = Success)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, AsRefStr, Display, EnumString)]
#[strum(serialize_all = "kebab-case")]
pub enum SyncVerdict {
    /// 成功：下游接受，可以推进游标 / 提交 offset
    Success = 0,
    /// 跳过：条件不满足或重复投递，不是错误
    Skip = 1,
    /// 业务失败：重试多少次都一样，应当进死信
    Fatal = 2,
    /// 暂时失败：下游不可用或超时，应当重试
    Retriable = 3,
}

impl From<Verdict> for SyncVerdict {
    fn from(v: Verdict) -> Self {
        match v {
            Verdict::Success => Self::Success,
            Verdict::Skip => Self::Skip,
            Verdict::Fatal => Self::Fatal,
            Verdict::Retriable => Self::Retriable,
        }
    }
}

impl From<SyncVerdict> for Verdict {
    fn from(v: SyncVerdict) -> Self {
        match v {
            SyncVerdict::Success => Self::Success,
            SyncVerdict::Skip => Self::Skip,
            SyncVerdict::Fatal => Self::Fatal,
            SyncVerdict::Retriable => Self::Retriable,
        }
    }
}
