//! # 自拉数据源服务
//!
//! 写入口要守住两件事：
//!
//! 1. **`spec` 的形状按 `kind` 分支校验**（sql 必须有 select + 游标列，http 必须有 url），
//!    拼错的查询不应该等调度器跑起来才炸；
//! 2. **虚拟 topic 由服务端拼**：`source:{code}` 是约定，让调用方手填会填出三种写法，
//!    而任务侧是按 topic 精确匹配的。
//!
//! 水位放在 `syn_cursor` 里，改配置不动它：停用再启用应该从原水位继续，不是从头重跑。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, IntoActiveModel};
use std::collections::HashMap;
use syn_api::{
    SourceSpec, SynSourceEnabledDto, SynSourcePullVo, SynSourceQueryDto,
    SynSourceSaveDto, SynSourceVo,
};
use tracing::info;
use validator::Validate;
use wheel_rs::time_utils::now_ms;

use super::invalid;
use crate::dao::{SynCursorDao, SynSourceDao};
use crate::mo::syn_cursor::{Column as CursorColumn, Model as CursorModel};
use crate::mo::syn_source::{ActiveModel, Column, Model};
use crate::poll;

/// # 自拉数据源服务
pub struct SynSourceSvc;

impl SynSourceSvc {
    /// # 分页
    pub async fn page(dto: SynSourceQueryDto) -> Result<(U64, Vec<SynSourceVo>), SvcError> {
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
        if let Some(kind) = dto.kind {
            cond = cond.add(Column::Kind.eq(i16::from(kind)));
        }
        if let Some(enabled) = dto.enabled {
            cond = cond.add(Column::Enabled.eq(enabled));
        }
        let (_, total, rows) = SynSourceDao::page_by_condition::<_, Model>(
            cond,
            &Some("code:asc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;
        let cursors = cursors_of(&rows, db.as_ref()).await?;
        Ok((
            total,
            rows.into_iter()
                .map(|m| {
                    let vo = SynSourceVo::from(m.clone());
                    vo.with_cursor(cursors.get(&m.id).cloned())
                })
                .collect(),
        ))
    }

    /// # 全量列表（调度器用）
    pub async fn list() -> Result<Vec<SynSourceVo>, SvcError> {
        let db = get_db_conn()?;
        let rows = SynSourceDao::list_by_condition::<_, Model>(
            Condition::all(),
            &Some("code:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        let cursors = cursors_of(&rows, db.as_ref()).await?;
        Ok(rows
            .into_iter()
            .map(|m| {
                let vo = SynSourceVo::from(m.clone());
                vo.with_cursor(cursors.get(&m.id).cloned())
            })
            .collect())
    }

    /// # 单条
    pub async fn get(id: U64) -> Result<SynSourceVo, SvcError> {
        let db = get_db_conn()?;
        let model = SynSourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        let cursor = SynCursorDao::get_by_condition::<_, CursorModel>(
            Condition::all().add(CursorColumn::SourceId.eq(model.id)),
            db.as_ref(),
        )
        .await?;
        Ok(SynSourceVo::from(model).with_cursor(cursor))
    }

    /// # 新建
    pub async fn create(dto: SynSourceSaveDto, user: U64) -> Result<SynSourceVo, SvcError> {
        dto.validate()?;
        let parsed = parse_spec(&dto)?;
        let topic = topic_of(&dto);
        let db = get_db_conn()?;
        if SynSourceDao::get_by_condition::<_, Model>(
            Condition::all().add(Column::Code.eq(dto.code.trim())),
            db.as_ref(),
        )
        .await?
        .is_some()
        {
            return Err(invalid(
                "code",
                format!("数据源编码 {} 已存在", dto.code.trim()),
            ));
        }
        let model = SynSourceDao::insert(build_model(&dto, parsed, topic, None, user), db.as_ref())
            .await?;
        info!("数据源 {} 已创建（id={}）", model.code, model.id);
        Ok(SynSourceVo::from(model))
    }

    /// # 修改
    pub async fn update(
        id: U64,
        dto: SynSourceSaveDto,
        user: U64,
    ) -> Result<SynSourceVo, SvcError> {
        dto.validate()?;
        let parsed = parse_spec(&dto)?;
        let db = get_db_conn()?;
        let existing = SynSourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        if existing.code != dto.code.trim() {
            return Err(invalid(
                "code",
                format!(
                    "数据源编码不可修改（当前 {}，提交 {}）：虚拟 topic 与游标都按它指代",
                    existing.code,
                    dto.code.trim()
                ),
            ));
        }
        let model = SynSourceDao::update(
            build_model(&dto, parsed, topic_of(&dto), Some(existing), user),
            db.as_ref(),
        )
        .await?;
        info!("数据源 {} 已更新到 v{}", model.code, model.version);
        // 改配置不动水位，但响应里也要把它带上：PUT 返回 `cursor: null` 会让调用方
        // 以为「还没跑过」，与 list / get 的形状不一致。
        let source_id = model.id;
        Ok(SynSourceVo::from(model).with_cursor(cursor_of(source_id, db.as_ref()).await?))
    }

    /// # 启停
    ///
    /// 不碰 `syn_cursor`：停用期间水位原样留着，重新启用从断点继续。
    pub async fn set_enabled(
        id: U64,
        dto: SynSourceEnabledDto,
        user: U64,
    ) -> Result<SynSourceVo, SvcError> {
        let db = get_db_conn()?;
        let mut model = SynSourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        model.enabled = dto.enabled;
        let mut am = model.into_active_model();
        am.updater_id = sea_orm::ActiveValue::Set(user.value() as i64);
        am.update_ms = sea_orm::ActiveValue::Set(now_ms() as i64);
        let model = SynSourceDao::update(am, db.as_ref()).await?;
        let source_id = model.id;
        Ok(SynSourceVo::from(model).with_cursor(cursor_of(source_id, db.as_ref()).await?))
    }

    /// # 删除
    ///
    /// 游标是 `on delete cascade`，跟着一起清掉。
    pub async fn remove(id: U64) -> Result<(), SvcError> {
        let db = get_db_conn()?;
        let model = SynSourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        let code = model.code.clone();
        SynSourceDao::delete(model.into_active_model(), db.as_ref()).await?;
        info!("数据源 {code} 已删除");
        Ok(())
    }

    /// # 立即拉一轮
    ///
    /// 与周期调度走**同一个** `poll::pull_once`，不给运维入口另写一套逻辑。
    pub async fn pull(id: U64) -> Result<SynSourcePullVo, SvcError> {
        poll::pull_once(id).await
    }

    /// # 立即拉取；`reset` 为真时先把水位清零
    ///
    /// 只对 http 全量源有意义（翻到底之后要重跑），sql 源调用等价于「从头拉一遍」。
    pub async fn pull_with_reset(id: U64, reset: bool) -> Result<SynSourcePullVo, SvcError> {
        if reset {
            poll::reset_full(id).await?;
        }
        poll::pull_once(id).await
    }
}

/// # 解析并校验取数定义
fn parse_spec(dto: &SynSourceSaveDto) -> Result<serde_json::Value, SvcError> {
    let spec = SourceSpec::parse(&dto.spec)
        .map_err(|e| invalid("spec", format!("spec 结构不合法：{e}")))?;
    if let Err(issues) = spec.validate(dto.kind) {
        let detail = issues
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("；");
        return Err(invalid("spec", detail));
    }
    // 间隔必须能被解析，且不小于 1s：更密的调度只会把源库打满
    let interval = humantime::parse_duration(&dto.interval_duration)
        .map_err(|e| invalid("intervalDuration", format!("调度间隔不合法：{e}")))?;
    if interval < std::time::Duration::from_secs(1) {
        return Err(invalid("intervalDuration", "调度间隔不能小于 1s"));
    }
    Ok(dto.spec.clone())
}

/// 虚拟 topic：留空由服务端按约定拼
fn topic_of(dto: &SynSourceSaveDto) -> String {
    dto.topic
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("source:{}", dto.code.trim()))
}

/// # 由 DTO 推导实体
fn build_model(
    dto: &SynSourceSaveDto,
    spec: serde_json::Value,
    topic: String,
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
    am.code = sea_orm::ActiveValue::Set(dto.code.trim().to_string());
    am.name = sea_orm::ActiveValue::Set(dto.name.trim().to_string());
    am.kind = sea_orm::ActiveValue::Set(i16::from(dto.kind));
    am.topic = sea_orm::ActiveValue::Set(topic);
    am.enabled = sea_orm::ActiveValue::Set(dto.enabled);
    am.interval_duration = sea_orm::ActiveValue::Set(dto.interval_duration.trim().to_string());
    am.batch_size = sea_orm::ActiveValue::Set(dto.batch_size);
    am.spec = sea_orm::ActiveValue::Set(spec);
    am.remark = sea_orm::ActiveValue::Set(
        dto.remark
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    );
    am
}

/// # 单条水位。`create` 不需要它（新来源还没跑过），`update` / `set_enabled` 需要
async fn cursor_of<C: sea_orm::ConnectionTrait>(
    source_id: i64,
    db: &C,
) -> Result<Option<CursorModel>, SvcError> {
    Ok(SynCursorDao::get_by_condition::<_, CursorModel>(
        Condition::all().add(CursorColumn::SourceId.eq(source_id)),
        db,
    )
    .await?)
}

/// # 批量取水位
async fn cursors_of<C: sea_orm::ConnectionTrait>(
    rows: &[Model],
    db: &C,
) -> Result<HashMap<i64, CursorModel>, SvcError> {
    let ids: Vec<i64> = rows.iter().map(|m| m.id).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let cursors = SynCursorDao::list_by_condition::<_, CursorModel>(
        Condition::all().add(CursorColumn::SourceId.is_in(ids)),
        &None,
        db,
    )
    .await?;
    Ok(cursors.into_iter().map(|c| (c.source_id, c)).collect())
}

/// # 给调度器用的轻量形态
///
/// 调度器只需要「哪些启用的源该跑了」，不需要 VO 那一整套审计字段。
pub async fn enabled_sources() -> Result<Vec<Model>, SvcError> {
    let db = get_db_conn()?;
    Ok(SynSourceDao::list_by_condition::<_, Model>(
        Condition::all().add(Column::Enabled.eq(true)),
        &Some("code:asc".to_string()),
        db.as_ref(),
    )
    .await?)
}
