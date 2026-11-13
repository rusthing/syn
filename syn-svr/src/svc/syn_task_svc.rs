//! # 同步任务服务
//!
//! 任务的写入口只有一条：**提交五段规则，列由规则推导**。
//!
//! `code` / `topic` / `priority` / `enabled` / `exclusive` 在表里是列（要建索引、
//! 要能 `where topic = ? order by priority` 直接筛），在 `spec` 里是同名字段。
//! 如果让调用方两边都填，两者不一致时行为就取决于「读的时候以谁为准」——
//! 所以这里只认 `spec`，落库时把列写成 `spec` 的投影，读的时候（[`crate::store`]）
//! 再以列为准，两边永远相等。
//!
//! ## 版本
//!
//! 每次保存 +1，并固化一份 `syn_task_version`。回滚「只是把指针指回去」这件事
//! 还没做，但快照先在，回滚才有材料。
//!
//! 启停**不**产生新版本：开关不是规则，给每次点击都记一版只会把历史淹掉。

use sea_orm::{ColumnTrait, Condition, IntoActiveModel, TransactionTrait};
use syn_api::{
    SpecIssue, SynTaskEnabledDto, SynTaskQueryDto, SynTaskSaveDto, SynTaskVo, TaskSpec,
};
use tracing::info;
use validator::Validate;
use wheel_rs::time_utils::now_ms;

use super::invalid;
use crate::dao::{SynTaskDao, SynTaskVersionDao};
use crate::mo::syn_task::{ActiveModel, Column, Model};
use crate::mo::syn_task_version::{ActiveModel as VersionModel};
use crate::store;
use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;

/// # 任务服务
pub struct SynTaskSvc;

