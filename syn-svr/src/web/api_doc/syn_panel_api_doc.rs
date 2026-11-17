use robotech::macros::api_doc;

/// # 控制面板导出 / 导入接口文档
///
/// `export` 会返回连接串明文，文档里单独说明：文件按密钥保管，不要放进工单附件。
#[api_doc(export, import)]
pub struct SynPanelApiDoc;
