//! # 手写控制器的共用封装
//!
//! 只做三件事：把纯值包进 `Ro`、把 `(总数, 列表)` 包进 `PageRx`、取 `X-User-Id`。
//! 不放任何业务判断 —— 五个 ctrl 长得一样，是为了让「接口形状」一眼能比出来。

use axum::Json;
use axum::http::HeaderMap;
use robotech::api::{PageRx, Ro, U64};
use robotech::web::CtrlError;
use robotech::web::ctrl_utils::get_current_user_id;
use serde::Serialize;

/// 单值 / 列表响应
pub fn ok<T: Serialize>(msg: &str, data: T) -> Json<Ro<T>> {
    Json(Ro::success(msg.to_string()).extra(Some(data)))
}

/// 分页响应。`page_num` 由 DAO 返回（超页时它会被夹到最后一页）
pub fn ok_page<T: Serialize>(
    msg: &str,
    page_num: U64,
    total: U64,
    list: Vec<T>,
) -> Json<Ro<PageRx<T>>> {
    Json(Ro::success(msg.to_string()).extra(Some(
        PageRx::builder()
            .page_num(page_num)
            .total(total)
            .list(list)
            .build(),
    )))
}

/// 无返回体的写操作。前端只判 `result`，`extra` 留空
pub fn empty(msg: &str) -> Json<Ro<()>> {
    Json(Ro::<()>::success(msg.to_string()))
}

/// 写操作必须带操作人；缺头由框架给出带期望值的校验错误
#[allow(clippy::result_large_err)]
pub fn operator(headers: &HeaderMap) -> Result<U64, CtrlError> {
    Ok(get_current_user_id(headers)?)
}
