//! # 数据源连接清单服务
//!
//! 连接串（`url`）在 `syn_datasource` 表里维护，**明文只写不回显**：任何读接口
//! 都只经 `mask_url` 输出脱敏后的 `target`，`SynDatasourceVo` 里没有 `url`。
//!
//! 写入守住两条：新增必须给连接串；修改留空连接串时**不把它放进 ActiveModel
//! 变更集**，保留库里原值，其余字段照常更新并 `version + 1`。
//! 审计四列不进业务 DTO：按 `SynSourceSvc` 的形状由本层带入操作人并盖章，
//! 主键生成与创建者保护交给框架 DAO。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ActiveValue, ColumnTrait, Condition, IntoActiveModel};
use syn_api::{
    SynDatasourceEnabledDto, SynDatasourceQueryDto, SynDatasourceSaveDto, SynDatasourceVo,
};
use validator::Validate;
use wheel_rs::time_utils::now_ms;

use super::invalid;
use crate::dao::SynDatasourceDao;
use crate::db_sink::on_datasource_changed;
use crate::mo::syn_datasource::{ActiveModel, Column, Model};

/// # 数据源连接清单服务
pub struct SynDatasourceSvc;

impl SynDatasourceSvc {
    /// # 全量列表
    pub async fn list() -> Result<Vec<SynDatasourceVo>, SvcError> {
        let db = get_db_conn()?;
        let rows = SynDatasourceDao::list_by_condition::<_, Model>(
            Condition::all(),
            &Some("code:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        Ok(rows.into_iter().map(to_vo).collect())
    }

    /// # 分页
    ///
    /// 关键字匹配 `code` / `name` / `remark`；`url` 含账号密码，绝不参与检索。
    pub async fn page(dto: SynDatasourceQueryDto) -> Result<(U64, Vec<SynDatasourceVo>), SvcError> {
        let db = get_db_conn()?;
        let mut cond = Condition::all();
        if let Some(kw) = dto
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            cond = cond.add(
                Condition::any()
                    .add(Column::Code.contains(kw))
                    .add(Column::Name.contains(kw))
                    .add(Column::Remark.contains(kw)),
            );
        }
        if let Some(enabled) = dto.enabled {
            cond = cond.add(Column::Enabled.eq(enabled));
        }
        let (_, total, rows) = SynDatasourceDao::page_by_condition::<_, Model>(
            cond,
            &Some("code:asc".to_string()),
            U64(dto.page_num()),
            U64(dto.page_size()),
            db.as_ref(),
        )
        .await?;
        Ok((total, rows.into_iter().map(to_vo).collect()))
    }

    /// # 单条
    pub async fn get(id: U64) -> Result<SynDatasourceVo, SvcError> {
        let db = get_db_conn()?;
        let model = SynDatasourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        Ok(to_vo(model))
    }

    /// # 新建
    ///
    /// 连接串必填：`None` / 空串 / 纯空白一律视为没填。
    pub async fn create(
        mut dto: SynDatasourceSaveDto,
        user: U64,
    ) -> Result<SynDatasourceVo, SvcError> {
        // 先归一，避免 `Some("")` 撞 `length(min = 1)` 校验；必填判断与写入值
        // 共用这一份归一化结果。
        dto.url = normalized_url(&dto.url);
        dto.validate()?;
        let url = dto
            .url
            .clone()
            .ok_or_else(|| invalid("url", "新建数据源必须填写连接串"))?;
        let db = get_db_conn()?;
        if SynDatasourceDao::get_by_condition::<_, Model>(
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
        let model =
            SynDatasourceDao::insert(build_model(&dto, Some(url), None, user), db.as_ref()).await?;
        // 新数据源要能被立即取到：各副本清掉「这个 code 查不到」的结论
        on_datasource_changed().await;
        Ok(to_vo(model))
    }

    /// # 修改
    ///
    /// `url` 留空（`None` / 空串）时不写这一列，保留库里原连接串；其余字段照常
    /// 更新并 `version + 1`。
    pub async fn update(
        id: U64,
        mut dto: SynDatasourceSaveDto,
        user: U64,
    ) -> Result<SynDatasourceVo, SvcError> {
        dto.url = normalized_url(&dto.url);
        dto.validate()?;
        let url = dto.url.clone();
        let db = get_db_conn()?;
        let existing = SynDatasourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        let model =
            SynDatasourceDao::update(build_model(&dto, url, Some(existing), user), db.as_ref())
                .await?;
        // 连接串可能变了：不发信号的话，各副本会继续用旧池连旧库
        on_datasource_changed().await;
        Ok(to_vo(model))
    }

    /// # 启停
    pub async fn set_enabled(
        id: U64,
        dto: SynDatasourceEnabledDto,
        user: U64,
    ) -> Result<SynDatasourceVo, SvcError> {
        let db = get_db_conn()?;
        let model = SynDatasourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        let mut am = model.into_active_model();
        am.enabled = ActiveValue::Set(dto.enabled);
        am.updater_id = ActiveValue::Set(user.value() as i64);
        am.update_ms = ActiveValue::Set(now_ms() as i64);
        let model = SynDatasourceDao::update(am, db.as_ref()).await?;
        // 停用要立刻生效：已经建好的池不会自己下线
        on_datasource_changed().await;
        Ok(to_vo(model))
    }

    /// # 删除
    ///
    /// 直接删，引用检查不在本次范围。
    pub async fn remove(id: U64) -> Result<(), SvcError> {
        let db = get_db_conn()?;
        let model = SynDatasourceDao::get_by_id::<_, Model>(id, db.as_ref())
            .await?
            .ok_or_else(|| SvcError::NotFound(format!("数据源 {id} 不存在")))?;
        SynDatasourceDao::delete(model.into_active_model(), db.as_ref()).await?;
        on_datasource_changed().await;
        Ok(())
    }
}

/// # 由 DTO 推导实体
///
/// `url` 为 `Some` 才 `Set` 连接串；为 `None` 时**不动** `am.url`
/// （`into_active_model()` 带的是 `Unchanged`，不会进 UPDATE 的变更集），
/// 于是库里原值保持不变。新建走 `ActiveModel::default()`，此时 `url` 必为 `Some`。
fn build_model(
    dto: &SynDatasourceSaveDto,
    url: Option<String>,
    existing: Option<Model>,
    user: U64,
) -> ActiveModel {
    let uid = user.value() as i64;
    let now = now_ms() as i64;
    let mut am = match existing {
        Some(model) => {
            let version = model.version + 1;
            let mut am = model.into_active_model();
            am.version = ActiveValue::Set(version);
            am.updater_id = ActiveValue::Set(uid);
            am.update_ms = ActiveValue::Set(now);
            am
        }
        None => {
            let mut am = ActiveModel::default();
            am.version = ActiveValue::Set(1);
            am.creater_id = ActiveValue::Set(uid);
            am.updater_id = ActiveValue::Set(uid);
            am.create_ms = ActiveValue::Set(now);
            am.update_ms = ActiveValue::Set(now);
            am
        }
    };
    am.code = ActiveValue::Set(dto.code.trim().to_string());
    am.name = ActiveValue::Set(dto.name.trim().to_string());
    if let Some(u) = url {
        am.url = ActiveValue::Set(u);
    }
    am.max_connections = ActiveValue::Set(dto.max_connections as i32);
    am.enabled = ActiveValue::Set(dto.enabled);
    am.remark = ActiveValue::Set(
        dto.remark
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    );
    am
}

/// # Model → Vo
///
/// 唯一的「连接串出口」：`url` 只在这里被 `mask_url` 脱敏成 `target`，
/// 绝不进 Vo。审计与 ID 一律 `U64`（前端字符串，防 JS 精度丢失）。
fn to_vo(m: Model) -> SynDatasourceVo {
    SynDatasourceVo {
        id: U64::from(m.id),
        code: m.code,
        name: m.name,
        target: mask_url(&m.url),
        max_connections: m.max_connections as u32,
        enabled: m.enabled,
        remark: m.remark,
        version: m.version,
        creater_id: U64::from(m.creater_id),
        create_ms: U64::from(m.create_ms),
        updater_id: U64::from(m.updater_id),
        update_ms: U64::from(m.update_ms),
    }
}

/// # 连接串归一化（纯逻辑）
///
/// `None` / 空串 / 纯空白 → `None`（本次不提供）；否则返回去首尾空白后的值。
/// 新增时 `None` 触发「必须填写」，修改时 `None` 表示保留原值。
fn normalized_url(url: &Option<String>) -> Option<String> {
    url.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// # 连接串脱敏
///
/// 只保留 `user_info@` 之后、query 之前的部分。`postgres://u:p@host:5432/db?sslmode=disable`
/// → `host:5432/db`。解析不出 `@` 时（比如 unix socket 形态）返回 null，不猜也不外泄。
fn mask_url(url: &str) -> Option<String> {
    let after_user = url.split_once('@')?.1;
    let target = after_user
        .split(['?', '#'])
        .next()
        .unwrap_or(after_user)
        .trim();
    (!target.is_empty()).then(|| target.to_string())
}

#[cfg(test)]
mod tests {
    use super::{mask_url, normalized_url};

    #[test]
    fn masks_credentials_and_query() {
        assert_eq!(
            mask_url("postgresql://syn:secret@pgsql:5432/dtwrs_ui?sslmode=disable"),
            Some("pgsql:5432/dtwrs_ui".to_string())
        );
    }

    #[test]
    fn no_credentials_means_no_hint() {
        assert_eq!(mask_url("postgresql:///syn?host=/var/run/postgresql"), None);
    }

    #[test]
    fn normalizes_blank_url_to_none() {
        assert_eq!(normalized_url(&None), None);
        assert_eq!(normalized_url(&Some(String::new())), None);
        assert_eq!(normalized_url(&Some("   ".to_string())), None);
        assert_eq!(
            normalized_url(&Some("  postgresql://u:p@host:5432/db  ".to_string())),
            Some("postgresql://u:p@host:5432/db".to_string())
        );
    }
}
