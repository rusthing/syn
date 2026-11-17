//! # 投递记录服务
//!
//! 列表是两张表的并集，按 `create_ms` 倒序：
//!
//! - `syn_idem`：幂等台账，只记 success / skip，**只在该次请求带幂等键时才有行**；
//! - `syn_delivery_log`：投递明细，只记 fatal / retriable，带失败段、耗时、真实
//!   HTTP 状态码与 detail；自拉链路（没有幂等键）的失败也在里面。
//!
//! 两张表互补、不重叠，所以直接 `union all` 后统一筛选、统一下沉分页，避免在内存里
//! 合并两页数据（那样总条数与翻页边界都会算错）。所有筛选值都绑参数，表名是常量。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, DbBackend, DbErr, Statement, Value};
use syn_api::{SynDeliveryQueryDto, SynDeliveryVo, SyncVerdict, Verdict};

use crate::dao::SynTaskDao;
use crate::mo::syn_task::{Column as TaskColumn, Model as TaskModel};

use super::db_err;

/// 两张表的统一投影。列名与类型必须两边对齐（`union all` 按位置合并）：
/// 台账行补 `stage='verdict'`、`latency_ms=0`、`detail=null`，明细行直接用自己的值。
const UNION_SQL: &str = "\
 select 'idem' as source, i.id as id, i.task_id as task_id, t.name as task_name, \
        t.topic as topic, null::text as op, i.verdict as verdict, i.code as code, 'verdict' as stage, \
        i.idem_key as record_key, 0 as latency_ms, null::int2 as http_status, \
        null::text as request_body, null::text as response_body, \
        i.create_ms as create_ms, null::text as detail \
   from syn_idem i left join syn_task t on t.id = i.task_id \
 union all \
 select 'log', l.id, l.task_id, l.task_name, l.topic, l.op, l.verdict, l.code, l.stage, \
        l.record_key, l.latency_ms, l.http_status, l.request_body, l.response_body, \
        l.create_ms, l.detail \
   from syn_delivery_log l";

/// # 投递记录服务
pub struct SynDeliverySvc;

impl SynDeliverySvc {
    /// # 分页（台账 + 失败明细）
    ///
    /// 返回 `(实际页码, 总数, 列表)`。这里不走 DAO，页码自己夹：请求超过总页数时
    /// 与 DAO 一致地落到最后一页，offset 也用夹过的值，避免「响应说第 2 页、列表却是空」。
    pub async fn page(
        dto: SynDeliveryQueryDto,
    ) -> Result<(U64, U64, Vec<SynDeliveryVo>), SvcError> {
        let db = get_db_conn()?;

        // 任务名是名称筛选，两张表都只存 task_id：先换 ID，再统一按 task_id 过滤
        let task_ids = match dto
            .task_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(name) => {
                let tasks = SynTaskDao::list_by_condition::<_, TaskModel>(
                    Condition::all().add(TaskColumn::Name.eq(name)),
                    &None,
                    db.as_ref(),
                )
                .await?;
                Some(tasks.into_iter().map(|m| m.id).collect::<Vec<_>>())
            }
            None => None,
        };

        let (where_sql, values) = build_filters(&dto, task_ids.as_deref());

        let count_stmt = Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("select count(*) as n from ({UNION_SQL}) u where {where_sql}"),
            values.clone(),
        );
        let total = db
            .query_one_raw(count_stmt)
            .await
            .map_err(db_err)?
            .map(|r| r.try_get::<i64>("", "n"))
            .transpose()
            .map_err(db_err)?
            .unwrap_or(0);

        // 分页放在 union 结果上，不能两边各取一页再合并：那样批量大小与页码都会错
        let page_size = dto.page_size();
        let total_pages = ((total + page_size as i64 - 1) / page_size as i64).max(1);
        let page_num = (dto.page_num() as i64).clamp(1, total_pages);
        let mut page_values = values;
        page_values.push((page_size as i64).into());
        let limit_at = page_values.len();
        page_values.push(((page_num - 1) * page_size as i64).into());
        let offset_at = page_values.len();
        let list_sql = format!(
            "select * from ({UNION_SQL}) u where {where_sql} \
             order by u.create_ms desc, u.id desc, u.source \
             limit ${limit_at} offset ${offset_at}"
        );
        let rows = db
            .query_all_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                list_sql,
                page_values,
            ))
            .await
            .map_err(db_err)?;

        let list = rows
            .iter()
            .map(to_vo)
            .collect::<Result<Vec<_>, DbErr>>()
            .map_err(db_err)?;
        Ok((
            U64::from(page_num.max(1) as u64),
            U64::from(total.max(0) as u64),
            list,
        ))
    }
}

