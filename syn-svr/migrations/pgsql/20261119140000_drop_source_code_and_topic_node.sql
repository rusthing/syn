/* 去掉数据抽取的 code 列 + 控制面板的「主题」节点类型。
 *
 * 三处同源改动：LDM/PDM 模型 → 首建表 DDL（20261112000000）→ 本迁移。
 * 首建表已不含 code 列与 AK_CODE_SYN_SOURCE 约束，存量库要显式删掉它们；
 * 否则代码里删了 DTO/实体字段后，SELECT 依然带 code，INSERT 又不给值，
 * 会撞 not null。
 *
 * - syn_source.code：被 topic 取代。topic 是数据抽取与任务的唯一关联键，
 *   月台里也改成显示 topic，code 不再有任何消费者。
 * - AK_CODE_SYN_SOURCE：随列一起删（PG 里 drop column 会连带删掉列上的索引，
 *   但显式 drop constraint 让语义可见，IF EXISTS 保证新库上空操作）。
 * - syn_canvas_layout 里 node_type=3（主题）是虚拟节点的坐标，主题节点去掉后
 *   这些行永远不会被画布读取，清掉避免留下无意义数据。 */

alter table syn_source drop constraint if exists AK_CODE_SYN_SOURCE;
alter table syn_source drop column if exists code;

delete from syn_canvas_layout where node_type = 3;
