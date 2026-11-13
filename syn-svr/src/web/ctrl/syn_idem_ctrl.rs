//! # 幂等台账控制器
//!
//! 只读分页。台账由执行器写，控制台不提供任何修改入口。

use axum::Json;
use axum::debug_handler;
use axum::extract::Query;
use robotech::api::{PageRx, Ro, U64};
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynIdemQueryDto, SynIdemVo};

use super::common::*;
use crate::svc::SynIdemSvc;

#[utoipa::path(get, path = "/syn/idem/page",
    responses((status = OK, body = Ro<PageRx<SynIdemVo>>)))]
#[debug_handler]
#[log_call]
pub async fn page(
    Query(dto): Query<SynIdemQueryDto>,
) -> Result<Json<Ro<PageRx<SynIdemVo>>>, CtrlError> {
    let (total, list) = SynIdemSvc::page(dto).await?;
    Ok(ok_page("查询幂等台账成功", U64(1), total, list))
}
