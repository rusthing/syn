//! # 自拉数据源控制器
//!
//! 八个接口：七个人配的 CRUD/启停 + 一个 `pull`。`pull` 既是运维的「立即拉取」，
//! 也是 jobx 定时打的那个端点 —— 只有一条实现，不存在「定时跑的和手动跑的不一样」。

use axum::Json;
use axum::debug_handler;
use axum::extract::{Path, Query};
use axum::http::HeaderMap;
use robotech::api::{PageRx, Ro, U64};
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{
    SynSourceEnabledDto, SynSourcePullVo, SynSourceQueryDto, SynSourceSaveDto, SynSourceVo,
};

use super::common::*;
use crate::svc::SynSourceSvc;

#[utoipa::path(get, path = "/syn/source/list", responses((status = OK, body = Ro<Vec<SynSourceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn list() -> Result<Json<Ro<Vec<SynSourceVo>>>, CtrlError> {
    Ok(ok("查询数据源列表成功", SynSourceSvc::list().await?))
}

#[utoipa::path(get, path = "/syn/source/page", responses((status = OK, body = Ro<PageRx<SynSourceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn page(
    Query(dto): Query<SynSourceQueryDto>,
) -> Result<Json<Ro<PageRx<SynSourceVo>>>, CtrlError> {
    let (total, list) = SynSourceSvc::page(dto).await?;
    Ok(ok_page("查询数据源分页成功", U64(1), total, list))
}

#[utoipa::path(get, path = "/syn/source/{id}", responses((status = OK, body = Ro<SynSourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn get_by_id(Path(id): Path<U64>) -> Result<Json<Ro<SynSourceVo>>, CtrlError> {
    Ok(ok("查询数据源成功", SynSourceSvc::get(id).await?))
}

#[utoipa::path(post, path = "/syn/source", request_body = SynSourceSaveDto,
    responses((status = OK, body = Ro<SynSourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn add(
    headers: HeaderMap,
    Json(dto): Json<SynSourceSaveDto>,
) -> Result<Json<Ro<SynSourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("数据源已创建", SynSourceSvc::create(dto, user).await?))
}

#[utoipa::path(put, path = "/syn/source/{id}", request_body = SynSourceSaveDto,
    responses((status = OK, body = Ro<SynSourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn modify(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynSourceSaveDto>,
) -> Result<Json<Ro<SynSourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("数据源已更新", SynSourceSvc::update(id, dto, user).await?))
}

#[utoipa::path(put, path = "/syn/source/{id}/enabled", request_body = SynSourceEnabledDto,
    responses((status = OK, body = Ro<SynSourceVo>)))]
#[debug_handler]
#[log_call]
pub async fn enabled(
    Path(id): Path<U64>,
    headers: HeaderMap,
    Json(dto): Json<SynSourceEnabledDto>,
) -> Result<Json<Ro<SynSourceVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok("数据源状态已更新", SynSourceSvc::set_enabled(id, dto, user).await?))
}

#[utoipa::path(delete, path = "/syn/source/{id}", responses((status = OK, description = "已删除")))]
#[debug_handler]
#[log_call]
pub async fn del_by_id(
    Path(id): Path<U64>,
    headers: HeaderMap,
) -> Result<Json<Ro<()>>, CtrlError> {
    let _ = operator(&headers)?;
    SynSourceSvc::remove(id).await?;
    Ok(empty("数据源已删除"))
}

/// `pull` 的查询参数
#[derive(Debug, Default, serde::Deserialize)]
pub struct PullQuery {
    /// 先清零水位再拉：http 全量源「翻到底」之后要重跑时用
    #[serde(default)]
    pub reset: bool,
}

#[utoipa::path(post, path = "/syn/source/{id}/pull",
    params(
        ("id" = u64, Path, description = "数据源 ID"),
        ("reset" = Option<bool>, Query, description = "先清零水位再拉（http 全量重跑）")
    ),
    responses((status = OK, body = Ro<SynSourcePullVo>)))]
#[debug_handler]
#[log_call]
pub async fn pull(
    Path(id): Path<U64>,
    Query(q): Query<PullQuery>,
) -> Result<Json<Ro<SynSourcePullVo>>, CtrlError> {
    Ok(ok(
        "本轮拉取完成",
        SynSourceSvc::pull_with_reset(id, q.reset).await?,
    ))
}