impl SynTaskSvc {
    /// # 分页
    pub async fn page(dto: SynTaskQueryDto) -> Result<(U64, Vec<SynTaskVo>), SvcError> {
        let db = get_db_conn()?;
        let mut cond = Condition::all();
        if let Some(kw) = dto.keyword.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cond = cond.add(
                Condition::any()
                    .add(Column::Code.contains(kw))
                    .add(Column::Name.contains(kw))
                    .add(Column::Topic.contains(kw)),
            );
        }
        if let Some(topic) = dto.topic.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cond = cond.add(Column::Topic.eq(topic));
        }
        if let Some(enabled) = dto.enabled {
            cond = cond.add(Column::Enabled.eq(enabled));
        }

        let (_, total, list) = SynTaskDao::page_by_condition::<_, Model>(
            cond,
            &Some("priority:asc,id:asc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;
        Ok((total, list.into_iter().map(SynTaskVo::from).collect()))
    }

    /// # 全量列表
    ///
    /// 试跑页要按 topic 选任务，一次性给出比翻页省事；任务数量是「人维护的配置」，
    /// 不会多到需要流式。
    pub async fn list() -> Result<Vec<SynTaskVo>, SvcError> {
        let db = get_db_conn()?;
        let list = SynTaskDao::list_by_condition::<_, Model>(
            Condition::all(),
            &Some("priority:asc,id:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        Ok(list.into_iter().map(SynTaskVo::from).collect())
    }

    /// # 单条
    pub async fn get(id: U64) -> Result<SynTaskVo, SvcError> {
        let db = get_db_conn()?;
        let model = SynTaskDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("任务 {id} 不存在")))?;
        Ok(SynTaskVo::from(model))
    }

    /// # 新建
    pub async fn create(dto: SynTaskSaveDto, user: U64) -> Result<SynTaskVo, SvcError> {
        dto.validate()?;
        let spec = parse_spec(&dto.spec)?;
        let code = spec.id.clone();

        let db = get_db_conn()?;
        // 先查重再插入：唯一键冲突也会被 dao 翻译成 400，但那要等一次失败的写，
        // 而且提示是「任务编码重复」而不是「哪一条重了」
        if SynTaskDao::get_by_condition::<_, Model>(Condition::all().add(Column::Code.eq(&code)), db.as_ref())
            .await?
            .is_some()
        {
            return Err(invalid("code", format!("任务编码 {code} 已存在")));
        }

        let tx = db.begin().await.map_err(db_err)?;
        let model = SynTaskDao::insert(build_model(&spec, &dto, None, user), &tx).await?;
        insert_version(&model, 1, &dto.remark, user, &tx).await?;
        tx.commit().await.map_err(db_err)?;

        info!("任务 {code} 已创建（id={}）", model.id);
        // 本副本立即生效；别的副本靠 store 的巡检在下一拍跟上
        if let Err(e) = store::reload().await {
            tracing::warn!("任务已保存，但本地快照重载失败（下次巡检会补上）: {e}");
        }
        Ok(SynTaskVo::from(model))
    }

    /// # 修改
    pub async fn update(id: U64, dto: SynTaskSaveDto, user: U64) -> Result<SynTaskVo, SvcError> {
        dto.validate()?;
        let spec = parse_spec(&dto.spec)?;

        let db = get_db_conn()?;
        let existing = SynTaskDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("任务 {id} 不存在")))?;

        // 改编码等于换身份：日志、配置引用、幂等台账都按 code 指代，不允许原地改名
        if existing.code != spec.id {
            return Err(invalid(
                "spec.id",
                format!(
                    "任务编码不可修改（当前 {}，提交 {}）：编码是任务的对外标识",
                    existing.code, spec.id
                ),
            ));
        }
        if SynTaskDao::get_by_condition::<_, Model>(
            Condition::all()
                .add(Column::Code.eq(&spec.id))
                .add(Column::Id.ne(id.value() as i64)),
            db.as_ref(),
        )
        .await?
        .is_some()
        {
            return Err(invalid("code", format!("任务编码 {} 已存在", spec.id)));
        }

        let version = existing.version + 1;
        let tx = db.begin().await.map_err(db_err)?;
        let model = SynTaskDao::update(
            build_model(&spec, &dto, Some(existing), user),
            &tx,
        )
        .await?;
        insert_version(&model, version, &dto.remark, user, &tx).await?;
        tx.commit().await.map_err(db_err)?;

        info!("任务 {} 已更新到 v{version}", model.code);
        if let Err(e) = store::reload().await {
            tracing::warn!("任务已保存，但本地快照重载失败（下次巡检会补上）: {e}");
        }
        Ok(SynTaskVo::from(model))
    }

    /// # 启停
    ///
    /// 不产生新版本（开关不是规则），但 `spec.enabled` 与列要一起改：
    /// 只改列会让 [`crate::store`] 每次加载都记一条「spec 与列不一致」的 warn。
    pub async fn set_enabled(
        id: U64,
        dto: SynTaskEnabledDto,
        user: U64,
    ) -> Result<SynTaskVo, SvcError> {
        let db = get_db_conn()?;
        let mut model = SynTaskDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("任务 {id} 不存在")))?;

        model.enabled = dto.enabled;
        if let Some(obj) = model.spec.as_object_mut() {
            obj.insert("enabled".to_string(), serde_json::json!(dto.enabled));
        }
        let mut am = model.into_active_model();
        am.updater_id = sea_orm::ActiveValue::Set(user.value() as i64);
        am.update_ms = sea_orm::ActiveValue::Set(now_ms() as i64);
        let model = SynTaskDao::update(am, db.as_ref()).await?;

        if let Err(e) = store::reload().await {
            tracing::warn!("启停已保存，但本地快照重载失败（下次巡检会补上）: {e}");
        }
        Ok(SynTaskVo::from(model))
    }

    /// # 删除
    ///
    /// 版本快照与幂等台账都是 `on delete cascade`，一并清掉 —— 任务没了，
    /// 「哪个版本跑的」「这个键做过没有」就没有意义了。
    pub async fn remove(id: U64) -> Result<(), SvcError> {
        let db = get_db_conn()?;
        let model = SynTaskDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("任务 {id} 不存在")))?;
        let code = model.code.clone();
        SynTaskDao::delete(model.into_active_model(), db.as_ref()).await?;
        info!("任务 {code} 已删除");
        if let Err(e) = store::reload().await {
            tracing::warn!("任务已删除，但本地快照重载失败（下次巡检会补上）: {e}");
        }
        Ok(())
    }
}

