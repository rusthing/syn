-- 任务表两处调整：
-- 1) 删除 code：任务身份改用主键 id，人读的名字统一用 name。code 原本只当
--    人写可读的别名，却要同时维护唯一约束、画布坐标、投递/台账回显，收益不抵成本。
-- 2) priority 改名 sort_order：与 adm-rs 的排序列统一；语义仍是「同一主题内升序」，
--    匹配与列表都按 (sort_order, id) 排。

alter table syn_task drop constraint if exists AK_CODE_SYN_TASK;
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
