//! # 投递记录控制器
//!
//! 只有一个分页查询。数据是 `syn_idem` 的投影，没有写接口，也没有独立明细表。

use axum::Json;
use axum::debug_handler;
use axum::extract::Query;
use robotech::api::{PageRx, Ro, U64};
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynDeliveryQueryDto, SynDeliveryVo};

use super::common::*;
use crate::svc::SynDeliverySvc;

#[utoipa::path(get, path = "/syn/delivery/page",
    responses((status = OK, body = Ro<PageRx<SynDeliveryVo>>)))]
#[debug_handler]
#[log_call]
pub async fn page(
    Query(dto): Query<SynDeliveryQueryDto>,
) -> Result<Json<Ro<PageRx<SynDeliveryVo>>>, CtrlError> {
    let (total, list) = SynDeliverySvc::page(dto).await?;
    Ok(ok_page("查询投递记录成功", U64(1), total, list))
}
