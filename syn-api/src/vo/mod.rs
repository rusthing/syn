//! # 出参（VO）
//!
//! 出口约定与框架的 `#[vo]` 一致，但**不用那个宏**：这批 VO 全是组合视图，不是
//! `Model` 的镜像 —— 任务要带统计、来源要带游标、幂等台账要带任务编码。
//! `#[vo]` 生成的 `From<Model>` 只能做同名字段搬运，拿不到关联表的数据。
//!
//! 三条固定约定（与 `#[vo]` 逐条相同，改的时候两边一起改）：
//!
//! 1. **`camelCase`**：`create_ms` 出去是 `createMs`。异常只有 `spec`，它是 JSONB
//!    原样透传，键名以配置文件为准（`on_empty`、`on_fail` 这些不改）。
//! 2. **`u64` 一律走 [`U64`](robotech::api::U64)**：序列化成字符串。雪花 ID 有 19 位，
//!    超过 JS 的 `Number.MAX_SAFE_INTEGER`，用数字传会静默丢精度（末几位变 0），
//!    前端拿它去查询就永远查不到。
//! 3. **`Option` 为 `None` 时不输出**（`skip_serializing_none`）：让「没有这个字段」
//!    和「字段是 null」在报文里保持一致，前端不必两套判断。

mod syn_datasource_vo;
mod syn_delivery_vo;
mod syn_idem_vo;
mod syn_overview_vo;
mod syn_source_vo;
mod syn_task_vo;

pub use syn_datasource_vo::SynDatasourceVo;
pub use syn_delivery_vo::SynDeliveryVo;
pub use syn_idem_vo::SynIdemVo;
pub use syn_overview_vo::{SynOverviewFailureVo, SynOverviewHourVo, SynOverviewVo};
pub use syn_source_vo::{SynCursorVo, SynSourcePullVo, SynSourceVo};
pub use syn_task_vo::SynTaskVo;
