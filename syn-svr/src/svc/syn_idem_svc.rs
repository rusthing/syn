//! # 幂等台账服务
//!
//! 只读。`syn_idem` 由执行器在带 `X-Idempotency-Key` 的同步请求里写，控制台不提供
//! 写接口：手改台账等于把「这次到底做没做过」变成可以商量的事。
//!
//! 列表要显示任务**编码**而不是雪花 ID，所以查完台账再按 `task_id` 批量回查一次
//! `syn_task`。两次查询换来的是「台账表里不冗余存编码」—— 编码可改、ID 不变，
//! 冗余进去就得跟着改。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait};
use std::collections::{HashMap, HashSet};
use syn_api::{SynIdemQueryDto, SynIdemVo};

use crate::dao::{SynIdemDao, SynTaskDao};
use crate::mo::syn_idem::{Column as IdemColumn, Model as IdemModel};
use crate::mo::syn_task::{Column as TaskColumn, Model as TaskModel};

/// # 幂等台账服务
pub struct SynIdemSvc;

impl SynIdemSvc {
    /// # 分页
    pub async fn page(dto: SynIdemQueryDto) -> Result<(U64, Vec<SynIdemVo>), SvcError> {
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
            let ids: Vec<i64> = tasks.into_iter().map(|m| m.id).collect();
            // 没这个任务时传空集合而不是跳过条件：`IN ()` 查不到数据，才是「筛选了但没结果」
            cond = cond.add(IdemColumn::TaskId.is_in(ids));
        }

        let (_, total, rows) = SynIdemDao::page_by_condition::<_, IdemModel>(
            cond,
            &Some("create_ms:desc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;

        let codes = task_codes(&rows, db.as_ref()).await?;
        let list = rows
            .into_iter()
            .map(|row| {
                let task_code = codes.get(&row.task_id).cloned().unwrap_or_default();
                SynIdemVo {
                    id: U64::from(row.id),
                    task_code,
                    idem_key: row.idem_key,
                    verdict: syn_api::SyncVerdict::from_i16(row.verdict).unwrap_or_default(),
                    code: row.code,
                    create_ms: U64::from(row.create_ms),
                    update_ms: U64::from(row.update_ms),
                }
            })
            .collect();
        Ok((total, list))
    }
}

/// # 批量取 `task_id → 任务编码`
pub(crate) async fn task_codes<C: ConnectionTrait>(
    rows: &[IdemModel],
    db: &C,
) -> Result<HashMap<i64, String>, SvcError> {
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r.task_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
        Condition::all().add(TaskColumn::Id.is_in(ids)),
        &None,
        db,
    )
    .await?;
    Ok(tasks.into_iter().map(|m| (m.id, m.code)).collect())
}

/// # 批量取 `task_id → (编码, topic)`
///
/// 投递记录页要显示任务订阅的 topic，台账里只有 ID。
pub(crate) async fn task_codes_and_topics<C: ConnectionTrait>(
    rows: &[IdemModel],
    db: &C,
) -> Result<HashMap<i64, (String, String)>, SvcError> {
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r.task_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
        Condition::all().add(TaskColumn::Id.is_in(ids)),
        &None,
        db,
    )
    .await?;
    Ok(tasks
        .into_iter()
        .map(|m| (m.id, (m.code, m.topic)))
        .collect())
}