/// # 解析并校验五段规则
///
/// 两步分开报错：结构反序列化失败是「字段名/类型写错」，返回 400 并指出具体位置；
/// 结构合法但自相矛盾（比如没有兜底判定）由 `TaskSpec::validate` 给出带 `path` 的清单。
fn parse_spec(value: &serde_json::Value) -> Result<TaskSpec, SvcError> {
    let spec: TaskSpec = serde_json::from_value(value.clone())
        .map_err(|e| invalid("spec", format!("spec 结构不合法：{e}")))?;
    if let Err(issues) = spec.validate() {
        return Err(invalid("spec", format_issues(&issues)));
    }
    Ok(spec)
}

fn format_issues(issues: &[SpecIssue]) -> String {
    issues
        .iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join("；")
}

/// # 由规则推导出一条实体
///
/// `existing` 为 `None` 时是新建（版本 1、审计取当前时间），否则是修改
/// （版本 +1、保留创建审计）。
fn build_model(
    spec: &TaskSpec,
    dto: &SynTaskSaveDto,
    existing: Option<Model>,
    user: U64,
) -> ActiveModel {
    let uid = user.value() as i64;
    let now = now_ms() as i64;
    let mut am = match existing {
        Some(model) => {
            let version = model.version + 1;
            let mut am = model.into_active_model();
            am.version = sea_orm::ActiveValue::Set(version);
            am.updater_id = sea_orm::ActiveValue::Set(uid);
            am.update_ms = sea_orm::ActiveValue::Set(now);
            am
        }
        None => {
            let mut am = ActiveModel::default();
            am.version = sea_orm::ActiveValue::Set(1);
            am.creater_id = sea_orm::ActiveValue::Set(uid);
            am.updater_id = sea_orm::ActiveValue::Set(uid);
            am.create_ms = sea_orm::ActiveValue::Set(now);
            am.update_ms = sea_orm::ActiveValue::Set(now);
            am
        }
    };
    let spec_value = serde_json::to_value(spec).unwrap_or(serde_json::Value::Null);
    am.code = sea_orm::ActiveValue::Set(spec.id.clone());
    am.name = sea_orm::ActiveValue::Set(dto.name.trim().to_string());
    am.topic = sea_orm::ActiveValue::Set(spec.topic.clone());
    am.priority = sea_orm::ActiveValue::Set(spec.priority);
    am.enabled = sea_orm::ActiveValue::Set(spec.enabled);
    am.exclusive = sea_orm::ActiveValue::Set(spec.exclusive);
    am.spec = sea_orm::ActiveValue::Set(spec_value);
    am.remark = sea_orm::ActiveValue::Set(
        dto.remark
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    );
    am
}

/// # 固化一份版本快照
async fn insert_version<C: sea_orm::ConnectionTrait>(
    task: &Model,
    version: i32,
    remark: &Option<String>,
    user: U64,
    db: &C,
) -> Result<(), SvcError> {
    let uid = user.value() as i64;
    let now = now_ms() as i64;
    let mut am = VersionModel::default();
    am.task_id = sea_orm::ActiveValue::Set(task.id);
    am.version = sea_orm::ActiveValue::Set(version);
    am.spec = sea_orm::ActiveValue::Set(task.spec.clone());
    am.remark = sea_orm::ActiveValue::Set(remark.clone());
    am.creater_id = sea_orm::ActiveValue::Set(uid);
    am.updater_id = sea_orm::ActiveValue::Set(uid);
    am.create_ms = sea_orm::ActiveValue::Set(now);
    am.update_ms = sea_orm::ActiveValue::Set(now);
    SynTaskVersionDao::insert(am, db).await?;
    Ok(())
}

/// `ConnectionTrait` 的事务方法直接返回 `DbErr`，不在 `SvcError` 的 `From` 列表里
fn db_err(e: sea_orm::DbErr) -> SvcError {
    SvcError::Runtime(anyhow::anyhow!(e.to_string()))
}
