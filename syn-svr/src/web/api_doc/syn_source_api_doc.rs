use robotech::macros::api_doc;

/// # 数据抽取接口文档（八个方法，含 pull）
#[api_doc(list, page, get_by_id, add, modify, enabled, del_by_id, pull)]
pub struct SynSourceApiDoc;
