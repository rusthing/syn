use robotech::macros::api_doc;

/// # 同步任务接口文档
///
/// 七个手写方法全列；漏一个不报错，但 swagger 里就查不到那个接口。
#[api_doc(list, page, get_by_id, create, modify, enabled, del_by_id)]
pub struct SynTaskApiDoc;
