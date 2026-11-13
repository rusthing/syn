use robotech::macros::api_doc;

/// # 自拉数据源接口文档（八个方法，含 pull）
#[api_doc(list, page, get_by_id, add, modify, enabled, del_by_id, pull)]
pub struct SynSourceApiDoc;
