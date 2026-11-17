//! # 控制面板导出 / 导入控制器
//!
//! 两个接口：
//!
//! - `GET /syn/panel/export`：导出三张业务表的配置快照。**这是唯一输出连接串明文的
//!   读接口**，文件本身就是密钥，前端会提示用户妥善保管。
//! - `POST /syn/panel/import`：把快照整批写回，单事务，覆盖或跳过已存在组件。
//!
//! 导入是写操作，取 `X-User-Id` 作审计列的 `creater_id` / `updater_id`。

use axum::Json;
use axum::debug_handler;
use axum::http::HeaderMap;
use robotech::api::Ro;
use robotech::macros::log_call;
use robotech::web::CtrlError;
use syn_api::{SynPanelExportVo, SynPanelImportDto, SynPanelImportVo};

use super::common::*;
use crate::svc::SynPanelSvc;

#[utoipa::path(get, path = "/syn/panel/export", responses((status = OK, body = Ro<SynPanelExportVo>)))]
#[debug_handler]
#[log_call]
pub async fn export() -> Result<Json<Ro<SynPanelExportVo>>, CtrlError> {
    Ok(ok("控制面板配置已导出", SynPanelSvc::export().await?))
}

#[utoipa::path(post, path = "/syn/panel/import", request_body = SynPanelImportDto,
    responses((status = OK, body = Ro<SynPanelImportVo>)))]
#[debug_handler]
#[log_call]
pub async fn import(
    headers: HeaderMap,
    Json(dto): Json<SynPanelImportDto>,
) -> Result<Json<Ro<SynPanelImportVo>>, CtrlError> {
    let user = operator(&headers)?;
    Ok(ok(
        "控制面板配置已导入",
        SynPanelSvc::import(dto, user).await?,
    ))
}
