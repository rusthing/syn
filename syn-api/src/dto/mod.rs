//! # 入参（DTO）
//!
//! 这里的形状是**接口的形状，不是表的形状**，所以全部手写、不用 `#[crud_dto]`：
//!
//! | 接口 | 请求体 | 为什么不等于表 |
//! |---|---|---|
//! | `POST /syn/task`、`PUT /syn/task/{id}` | `{ name, spec, remark? }` | `code/topic/priority/enabled/exclusive` 五个列由 `spec` 派生，不让调用方填两遍 |
//! | `PUT /syn/task/{id}/enabled` | `{ enabled }` | 只动一列，改的是开关不是规则 |
//! | `POST /syn/source`、`PUT /syn/source/{id}` | 表形状（`code/name/kind/...`） | 这个**是**表形状，但 `spec` 是 JSONB，`#[crud_dto]` 会把它当查询条件处理 |
//!
//! `spec` 一律用 [`serde_json::Value`] 原样收发：结构由
//! [`TaskSpec::validate`](crate::spec::TaskSpec::validate) 把关，不在 DTO 层套强类型。
//! 强类型会让「读一条带未知字段的配置、改个名字、存回去」变成静默丢字段 ——
//! 老版本配置里还留着的键不该因为编辑器不认识就被吃掉。
//!
//! `@len` / `@range` 来自列注释，用 `validator` 落在字段上，svc 调 `dto.validate()`。

mod syn_canvas_layout_dto;
mod syn_datasource_dto;
mod syn_delivery_dto;
mod syn_idem_dto;
mod syn_overview_dto;
mod syn_source_dto;
mod syn_task_dto;

pub use syn_canvas_layout_dto::{SynCanvasLayoutSaveDto, SynCanvasNodePosDto};
pub use syn_datasource_dto::{
    SynDatasourceEnabledDto, SynDatasourceQueryDto, SynDatasourceSaveDto,
};
pub use syn_delivery_dto::SynDeliveryQueryDto;
pub use syn_idem_dto::SynIdemQueryDto;
pub use syn_overview_dto::SynOverviewQueryDto;
pub use syn_source_dto::{SynSourceEnabledDto, SynSourceQueryDto, SynSourceSaveDto};
pub use syn_task_dto::{SynTaskEnabledDto, SynTaskQueryDto, SynTaskSaveDto};
