//! # 数据源连接清单控制器
//!
//! 七个接口：列表 / 分页 / 详情 / 新建 / 修改 / 启停 / 删除。
//! 连接串明文只在写入口（`add` / `modify`）收，所有响应一律是脱敏后的
//! `SynDatasourceVo`（不含 `url`）。写操作都取 `X-User-Id` 作操作人。

use axum::Json;
use axum::debug_handler;
use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use robotech::api::{PageRx, Ro, U64};
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{
    SynDatasourceEnabledDto, SynDatasourceQueryDto, SynDatasourceSaveDto, SynDatasourceVo,
};

use super::common::*;
use crate::svc::SynDatasourceSvc;

#[utoipa::path(get, path = "/syn/datasource/list", responses((status = OK, body = Ro<Vec<SynDatasourceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn list() -> Result<Json<Ro<Vec<SynDatasourceVo>>>, CtrlError> {
    Ok(ok("查询数据源连接成功", SynDatasourceSvc::list().await?))
}

#[utoipa::path(get, path = "/syn/datasource/page", responses((status = OK, body = Ro<PageRx<SynDatasourceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn page(
    Query(dto): Query<SynDatasourceQueryDto>,
) -> Result<Json<Ro<PageRx<SynDatasourceVo>>>, CtrlError> {
    let (total, list) = SynDatasourceSvc::page(dto).await?;
    Ok(ok_page("查询数据源分页成功", U64(1), total, list))
}

#[utoipa::path(get, path = "/syn/datasource/{id}", responses((status = OK, body = Ro<SynDatasourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn get_by_id(Path(id): Path<U64>) -> Result<Json<Ro<SynDatasourceVo>>, CtrlError> {
    Ok(ok("查询数据源成功", SynDatasourceSvc::get(id).await?))
}

#[utoipa::path(post, path = "/syn/datasource", request_body = SynDatasourceSaveDto,
    responses((status = OK, body = Ro<SynDatasourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn add(
    headers: HeaderMap,
    Json(dto): Json<SynDatasourceSaveDto>,
) -> Result<Json<Ro<SynDatasourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok(
        "数据源已创建",
        SynDatasourceSvc::create(dto, user).await?,
    ))
}

#[utoipa::path(put, path = "/syn/datasource/{id}", request_body = SynDatasourceSaveDto,
    responses((status = OK, body = Ro<SynDatasourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn modify(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynDatasourceSaveDto>,
) -> Result<Json<Ro<SynDatasourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok(
        "数据源已更新",
        SynDatasourceSvc::update(id, dto, user).await?,
    ))
}

#[utoipa::path(put, path = "/syn/datasource/{id}/enabled", request_body = SynDatasourceEnabledDto,
    responses((status = OK, body = Ro<SynDatasourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn enabled(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynDatasourceEnabledDto>,
) -> Result<Json<Ro<SynDatasourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok(
        "数据源状态已更新",
        SynDatasourceSvc::set_enabled(id, dto, user).await?,
    ))
}

#[utoipa::path(delete, path = "/syn/datasource/{id}", responses((status = OK, description = "已删除")))]
#[debug_handler]
#[log_call]
pub async fn del_by_id(Path(id): Path<U64>, headers: HeaderMap) -> Result<Json<Ro<()>>, CtrlError> {
    let _ = operator(&headers)?;
    SynDatasourceSvc::remove(id).await?;
    Ok(empty("数据源已删除"))
}
