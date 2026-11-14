//! # 服务层
//!
//! 服务层返回**纯值**（`Vec` / `Vo` / `(总数, 列表)`），`Ro` 由 ctrl 统一包 ——
//! 规范 §6 的分工是「ctrl 包 Ro」。这样服务方法可以直接在 poll 调度器、联调用例里
//! 复用，不必每次拆一层 `extra`。
//!
//! 唯一的例外是错误：一律 `SvcError`，由框架的 `CtrlError` 翻译成状态码。

mod syn_canvas_layout_svc;
mod syn_datasource_svc;
mod syn_delivery_svc;
mod syn_idem_svc;
mod syn_overview_svc;
mod syn_service_svc;
mod syn_source_svc;
mod syn_task_svc;
mod sync_svc;

pub use syn_canvas_layout_svc::SynCanvasLayoutSvc;
pub use syn_datasource_svc::SynDatasourceSvc;
pub use syn_delivery_svc::SynDeliverySvc;
pub use syn_idem_svc::SynIdemSvc;
pub use syn_overview_svc::SynOverviewSvc;
pub use syn_service_svc::SynServiceSvc;
pub use syn_source_svc::{SynSourceSvc, enabled_sources};
pub use syn_task_svc::SynTaskSvc;
pub use sync_svc::{SyncOutcome, TaskResult, handle};

use robotech::svc::SvcError;
use validator::ValidationError;

/// # 字段级校验错误
///
/// `code` 放字段名，`message` 放人话；前端按 `detail` 直接展示。
/// 不要拿 `SvcError::NotFound` 冒充参数错误 —— 那会让 400 变成 404。
pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> SvcError {
    let field = field.into();
    let message = message.into();
    // `ValidationError::new` 只收 &'static str，字段名是动态的，索性放进 message：
    // 前端展示的是 message，code 固定成 invalid 反而好分类
    SvcError::Validation(
        ValidationError::new("invalid").with_message(format!("{field}: {message}").into()),
    )
}
