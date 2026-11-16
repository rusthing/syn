//! # 数据抽取服务
//!
//! 写入口要守住两件事：
//!
//! 1. **`spec` 的形状按 `kind` / `mode` 分支校验**（sql 必须有表名，游标增量还要
//!    主游标 + 决胜字段；http 必须有 url），拼错的配置不应该等调度器跑起来才炸；
//! 2. **虚拟 topic 由服务端拼**：`source:{code}` 是约定，让调用方手填会填出三种写法，
//!    而任务侧是按 topic 精确匹配的。
//!
//! 水位放在 `syn_cursor` 里，改配置不动它：停用再启用应该从原水位继续，不是从头重跑。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, IntoActiveModel};
use std::collections::HashMap;
use syn_api::{
    SourceKind, SourceSpec, SynSourceEnabledDto, SynSourcePullVo, SynSourceQueryDto,
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

/// # 数据抽取服务
pub struct SynSourceSvc;

impl SynSourceSvc {
    /// # 分页
    /// 返回 `(实际页码, 总数, 列表)`；页码超页时由 DAO 夹到最后一页。
    pub async fn page(dto: SynSourceQueryDto) -> Result<(U64, U64, Vec<SynSourceVo>), SvcError> {
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
        let (page_num, total, rows) = SynSourceDao::page_by_condition::<_, Model>(
            cond,
            &Some("code:asc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;
        let cursors = cursors_of(&rows, db.as_ref()).await?;
        Ok((
            page_num,
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
            .ok_or_else(|| SvcError::NotFound(format!("数据抽取 {id} 不存在")))?;
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
                format!("数据抽取编码 {} 已存在", dto.code.trim()),
            ));
        }
        // 库里对 topic 有唯一约束，但撞约束只会回一个 500；先查一遍，把冲突对象说清楚
        ensure_topic_available(&topic, None, db.as_ref()).await?;
        let model = SynSourceDao::insert(build_model(&dto, parsed, topic, None, user), db.as_ref())
            .await?;
        info!("数据抽取 {} 已创建（id={}）", model.code, model.id);
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
            .ok_or_else(|| SvcError::NotFound(format!("数据抽取 {id} 不存在")))?;
        if existing.code != dto.code.trim() {
            return Err(invalid(
                "code",
                format!(
                    "数据抽取编码不可修改（当前 {}，提交 {}）：虚拟 topic 与游标都按它指代",
                    existing.code,
                    dto.code.trim()
                ),
            ));
        }
        // 水位只对「当初那套抽取定义」有意义：定义一换，旧值可能把历史数据整段跳过
        // （例如主游标从 updated_at 换成 created_at，类型都一样，但含义全变）。
        // 这里只判「要不要清」，真正清在更新成功之后做，避免保存失败也把水位弄丢。
        let old_spec = SourceSpec::parse(&existing.spec).unwrap_or_default();
        let old_kind = SourceKind::from_i16(existing.kind).unwrap_or_default();
        let new_spec = SourceSpec::parse(&parsed).unwrap_or_default();
        let reset_water_level = cursor_basis_changed(old_kind, &old_spec, dto.kind, &new_spec);
        // 改 topic 与新建走同一条唯一性规则，排除自己
        let topic = topic_of(&dto);
        ensure_topic_available(&topic, Some(existing.id), db.as_ref()).await?;

        let model = SynSourceDao::update(
            build_model(&dto, parsed, topic, Some(existing), user),
            db.as_ref(),
        )
        .await?;
        info!("数据抽取 {} 已更新到 v{}", model.code, model.version);
        if reset_water_level {
            let code = model.code.clone();
            poll::reset_full(id).await?;
            info!("数据抽取 {code} 的抽取定义变更，水位已清空，下一轮从起点重跑");
        }
        // 改配置不动水位，但响应里也要把它带上：PUT 返回 `cursor: null` 会让调用方
        // 以为「还没跑过」，与 list / get 的形状不一致。
        let source_id = model.id;
        let mut vo = SynSourceVo::from(model).with_cursor(cursor_of(source_id, db.as_ref()).await?);
        if reset_water_level {
            vo.notice = Some(
                "抽取定义已变更，水位已自动清空，下一轮将从起点重新同步（重复数据由下游 upsert 吸收）"
                    .to_string(),
            );
        }
        Ok(vo)
    }

    /// # 启停
    ///
    /// 不碰 `syn_cursor`：停用期间水位原样留着，重新启用从断点继续。
    ///
    /// `enabled` 必须显式 `ActiveValue::Set`：`into_active_model()` 带的是 `Unchanged`，
    /// 只改 model 字段的话 UPDATE 里根本不会出现这一列（接口 200 但开关不生效）。
    pub async fn set_enabled(
        id: U64,
        dto: SynSourceEnabledDto,
        user: U64,
    ) -> Result<SynSourceVo, SvcError> {
        let db = get_db_conn()?;
        let model = SynSourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据抽取 {id} 不存在")))?;
        let mut am = model.into_active_model();
        am.enabled = sea_orm::ActiveValue::Set(dto.enabled);
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
            .ok_or_else(|| SvcError::NotFound(format!("数据抽取 {id} 不存在")))?;
        let code = model.code.clone();
        SynSourceDao::delete(model.into_active_model(), db.as_ref()).await?;
        info!("数据抽取 {code} 已删除");
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
    /// 对全量源（sql 快照 / http）是「重跑全量」，对游标增量等价于「从头拉一遍」。
    pub async fn pull_with_reset(id: U64, reset: bool) -> Result<SynSourcePullVo, SvcError> {
        if reset {
            poll::reset_full(id).await?;
        }
        poll::pull_once(id).await
    }
}

/// # 解析并校验抽取定义
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

/// # topic 唯一性预检
///
/// 库里对 `syn_source.topic` 有唯一约束，但直接撞约束只会回一个笼统的 500。
/// 这里先查一遍：冲突时把**占用者**（编码 + 名称）写进错误，保存的人才知道该改哪个。
/// 任务按 topic 精确匹配，两个数据抽取共用一个 topic 会互相串数据，不能只是「允许重复」。
///
/// `self_id` 用于修改：同一个数据抽取保持 topic 不变时不算冲突。
async fn ensure_topic_available<C: ConnectionTrait>(
    topic: &str,
    self_id: Option<i64>,
    db: &C,
) -> Result<(), SvcError> {
    let mut cond = Condition::all().add(Column::Topic.eq(topic));
    if let Some(id) = self_id {
        cond = cond.add(Column::Id.ne(id));
    }
    if let Some(other) = SynSourceDao::get_by_condition::<_, Model>(cond, db).await? {
        return Err(invalid(
            "topic",
            format!(
                "虚拟 topic {} 已被数据抽取 {}（{}）占用；任务按 topic 精确匹配，两个数据抽取不能共用一个",
                topic, other.code, other.name
            ),
        ));
    }
    Ok(())
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

/// # 抽取定义里「决定水位含义」的部分是否变了
///
/// 变了就必须清空水位：旧值会被直接套到新定义上，可能把历史数据整段跳过。
/// 典型场景：主游标从 `updated_at` 换成 `created_at` —— 类型一样，校验也不会报错，
/// 但 `> 旧 updated_at` 对新列毫无意义。
///
/// 只比语义相关的字段：改名称、备注、间隔、批量大小都不影响水位。
fn cursor_basis_changed(
    old_kind: SourceKind,
    old: &SourceSpec,
    new_kind: SourceKind,
    new: &SourceSpec,
) -> bool {
    if old_kind != new_kind {
        return true;
    }
    match new_kind {
        SourceKind::Sql => {
            trim_or_empty(&old.datasource) != trim_or_empty(&new.datasource)
                || old.mode != new.mode
                || old.table_or_empty() != new.table_or_empty()
                || normalize_sql(&old.sql) != normalize_sql(&new.sql)
                || old.cursor_fields() != new.cursor_fields()
                || old.cursor_type != new.cursor_type
                || old.tie_type != new.tie_type
                || old.snapshot_batched != new.snapshot_batched
        }
        // 全量的进度是「页码 / token」，由这几个字段定义；换了接口这些值就不再指代同一批数据
        SourceKind::Http => {
            trim_or_empty(&old.url) != trim_or_empty(&new.url)
                || trim_or_empty(&old.next_path) != trim_or_empty(&new.next_path)
                || old.page_size != new.page_size
        }
    }
}

fn trim_or_empty(v: &Option<String>) -> &str {
    v.as_deref().map(str::trim).unwrap_or("")
}

/// 手写 SQL 只忽略首尾空白与结尾分号：语义变了就要清水位
fn normalize_sql(sql: &Option<String>) -> String {
    sql.as_deref()
        .map(str::trim)
        .unwrap_or("")
        .trim_end_matches(';')
        .trim()
        .to_string()
}

/// # 单条水位。`create` 不需要它（新数据抽取还没跑过），`update` / `set_enabled` 需要
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

#[cfg(test)]
mod tests {
    use super::*;
    use syn_api::{ExtractMode, FieldType};

    fn sql_spec(table: &str, cursor_field: &str) -> SourceSpec {
        SourceSpec {
            datasource: Some("dtw".to_string()),
            mode: ExtractMode::Cursor,
            table: Some(table.to_string()),
            cursor_field: Some(cursor_field.to_string()),
            cursor_type: FieldType::Timestamptz,
            tie_field: Some("id".to_string()),
            tie_type: FieldType::Bigint,
            ..Default::default()
        }
    }

    #[test]
    fn cursor_basis_ignores_cosmetic_changes() {
        let old = sql_spec("t", "updated_at");
        // 首尾空白不算语义变化
        let new = sql_spec(" t ", " updated_at ");
        assert!(!cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &new
        ));
    }

    #[test]
    fn cursor_basis_tracks_sql_semantics() {
        let old = sql_spec("t", "updated_at");
        // 类型一样，但换了主游标之后旧水位不再指代同一批数据
        let switched = sql_spec("t", "created_at");
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &switched
        ));
        let other_datasource = SourceSpec {
            datasource: Some("other".to_string()),
            ..old.clone()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &other_datasource
        ));
        // 快照 ↔ 游标是两套完全不同的进度语义
        let snapshot = SourceSpec {
            mode: ExtractMode::Snapshot,
            ..old.clone()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &snapshot
        ));
        // 决胜字段、表名、分批开关变了同样要清
        let other_tie = SourceSpec {
            tie_field: Some("seq".to_string()),
            ..old.clone()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &other_tie
        ));
        let other_table = sql_spec("t2", "updated_at");
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &other_table
        ));
        let batched = SourceSpec {
            snapshot_batched: true,
            ..snapshot.clone()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &snapshot,
            SourceKind::Sql,
            &batched
        ));
        // 手写了 SQL 就是另一套行来源，旧水位不能沿用
        let handwritten = SourceSpec {
            sql: Some("select id, updated_at from t where deleted = false".to_string()),
            ..old.clone()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &handwritten
        ));
        // 只是结尾分号 / 空白差异不算变化
        let same_sql = SourceSpec {
            sql: old.sql.as_ref().map(|s| format!("  {s}; ")),
            ..old.clone()
        };
        assert!(!cursor_basis_changed(
            SourceKind::Sql,
            &old,
            SourceKind::Sql,
            &same_sql
        ));
    }

    #[test]
    fn cursor_basis_tracks_kind_and_http_endpoint() {
        let sql = sql_spec("t", "updated_at");
        let mut http = SourceSpec {
            url: Some("/api/list".to_string()),
            ..Default::default()
        };
        assert!(cursor_basis_changed(
            SourceKind::Sql,
            &sql,
            SourceKind::Http,
            &http
        ));
        // 同一套 http 定义不动水位
        assert!(!cursor_basis_changed(
            SourceKind::Http,
            &http,
            SourceKind::Http,
            &http.clone()
        ));
        http.url = Some("/api/v2/list".to_string());
        let old_http = SourceSpec {
            url: Some("/api/list".to_string()),
            ..Default::default()
        };
        assert!(cursor_basis_changed(
            SourceKind::Http,
            &old_http,
            SourceKind::Http,
            &http
        ));
    }
}
