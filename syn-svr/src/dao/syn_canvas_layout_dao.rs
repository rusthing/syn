use robotech::macros::dao;

/// # 画布布局（节点坐标）
///
/// 唯一键 `(node_type, node_key)`（`AK_NODE_TYPE_AND_NODE_KEY_SYN_CANVAS_LAYOUT`）：
/// 同一个 code 在「数据源」和「任务」下是两个不同的节点，只按 key 会互相覆盖。
///
/// 不做模糊查询：这张表只按主键/唯一键取，量与节点数同阶（几十行）。
#[dao(
    unique_keys: [
        ("node_type,node_key", "节点类型与节点标识"),
    ],
)]
pub struct SynCanvasLayoutDao;
