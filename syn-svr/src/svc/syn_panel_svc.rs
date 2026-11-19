//! # 控制面板导出 / 导入服务
//!
//! 控制面板的画布不落库：节点由 `syn_datasource` / `syn_source` / `syn_task` 三张表
//! 现拼，连线由引用关系现算。所以「导出面板」就是导出这三张表的配置快照，
//! 导入就是按依赖顺序（数据源 → 数据抽取 → 任务）把快照写回去。
//!
//! ## 三条边界
//!
//! 1. **运行状态不进文件**：游标水位、最近拉取结果属于部署环境，换一套库后照搬
//!    会跳过一整段数据。启停是配置，照文件恢复；抽取定义变了（游标字段 / 表 /
//!    SQL / 模式），旧水位没有意义，导入时直接删掉游标行，让下一轮从起点重拉。
//! 2. **连接串明文只从本模块的导出接口出**：其余读接口仍走 `mask_url`。文件本身
//!    含账号密码，前端提示按密钥管理。
//! 3. **导入是一个事务**：任何一条校验/写入失败，整批回滚。重跑幂等 ——
//!    覆盖模式写同样的文件结果不变，失败修好后原样再导即可。
//!
//! 任务没有业务编码，身份用「主题 + 名称」：同主题同名时优先匹配排序值相同的那条。
//! 这条规则比按 id 匹配更适合跨环境迁移，但重名任务无法区分，界面在导入预览里
//! 会把它列清楚。

use std::collections::{HashMap, HashSet};

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, DatabaseTransaction, IntoActiveModel, TransactionTrait};
use serde_json::{Map, Value, json};
use syn_api::{
    DbEngine, SourceKind, SourceSpec, SynPanelDatasourceVo, SynPanelExportVo, SynPanelImportCounts,
    SynPanelImportDto, SynPanelImportMode, SynPanelImportVo, SynPanelSourceVo, SynPanelTaskVo,
    SynTaskSaveDto, TaskSpec,
};
use tracing::warn;
use validator::Validate;

use super::syn_datasource_svc::{build_model as build_datasource_model, mask_url, normalized_url};
use super::syn_source_svc::{
    build_model as build_source_model, cursor_basis_changed, ensure_topic_available,
    parse_spec as parse_source_spec, topic_of,
};
use super::syn_task_svc::{
    build_model as build_task_model, insert_version, parse_spec as parse_task_spec,
};
use super::{db_err, invalid};
use crate::dao::{SynCursorDao, SynDatasourceDao, SynSourceDao, SynTaskDao};
use crate::db_sink::on_datasource_changed;
use crate::mo::syn_cursor::{Column as CursorColumn, Model as CursorModel};
use crate::mo::syn_datasource::Model as DatasourceModel;
use crate::mo::syn_source::Model as SourceModel;
use crate::mo::syn_task::Model as TaskModel;
use crate::store;

/// # 控制面板配置服务
pub struct SynPanelSvc;

