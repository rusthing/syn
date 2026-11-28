-- 线上同步任务补齐 tags 映射：adm.ADM_USER -> dtw_person / adm_person，adm.ADM_CAR -> dtw_vehicle
-- 用 target.base 命中任务，不写死任务 ID；已有 tags 映射的任务跳过，重复执行安全。
-- 源端没有 TAGS 列时路径不存在 -> null -> omit，不会把目标库已有标签清空；
-- 有 TAGS 列时按 `|标签A|标签B|` 原样透传，trim/strip_nul 只做无害清洗。
-- 生效：部署后调 POST /syn/task/reload（或等 NATS 刷新信号）。

begin;

with target_task as (
    select t.id
      from syn_task t
     where t.spec #>> '{target,base}' in ('/dtw/person', '/dtw/vehicle', '/adm/person')
       and not exists (
               select 1
                 from jsonb_array_elements(t.spec -> 'mapping' -> 'rows') as r(row)
                where r.row ->> 'to' = 'tags'
           )
), updated as (
    update syn_task t
       set spec = jsonb_set(
                      t.spec,
                      '{mapping,rows}',
                      coalesce(t.spec #> '{mapping,rows}', '[]'::jsonb)
                        || jsonb_build_array(
                               jsonb_build_object(
                                   'to', 'tags',
                                   'from', '$.after.TAGS',
                                   'fn', jsonb_build_array('trim', 'strip_nul'),
                                   'on_null', 'omit',
                                   'on_empty', 'omit'
                               )
                           ),
                      false
                  ),
           version = t.version + 1,
           updater_id = 2,
           update_ms = (extract(epoch from now()) * 1000)::bigint
      from target_task x
     where t.id = x.id
  returning t.id, t.version, t.spec, t.remark
)
insert into syn_task_version
    (id, task_id, version, spec, remark, creater_id, create_ms, updater_id, update_ms)
select coalesce((select max(id) from syn_task_version), 0) + row_number() over (order by u.id),
       u.id,
       u.version,
       u.spec,
       u.remark,
       2,
       (extract(epoch from now()) * 1000)::bigint,
       2,
       (extract(epoch from now()) * 1000)::bigint
  from updated u;

commit;
