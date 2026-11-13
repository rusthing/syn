//! # 总览控制器
//!
//! 窗口参数 `1h / 6h / 24h / 7d`，认不出来按 24h —— 总览页不该因为一个拼错的
//! 查询参数白屏。

use axum::Json;
use axum::debug_handler;
use axum::extract::Query;
use robotech::api::Ro;
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynOverviewQueryDto, SynOverviewVo};

use super::common::*;
use crate::svc::SynOverviewSvc;

#[utoipa::path(get, path = "/syn/overview",
    responses((status = OK, body = Ro<SynOverviewVo>)))]
#[debug_handler]
#[log_call]
pub async fn overview(
    Query(dto): Query<SynOverviewQueryDto>,
) -> Result<Json<Ro<SynOverviewVo>>, CtrlError> {
    Ok(ok("查询总览成功", SynOverviewSvc::get(dto).await?))
}