impl SynPanelSvc {
    /// # 导出整张面板的配置
    ///
    /// 只读三张业务表，不读 `syn_cursor`：运行状态不进文件。
    /// 数据源按 `code` 升序、数据抽取按 `topic` 升序、任务按 `sort_order, id` 升序 ——
    /// 文件里的顺序稳定，两次导出可以直接 diff。
    pub async fn export() -> Result<SynPanelExportVo, SvcError> {
        let db = get_db_conn()?;
        let datasources = SynDatasourceDao::list_by_condition::<_, DatasourceModel>(
            Condition::all(),
            &Some("code:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        let sources = SynSourceDao::list_by_condition::<_, SourceModel>(
            Condition::all(),
            &Some("topic:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        let tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
            Condition::all(),
            &Some("sort_order:asc,id:asc".to_string()),
            db.as_ref(),
        )
        .await?;

        Ok(SynPanelExportVo {
            exported_ms: U64::from(wheel_rs::time_utils::now_ms()),
            datasources: datasources.into_iter().map(export_datasource).collect(),
            sources: sources.into_iter().map(export_source).collect(),
            tasks: tasks.iter().map(export_task).collect(),
        })
    }

    /// # 批量导入
    ///
    /// 单个事务：校验、写入任何一步失败都整批回滚，不会留下「导了一半」的面板。
    pub async fn import(dto: SynPanelImportDto, user: U64) -> Result<SynPanelImportVo, SvcError> {
        let db = get_db_conn()?;
        let tx = db.begin().await.map_err(db_err)?;
        let outcome = write_panel(&tx, dto, user).await;
        match outcome {
            Ok((vo, dirty)) => {
                tx.commit().await.map_err(db_err)?;
                // 提交后再发刷新信号：事务没落地就通知各副本重建快照，等于让它们读旧配置
                if dirty.datasources {
                    on_datasource_changed().await;
                }
                if dirty.tasks {
                    store::on_task_changed().await;
                }
                Ok(vo)
            }
            Err(err) => {
                if let Err(e) = tx.rollback().await {
                    warn!("控制面板导入回滚失败: {e}");
                }
                Err(err)
            }
        }
    }
}

/// 提交后需要发刷新信号的脏标记
#[derive(Debug, Default, Clone, Copy)]
struct Dirty {
    datasources: bool,
    tasks: bool,
}

/// # 事务内写入三类组件
///
/// 顺序固定为 数据源 → 数据抽取 → 任务：后者按 `topic` / 数据源名引用前者，
/// 先写引用方会在事务里读到「引用的数据源不存在」。
async fn write_panel(
    tx: &DatabaseTransaction,
    dto: SynPanelImportDto,
    user: U64,
) -> Result<(SynPanelImportVo, Dirty), SvcError> {
    let SynPanelImportDto {
        mode,
        datasources,
        sources,
        tasks,
    } = dto;
    let mut dirty = Dirty::default();

    /* ------------------------------ 数据源 ------------------------------ */

    let existing_datasources = SynDatasourceDao::list_by_condition::<_, DatasourceModel>(
        Condition::all(),
        &Some("code:asc".to_string()),
        tx,
    )
    .await?;
    let mut ds_by_code: HashMap<String, DatasourceModel> = existing_datasources
        .into_iter()
        .map(|m| (m.code.clone(), m))
        .collect();
    let mut ds_codes = unique_codes(datasources.iter().map(|d| d.code.as_str()), "数据源")?;
    ds_codes.extend(ds_by_code.keys().cloned());

    let mut ds_counts = SynPanelImportCounts::default();
    for mut d in datasources {
        let code = d.code.trim().to_string();
        // 仅补缺模式下已存在的行原样不动：连校验都不做，坏数据不该拦住整批导入
        if mode == SynPanelImportMode::Skip && ds_by_code.contains_key(&code) {
            ds_counts.skipped += 1;
            continue;
        }
        d.url = normalized_url(&d.url);
        d.validate()?;
        match (ds_by_code.get(&code).cloned(), mode) {
            (Some(_), SynPanelImportMode::Skip) => {
                ds_counts.skipped += 1;
            }
            (Some(existing), SynPanelImportMode::Overwrite) => {
                // 连接串留空表示「沿用库里那条」；文件导出时一定带明文，手工编辑才会空
                let url = d.url.clone();
                let am = build_datasource_model(&d, url, Some(existing), user);
                let model = SynDatasourceDao::update(am, tx).await?;
                ds_by_code.insert(code, model);
                ds_counts.updated += 1;
                dirty.datasources = true;
            }
            (None, _) => {
                let url = d.url.clone().ok_or_else(|| {
                    invalid(
                        "url",
                        format!("数据源 {code} 是新增，导入文件里没有连接串（新增必填）"),
                    )
                })?;
                let am = build_datasource_model(&d, Some(url), None, user);
                let model = SynDatasourceDao::insert(am, tx).await?;
                ds_by_code.insert(code, model);
                ds_counts.created += 1;
                dirty.datasources = true;
            }
        }
    }

    /* ----------------------------- 数据抽取 ----------------------------- */

    let existing_sources = SynSourceDao::list_by_condition::<_, SourceModel>(
        Condition::all(),
        &Some("topic:asc".to_string()),
        tx,
    )
    .await?;
    // 去掉 code 后，topic 是数据抽取的唯一业务键：既是关联键，也是导入识别身份
    let mut src_by_topic: HashMap<String, SourceModel> = existing_sources
        .into_iter()
        .map(|m| (m.topic.clone(), m))
        .collect();
    unique_codes(sources.iter().map(|s| s.topic.as_str()), "数据抽取")?;

    let mut src_counts = SynPanelImportCounts::default();
    let mut watermarks_reset = 0u32;
    for s in sources {
        s.validate()?;
        let parsed = parse_source_spec(&s)
            .map_err(|e| invalid("sources", format!("数据抽取 {} 的 spec 不合法：{e}", s.topic.trim())))?;
        let topic = topic_of(&s);
        // 仅补缺模式：已存在的抽取连 spec 都不解析，避免一条坏配置拖垮整批
        if mode == SynPanelImportMode::Skip && src_by_topic.contains_key(&topic) {
            src_counts.skipped += 1;
            continue;
        }
        let existing = src_by_topic.get(&topic).cloned();

        // 引用检查放在写入前：抽引用一个文件里没带、库里也没有的数据源，
        // 保存能过但下一轮取数必失败，属于导入阶段就该拦下的错
        let ds_code = s
            .spec
            .get("datasource")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if let Some(name) = ds_code
            && !ds_codes.contains(name)
        {
            return Err(invalid(
                "datasources",
                format!("数据抽取 {topic} 引用的数据源 {name} 既不在导入文件里、也不在当前环境"),
            ));
        }

        match (existing, mode) {
            (Some(_), SynPanelImportMode::Skip) => {
                src_counts.skipped += 1;
            }
            (Some(existing), SynPanelImportMode::Overwrite) => {
                ensure_topic_available(&topic, Some(existing.id), tx).await?;
                let old_spec = SourceSpec::parse(&existing.spec).unwrap_or_default();
                let old_kind = SourceKind::from_i16(existing.kind).unwrap_or_default();
                let new_spec = SourceSpec::parse(&s.spec).unwrap_or_default();
                let reset = cursor_basis_changed(old_kind, &old_spec, s.kind, &new_spec);

                let am = build_source_model(&s, parsed, topic.clone(), Some(existing), user);
                let model = SynSourceDao::update(am, tx).await?;
                if reset {
                    // 定义一变，旧水位可能把历史数据整段跳过：删游标行，下一轮 load_cursor
                    // 会重新建一行空水位，从起点重拉
                    let cursor = SynCursorDao::get_by_condition::<_, CursorModel>(
                        Condition::all().add(CursorColumn::SourceId.eq(model.id)),
                        tx,
                    )
                    .await?;
                    if let Some(cursor) = cursor {
                        SynCursorDao::delete(cursor.into_active_model(), tx).await?;
                        watermarks_reset += 1;
                    }
                }
                src_by_topic.insert(topic.clone(), model);
                src_counts.updated += 1;
            }
            (None, _) => {
                ensure_topic_available(&topic, None, tx).await?;
                let am = build_source_model(&s, parsed, topic.clone(), None, user);
                let model = SynSourceDao::insert(am, tx).await?;
                src_by_topic.insert(topic.clone(), model);
                src_counts.created += 1;
            }
        }
    }

    /* ------------------------------- 任务 ------------------------------- */

    // 先解析全部 spec：引用检查（db 直写的数据源）需要强类型目标，不靠字符串猜
    let mut parsed_tasks: Vec<(TaskSpec, SynTaskSaveDto)> = Vec::with_capacity(tasks.len());
    for t in tasks {
        let spec = parse_task_spec(&t.spec).map_err(|e| {
            invalid(
                "tasks",
                format!("任务 {} 的 spec 不合法：{e}", t.name.trim()),
            )
        })?;
        parsed_tasks.push((spec, t));
    }

    let existing_tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
        Condition::all(),
        &Some("sort_order:asc,id:asc".to_string()),
        tx,
    )
    .await?;
    let mut task_index: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, t) in existing_tasks.iter().enumerate() {
        task_index
            .entry(task_key(&t.topic, &t.name))
            .or_default()
            .push(i);
    }
    let mut used = vec![false; existing_tasks.len()];

