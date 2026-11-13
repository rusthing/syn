//! # 投递记录服务
//!
//! 只读，数据源是 `syn_idem`。库里没有逐次投递明细表，所以这里的「一条投递」其实是
//! 「一个 `(任务, 幂等键)` 的记账行」：没带幂等键的请求不会出现在列表里。
//! 字段口径见 [`SynDeliveryVo`](syn_api::SynDeliveryVo) 的文档表。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition};
use syn_api::{SynDeliveryQueryDto, SynDeliveryVo};

use super::syn_idem_svc::task_codes_and_topics;
use crate::dao::SynIdemDao;
use crate::mo::syn_idem::{Column as IdemColumn, Model as IdemModel};
use crate::mo::syn_task::{Column as TaskColumn, Model as TaskModel};

use crate::dao::SynTaskDao;

/// # 投递记录服务
pub struct SynDeliverySvc;

impl SynDeliverySvc {
    /// # 分页
    pub async fn page(dto: SynDeliveryQueryDto) -> Result<(U64, Vec<SynDeliveryVo>), SvcError> {
        let db = get_db_conn()?;
        let mut cond = Condition::all();
        if let Some(kw) = dto.keyword.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cond = cond.add(
                Condition::any()
                    .add(IdemColumn::IdemKey.contains(kw))
                    .add(IdemColumn::Code.contains(kw)),
            );
        }
        if let Some(code) = dto.task_code.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
                Condition::all().add(TaskColumn::Code.eq(code)),
                &None,
                db.as_ref(),
            )
            .await?;
            cond = cond.add(IdemColumn::TaskId.is_in(
                tasks.into_iter().map(|m| m.id).collect::<Vec<_>>(),
            ));
        }
        if let Some(v) = dto.verdict_code() {
            cond = cond.add(IdemColumn::Verdict.eq(v));
        }

        let (_, total, rows) = SynIdemDao::page_by_condition::<_, IdemModel>(
            cond,
            &Some("create_ms:desc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;

        let tasks = task_codes_and_topics(&rows, db.as_ref()).await?;
        let list = rows
            .into_iter()
            .map(|row| {
                let (task_code, topic) = tasks
                    .get(&row.task_id)
                    .cloned()
                    .unwrap_or_else(|| (String::new(), String::new()));
                SynDeliveryVo::new(row, task_code, (!topic.is_empty()).then_some(topic))
            })
            .collect();
        Ok((total, list))
    }
}
