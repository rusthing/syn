//! # 注册中心服务名候选控制器
//!
//! 只读一个接口：`GET /syn/registry/services`。返回空数组是正常结果（注册中心没配、
//! 后端不支持枚举、临时不可达），不是错误 —— 见 `SynServiceSvc` 的模块文档。

use axum::Json;
use axum::debug_handler;
use robotech::api::Ro;
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::SynServiceVo;

use super::common::*;
use crate::svc::SynServiceSvc;

#[utoipa::path(get, path = "/syn/registry/services",
    responses((status = OK, body = Ro<Vec<SynServiceVo>>)))]
#[debug_handler]
#[log_call]
pub async fn services() -> Result<Json<Ro<Vec<SynServiceVo>>>, CtrlError> {
    Ok(ok("查询注册中心服务名成功", SynServiceSvc::list().await))
}