    let mut task_counts = SynPanelImportCounts::default();
    for (spec, dto) in parsed_tasks {
        let name = dto.name.trim().to_string();
        let key = task_key(&spec.topic, &name);
        // 同主题同名有多条时，优先取排序值最接近的那条：导出的文件里排序值就是
        // 唯一能区分它们的稳定信息
        let hit = task_index.get(&key).and_then(|ids| {
            ids.iter()
                .copied()
                .filter(|i| !used[*i])
                .min_by_key(|i| (existing_tasks[*i].sort_order - spec.sort_order).abs())
        });

        // 引用检查只针对真正要写的任务：仅补缺模式下跳过的行原样不动，
        // 不该因为一条历史配置引用了已删数据源而拦住整批
        if !(hit.is_some() && mode == SynPanelImportMode::Skip)
            && spec.target.is_db()
            && let Some(ds) = spec
                .target
                .datasource
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            && !ds_codes.contains(ds)
        {
            return Err(invalid(
                "datasources",
                format!("任务 {name} 直写的数据源 {ds} 既不在导入文件里、也不在当前环境"),
            ));
        }

        match (hit, mode) {
            (Some(i), SynPanelImportMode::Skip) => {
                used[i] = true;
                task_counts.skipped += 1;
            }
            (Some(i), SynPanelImportMode::Overwrite) => {
                used[i] = true;
                let existing = existing_tasks[i].clone();
                let version = existing.version + 1;
                let am = build_task_model(&spec, &dto, Some(existing), user);
                let model = SynTaskDao::update(am, tx).await?;
                insert_version(&model, version, &dto.remark, user, tx).await?;
                task_counts.updated += 1;
                dirty.tasks = true;
            }
            (None, _) => {
                let am = build_task_model(&spec, &dto, None, user);
                let model = SynTaskDao::insert(am, tx).await?;
                insert_version(&model, 1, &dto.remark, user, tx).await?;
                task_counts.created += 1;
                dirty.tasks = true;
            }
        }
    }