/// 把一行 union 结果翻译成 VO；解码失败按 500 暴露，不静默补 0
fn to_vo(row: &sea_orm::QueryResult) -> Result<SynDeliveryVo, DbErr> {
    let verdict = Verdict::from(
        SyncVerdict::from_i16(row.try_get::<i16>("", "verdict")?).unwrap_or_default(),
    );
    // 明细行的状态码是真值；台账行没有，按结论换算（与旧口径一致）
    let http_status = match row.try_get::<Option<i16>>("", "http_status")? {
        Some(code) => u16::try_from(code).ok(),
        None => (row.try_get::<String>("", "source")? == "idem").then(|| verdict.http_status()),
    };
    Ok(SynDeliveryVo {
        id: U64::from(row.try_get::<i64>("", "id")?),
        source: row.try_get("", "source")?,
        task_name: row.try_get::<Option<String>>("", "task_name")?.unwrap_or_default(),
        topic: row.try_get("", "topic")?,
        op: row.try_get("", "op")?,
        verdict,
        code: row.try_get("", "code")?,
        stage: row.try_get("", "stage")?,
        record_key: row.try_get("", "record_key")?,
        latency_ms: row.try_get::<i32>("", "latency_ms")?.max(0) as u64,
        http_status,
        request_body: row.try_get("", "request_body")?,
        response_body: row.try_get("", "response_body")?,
        create_ms: U64::from(row.try_get::<i64>("", "create_ms")?),
        detail: row.try_get("", "detail")?,
    })
}

/// 组装 `where` 片段与绑定值；占位符按 `values` 的实际顺序编号
fn build_filters(
    dto: &SynDeliveryQueryDto,
    task_ids: Option<&[i64]>,
) -> (String, Vec<Value>) {
    let mut parts: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(kw) = dto
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        values.push(format!("%{kw}%").into());
        // 明细行的 record_key 可能为空（自拉链路），用 coalesce 兜住否则 like 结果是 NULL
        parts.push("(u.code like $1 or coalesce(u.record_key, '') like $1)".to_string());
    }
    if let Some(v) = dto.verdict_code() {
        values.push(v.into());
        parts.push(format!("u.verdict = ${}", values.len()));
    }
    if let Some(ids) = task_ids {
        if ids.is_empty() {
            // 筛了任务名但这任务没有记录：给个恒假条件，而不是忽略筛选
            parts.push("false".to_string());
        } else {
            let mut marks = Vec::with_capacity(ids.len());
            for id in ids {
                values.push((*id).into());
                marks.push(format!("${}", values.len()));
            }
            parts.push(format!("u.task_id in ({})", marks.join(", ")));
        }
    }

    let sql = if parts.is_empty() {
        "true".to_string()
    } else {
        parts.join(" and ")
    };
    (sql, values)
}

#[cfg(test)]
mod tests {
    use super::build_filters;
    use syn_api::SynDeliveryQueryDto;

    #[test]
    fn empty_filters_are_true() {
        let (sql, values) = build_filters(&SynDeliveryQueryDto::default(), None);
        assert_eq!(sql, "true");
        assert!(values.is_empty());
    }

    #[test]
    fn placeholders_follow_binding_order() {
        let dto = SynDeliveryQueryDto {
            keyword: Some("abc".to_string()),
            verdict: Some("fatal".to_string()),
            ..Default::default()
        };
        let (sql, values) = build_filters(&dto, Some(&[7, 9]));
        assert!(sql.contains("$1"));
        assert!(sql.contains("u.verdict = $2"));
        assert!(sql.contains("u.task_id in ($3, $4)"));
        assert_eq!(values.len(), 4);
    }

    #[test]
    fn unknown_task_yields_no_rows_instead_of_ignoring_filter() {
        let (sql, values) = build_filters(&SynDeliveryQueryDto::default(), Some(&[]));
        assert_eq!(sql, "false");
        assert!(values.is_empty());
    }
}
