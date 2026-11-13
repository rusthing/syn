//! # 数据源连接清单控制器
//!
//! 只读一个接口。连接串的增删改属于部署配置（consul KV / `{pkg}.toml`），
//! 不落到控制台 —— 这个端点能写下游库，不能顺手给出改连接串的入口。

use axum::Json;
use axum::debug_handler;
use robotech::api::Ro;
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::SynDatasourceVo;

use super::common::*;
use crate::svc::SynDatasourceSvc;

#[utoipa::path(get, path = "/syn/datasource/list",
    responses((status = OK, body = Ro<Vec<SynDatasourceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn list() -> Result<Json<Ro<Vec<SynDatasourceVo>>>, CtrlError> {
    Ok(ok("查询数据源连接成功", SynDatasourceSvc::list()?))
}