    Ok((
        SynPanelImportVo {
            mode,
            datasources: ds_counts,
            sources: src_counts,
            tasks: task_counts,
            watermarks_reset,
        },
        dirty,
    ))
}

/* ------------------------------- 导出映射 ------------------------------- */

fn export_datasource(m: DatasourceModel) -> SynPanelDatasourceVo {
    SynPanelDatasourceVo {
        code: m.code,
        name: m.name,
        engine: DbEngine::from(m.engine),
        target: mask_url(&m.url),
        url: m.url,
        max_connections: m.max_connections as u32,
        enabled: m.enabled,
        remark: m.remark,
    }
}

fn export_source(m: SourceModel) -> SynPanelSourceVo {
    SynPanelSourceVo {
        name: m.name,
        kind: SourceKind::from_i16(m.kind).unwrap_or_default(),
        topic: m.topic,
        enabled: m.enabled,
        interval_duration: m.interval_duration,
        batch_size: m.batch_size,
        spec: m.spec,
        remark: m.remark,
    }
}

fn export_task(m: &TaskModel) -> SynPanelTaskVo {
    SynPanelTaskVo {
        name: m.name.clone(),
        topic: m.topic.clone(),
        sort_order: m.sort_order,
        enabled: m.enabled,
        exclusive: m.exclusive,
        remark: m.remark.clone(),
        spec: task_spec_with_columns(m),
    }
}

/// 把 `spec` 里的四个索引列覆盖成表里的值。
///
/// 任务的写入口只认 `spec`，列是它的投影；历史配置里 `spec.topic` 与列不一致时，
/// 导入若原样回放旧 spec，会把列写回旧值。以列为准导出，文件才「所见即所存」。
fn task_spec_with_columns(m: &TaskModel) -> Value {
    let mut map = match m.spec.clone() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    map.insert("topic".to_string(), Value::String(m.topic.clone()));
    map.insert("sort_order".to_string(), json!(m.sort_order));
    map.insert("enabled".to_string(), json!(m.enabled));
    map.insert("exclusive".to_string(), json!(m.exclusive));
    Value::Object(map)
}

/* -------------------------------- 导入辅助 -------------------------------- */

/// 同一主题内的任务身份：主题 + 名称。名称按去掉首尾空白后的值比较，
/// 与保存时 `dto.name.trim()` 落库的口径一致。
fn task_key(topic: &str, name: &str) -> String {
    format!("{}\u{0}{}", topic.trim(), name.trim())
}

/// 文件内编码去重检查。返回文件里出现过的编码集合（供引用检查）。
fn unique_codes<'a>(
    codes: impl Iterator<Item = &'a str>,
    label: &str,
) -> Result<HashSet<String>, SvcError> {
    let mut seen = HashSet::new();
    for code in codes {
        let code = code.trim();
        if code.is_empty() {
            return Err(invalid("code", format!("{label}编码不能为空")));
        }
        if !seen.insert(code.to_string()) {
            return Err(invalid(
                "code",
                format!("{label}编码 {code} 在导入文件里重复"),
            ));
        }
    }
    Ok(seen)
}
