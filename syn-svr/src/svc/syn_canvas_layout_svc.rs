//! # 画布布局服务
//!
//! 只有两件事：把全量坐标读出来、把变动过的坐标批量写回去。
//!
//! 写入是**按 `(node_type, node_key)` 的 upsert**，不是全量替换：
//! 前端只提交这次拖动过的节点，没提交的行保持原样（两个人在不同分支上摆位时，
//! 全量替换会互相抹掉对方的坐标）。
//!
//! 不校验「节点是否存在」：布局是纯展示态，节点删了残行由画布忽略即可；
//! 反过来在这里查三张表会把这个接口变成跨资源的强一致点，代价不值得。

use robotech::api::U64;
use robotech::db::get_db_conn;
use robotech::svc::SvcError;
use sea_orm::{ActiveValue, ColumnTrait, Condition, IntoActiveModel};
use syn_api::{SynCanvasLayoutSaveDto, SynCanvasLayoutVo};
use validator::Validate;
use wheel_rs::time_utils::now_ms;

use crate::dao::SynCanvasLayoutDao;
use crate::mo::syn_canvas_layout::{ActiveModel, Column, Model};

/// # 画布布局服务
pub struct SynCanvasLayoutSvc;

impl SynCanvasLayoutSvc {
    /// # 全量坐标
    ///
    /// 不按用户区分：这套拓扑是团队共享的一张图，谁拖动都改同一份。
    pub async fn list() -> Result<Vec<SynCanvasLayoutVo>, SvcError> {
        let db = get_db_conn()?;
        let rows = SynCanvasLayoutDao::list_by_condition::<_, Model>(
            Condition::all(),
            &Some("id:asc".to_string()),
            db.as_ref(),
        )
        .await?;
        Ok(rows.into_iter().map(to_vo).collect())
    }

    /// # 批量保存坐标
    ///
    /// 逐条 upsert；返回真正落库的坐标，前端用它对齐本地状态。
    pub async fn save(
        dto: SynCanvasLayoutSaveDto,
        user: U64,
    ) -> Result<Vec<SynCanvasLayoutVo>, SvcError> {
        dto.validate()?;
        let db = get_db_conn()?;
        let uid = user.value() as i64;
        let mut saved = Vec::with_capacity(dto.nodes.len());

        for node in &dto.nodes {
            let key = node.node_key.trim();
            if key.is_empty() {
                continue;
            }
            let existing = SynCanvasLayoutDao::get_by_condition::<_, Model>(
                Condition::all()
                    .add(Column::NodeType.eq(node.node_type as i16))
                    .add(Column::NodeKey.eq(key)),
                db.as_ref(),
            )
            .await?;

            let model = match existing {
                Some(model) => {
                    let mut am = model.into_active_model();
                    am.x = ActiveValue::Set(node.x);
                    am.y = ActiveValue::Set(node.y);
                    am.updater_id = ActiveValue::Set(uid);
                    am.update_ms = ActiveValue::Set(now_ms() as i64);
                    SynCanvasLayoutDao::update(am, db.as_ref()).await?
                }
                None => {
                    let now = now_ms() as i64;
                    let mut am = ActiveModel::default();
                    am.node_type = ActiveValue::Set(node.node_type as i16);
                    am.node_key = ActiveValue::Set(key.to_string());
                    am.x = ActiveValue::Set(node.x);
                    am.y = ActiveValue::Set(node.y);
                    am.creater_id = ActiveValue::Set(uid);
                    am.create_ms = ActiveValue::Set(now);
                    am.updater_id = ActiveValue::Set(uid);
                    am.update_ms = ActiveValue::Set(now);
                    SynCanvasLayoutDao::insert(am, db.as_ref()).await?
                }
            };
            saved.push(to_vo(model));
        }
        Ok(saved)
    }
}

fn to_vo(m: Model) -> SynCanvasLayoutVo {
    SynCanvasLayoutVo {
        node_type: syn_api::CanvasNodeType::from_i16(m.node_type)
            .unwrap_or(syn_api::CanvasNodeType::Task),
        node_key: m.node_key,
        x: m.x,
        y: m.y,
    }
}
