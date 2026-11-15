-- 任务表两处调整：
-- 1) 删除 code：任务身份改用主键 id，人读的名字统一用 name。code 原本只当
--    人写可读的别名，却要同时维护唯一约束、画布坐标、投递/台账回显，收益不抵成本。
-- 2) priority 改名 sort_order：与 adm-rs 的排序列统一；语义仍是「同一主题内升序」，
--    匹配与列表都按 (sort_order, id) 排。

alter table syn_task drop constraint if exists AK_CODE_SYN_TASK;

-- 画布坐标的节点键也要从 code 换成主键 id，且**必须在 drop column 之前**做。
-- 漏了这一步不会报错：坐标还在库里，只是没有任何节点认领它，画布上那个任务的摆放
-- 静默退回默认布局 —— 用户拖过一次的东西被谁擦掉了都查不出来。
-- 先删掉可能已存在的 id 行（旧前端只写 code 行，这条正常是 0 行），避免改键时撞唯一约束。
delete from syn_canvas_layout c
 using syn_task t
 where c.node_type = 4
   and c.node_key = t.id::text
   and exists (select 1 from syn_canvas_layout d
                where d.node_type = 4 and d.node_key = t.code);

update syn_canvas_layout c
   set node_key = t.id::text
  from syn_task t
 where c.node_type = 4
   and c.node_key = t.code;

alter table syn_task drop column if exists code;
alter table syn_task rename column priority to sort_order;

-- spec 里残留的 id / priority 是导入来源，清掉避免与列再次漂移
update syn_task
set spec = (spec - 'id' - 'priority') || jsonb_build_object('sort_order', sort_order)
where spec ? 'id' or spec ? 'priority';

comment on column syn_task.name is
'名称
给人看的名字，列表页、投递记录与日志都按它指代任务
@len 1..=100';

comment on column syn_task.sort_order is
'排序值
同一主题内升序，越小越靠前；匹配与列表都按 (sort_order, id) 升序
@range 0..=9999';

comment on column syn_task.spec is
'五段规则（match / mapping / actions / guards / outcomes）
嵌套结构，整体被执行器消费，没有任何一列参与检索，所以按 JSONB 存
topic / sort_order / enabled / exclusive 以本表的列为准，spec 里的同名字段只是导入来源';
