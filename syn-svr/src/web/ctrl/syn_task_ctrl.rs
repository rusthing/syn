//! # 同步任务控制器
//!
//! 七个手写接口。没有用 `#[ctrl]`/`#[crud_dto]`：任务的 `code/topic/priority/enabled/
//! exclusive` 五列是 `spec` 的投影，接口只收 `{ name, spec, remark }`，让宏按表形状
//! 生成 DTO 会把这层约定冲掉（见 `dto/mod.rs`）。

use axum::Json;
use axum::debug_handler;
use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use robotech::api::{PageRx, Ro, U64};
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynTaskEnabledDto, SynTaskQueryDto, SynTaskSaveDto, SynTaskVo};

use super::common::*;
use crate::svc::SynTaskSvc;

#[utoipa::path(get, path = "/syn/task/list", responses((status = OK, body = Ro<Vec<SynTaskVo>>)))]
#[debug_handler]
#[log_call]
pub async fn list() -> Result<Json<Ro<Vec<SynTaskVo>>>, CtrlError> {
    Ok(ok("查询任务列表成功", SynTaskSvc::list().await?))
}

#[utoipa::path(get, path = "/syn/task/page", responses((status = OK, body = Ro<PageRx<SynTaskVo>>)))]
#[debug_handler]
#[log_call]
pub async fn page(
    Query(dto): Query<SynTaskQueryDto>,
) -> Result<Json<Ro<PageRx<SynTaskVo>>>, CtrlError> {
    let (total, list) = SynTaskSvc::page(dto).await?;
    Ok(ok_page("查询任务分页成功", U64(1), total, list))
}

#[utoipa::path(get, path = "/syn/task/{id}", responses((status = OK, body = Ro<SynTaskVo>)))]
#[debug_handler]
#[log_call]
pub async fn get_by_id(Path(id): Path<U64>) -> Result<Json<Ro<SynTaskVo>>, CtrlError> {
    Ok(ok("查询任务成功", SynTaskSvc::get(id).await?))
}

#[utoipa::path(post, path = "/syn/task", request_body = SynTaskSaveDto,
    responses((status = OK, body = Ro<SynTaskVo>)))]
#[debug_handler]
#[log_call]
pub async fn create(
    headers: HeaderMap,
    Json(dto): Json<SynTaskSaveDto>,
) -> Result<Json<Ro<SynTaskVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("任务已创建", SynTaskSvc::create(dto, user).await?))
}

#[utoipa::path(put, path = "/syn/task/{id}", request_body = SynTaskSaveDto,
    responses((status = OK, body = Ro<SynTaskVo>)))]
#[debug_handler]
#[log_call]
pub async fn modify(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynTaskSaveDto>,
) -> Result<Json<Ro<SynTaskVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("任务已更新", SynTaskSvc::update(id, dto, user).await?))
}

#[utoipa::path(put, path = "/syn/task/{id}/enabled", request_body = SynTaskEnabledDto,
    responses((status = OK, body = Ro<SynTaskVo>)))]
#[debug_handler]
#[log_call]
pub async fn enabled(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynTaskEnabledDto>,
) -> Result<Json<Ro<SynTaskVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("任务状态已更新", SynTaskSvc::set_enabled(id, dto, user).await?))
}

#[utoipa::path(delete, path = "/syn/task/{id}", responses((status = OK, description = "已删除")))]
#[debug_handler]
#[log_call]
pub async fn del_by_id(
    Path(id): Path<U64>,
    headers: HeaderMap,
) -> Result<Json<Ro<()>>, CtrlError> {
    let _ = operator(&headers)?;
    SynTaskSvc::remove(id).await?;
    Ok(empty("任务已删除"))
}
