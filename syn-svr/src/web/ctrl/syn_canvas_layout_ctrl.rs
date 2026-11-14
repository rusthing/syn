//! # 画布布局控制器
//!
//! 两个接口：读全量坐标、批量保存变动过的坐标。没有单条、分页、删除 ——
//! 布局是纯展示态，形状越简单越好。

use axum::Json;
use axum::debug_handler;
use axum::http::HeaderMap;
use robotech::api::Ro;
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynCanvasLayoutSaveDto, SynCanvasLayoutVo};

use super::common::*;
use crate::svc::SynCanvasLayoutSvc;

#[utoipa::path(get, path = "/syn/canvas/layout", responses((status = OK, body = Ro<Vec<SynCanvasLayoutVo>>)))]
#[debug_handler]
#[log_call]
pub async fn layout() -> Result<Json<Ro<Vec<SynCanvasLayoutVo>>>, CtrlError> {
    Ok(ok("查询画布布局成功", SynCanvasLayoutSvc::list().await?))
}

#[utoipa::path(put, path = "/syn/canvas/layout", request_body = SynCanvasLayoutSaveDto,
    responses((status = OK, body = Ro<Vec<SynCanvasLayoutVo>>)))]
#[debug_handler]
#[log_call]
pub async fn save_layout(
    headers: HeaderMap,
    Json(dto): Json<SynCanvasLayoutSaveDto>,
) -> Result<Json<Ro<Vec<SynCanvasLayoutVo>>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("画布布局已保存", SynCanvasLayoutSvc::save(dto, user).await?))
}
