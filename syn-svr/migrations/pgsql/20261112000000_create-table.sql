/*==============================================================*/
/* DBMS name:      PostgreSQL 9.x                               */
/* Created on:     2026/11/12 18:56:52                          */
/*==============================================================*/


/*==============================================================*/
/* Table: syn_task                                              */
/*==============================================================*/
create table syn_task (
   id                   INT8                 not null,
   code                 VARCHAR(64)          not null,
   name                 VARCHAR(100)         not null,
   topic                VARCHAR(255)         not null,
   priority             INT4                 not null default 100,
   enabled              BOOL                 not null default true,
   exclusive            BOOL                 not null default true,
   spec                 JSONB                not null,
   version              INT4                 not null default 1,
   remark               VARCHAR(500)         null,
   creater_id           INT8                 not null,
   create_ms            INT8                 not null,
   updater_id           INT8                 not null,
   update_ms            INT8                 not null,
   constraint PK_SYN_TASK primary key (id),
   constraint AK_CODE_SYN_TASK unique (code)
);

comment on table syn_task is
'同步任务：五段规则的载体。';

comment on column syn_task.id is
'ID
由 idworker 生成，全局唯一';

comment on column syn_task.code is
'任务编码
人写可读的稳定标识，配置、日志、排障都用它指代一条任务；接口按它查询
@len 1..=64';

comment on column syn_task.name is
'名称
给人看的名字，列表页展示
@len 1..=100';

comment on column syn_task.topic is
'来源 topic
push 入口是 Kafka 的 topic；poll 入口是虚拟 topic（source:{数据源编码}）
@len 1..=255';

comment on column syn_task.priority is
'匹配优先级
升序匹配，同 topic 下按优先级逐个试；数字小的先试
@range 0..=9999';

comment on column syn_task.enabled is
'是否启用
停用只影响匹配，规则原样保留';

comment on column syn_task.exclusive is
'命中后是否停止匹配后续任务
false 表示这条记录还要继续喂给后面的任务（一分多）';

comment on column syn_task.spec is
'五段规则（match / mapping / actions / guards / outcomes）
嵌套结构，整体被执行器消费，没有任何一列参与检索，所以按 JSONB 存
topic / priority / enabled / exclusive 以本表的列为准，spec 里的同名字段只是导入来源';

comment on column syn_task.version is
'配置版本号
每次发布 +1，执行器按版本判断是否需要重新拉快照
@range 1..=2147483647';

comment on column syn_task.remark is
'备注
@len 0..=500';

comment on column syn_task.creater_id is
'创建者ID
由框架在新增时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_task.create_ms is
'创建时间戳
由框架在新增时写入当前时间
@unit ms';

comment on column syn_task.updater_id is
'更新者ID
由框架在修改时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_task.update_ms is
'更新时间戳
由框架在修改时写入当前时间
@unit ms';

/*==============================================================*/
/* Index: syn_task_PK                                           */
/*==============================================================*/
create unique index syn_task_PK on syn_task (
id
);


/*==============================================================*/
/* Table: syn_task_version                                      */
/*==============================================================*/
create table syn_task_version (
   id                   INT8                 not null,
   task_id              INT8                 not null,
   version              INT4                 not null,
   spec                 JSONB                not null,
   remark               VARCHAR(500)         null,
   creater_id           INT8                 not null,
   create_ms            INT8                 not null,
   updater_id           INT8                 not null,
   update_ms            INT8                 not null,
   constraint PK_SYN_TASK_VERSION primary key (id),
   constraint AK_TASK_ID_AND_VERSION_SYN_TASK_VERSION unique (task_id, version)
);

comment on table syn_task_version is
'任务配置的不可变版本快照：发布即固化一份，回滚只是把指针指回去。';

comment on column syn_task_version.id is
'ID
由 idworker 生成，全局唯一';

comment on column syn_task_version.task_id is
'所属任务 ID';

comment on column syn_task_version.version is
'版本号
与 syn_task.version 对应
@range 1..=2147483647';

comment on column syn_task_version.spec is
'该版本的完整五段规则';

comment on column syn_task_version.remark is
'发布说明（这一版改了什么）
排障时最有用的一列
@len 0..=500';

comment on column syn_task_version.creater_id is
'创建者ID
由框架在新增时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_task_version.create_ms is
'创建时间戳
由框架在新增时写入当前时间
@unit ms';

comment on column syn_task_version.updater_id is
'更新者ID
由框架在修改时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_task_version.update_ms is
'更新时间戳
由框架在修改时写入当前时间
@unit ms';

/*==============================================================*/
/* Index: syn_task_version_PK                                   */
/*==============================================================*/
create unique index syn_task_version_PK on syn_task_version (
id
);


/*==============================================================*/
/* Table: syn_idem                                              */
/*==============================================================*/
create table syn_idem (
   id                   INT8                 not null,
   task_id              INT8                 not null,
   idem_key             VARCHAR(255)         not null,
   verdict              INT2                 not null,
   code                 VARCHAR(64)          not null,
   creater_id           INT8                 not null,
   create_ms            INT8                 not null,
   updater_id           INT8                 not null,
   update_ms            INT8                 not null,
   constraint PK_SYN_IDEM primary key (id),
   constraint AK_TASK_ID_AND_IDEM_KEY_SYN_IDEM unique (task_id, idem_key)
);

comment on table syn_idem is
'幂等记账：一条记录命中多个任务时，重投不能让已经成功的任务再写一次。';

comment on column syn_idem.id is
'ID
由 idworker 生成，全局唯一';

comment on column syn_idem.task_id is
'任务 ID
幂等按「任务维度」记账，不按记录维度：同一条记录的两个任务各自成功才算整体成功';

comment on column syn_idem.idem_key is
'幂等键
由调用方（sink）经 X-Idempotency-Key 传入，形如 topic:partition:offset
@len 1..=255';

comment on column syn_idem.verdict is
'该键上次的结论
重投时直接返回这个结论，不再执行
@enum SyncVerdict default=Success
  0=Success    成功
  1=Skip       跳过（条件不满足，不是错误）
  2=Fatal      业务失败（不可重试）
  3=Retriable  暂时失败（可重试）';

comment on column syn_idem.code is
'该键上次的分类码
如 OK / NOT_FOUND / TIMEOUT，用于区分「同一结论的不同原因」
@len 1..=64';

comment on column syn_idem.creater_id is
'创建者ID
由框架在新增时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_idem.create_ms is
'创建时间戳
由框架在新增时写入当前时间
@unit ms';

comment on column syn_idem.updater_id is
'更新者ID
由框架在修改时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_idem.update_ms is
'更新时间戳
由框架在修改时写入当前时间
@unit ms';

/*==============================================================*/
/* Index: syn_idem_PK                                           */
/*==============================================================*/
create unique index syn_idem_PK on syn_idem (
id
);

/*==============================================================*/
/* Index: idx_syn_idem_create_ms                                */
/*==============================================================*/
create index idx_syn_idem_create_ms on syn_idem (
create_ms
);


/*==============================================================*/
/* Table: syn_source                                            */
/*==============================================================*/
create table syn_source (
   id                   INT8                 not null,
   code                 VARCHAR(64)          not null,
   name                 VARCHAR(100)         not null,
   kind                 INT2                 not null,
   topic                VARCHAR(255)         not null,
   enabled              BOOL                 not null default true,
   interval_duration    VARCHAR(30)          not null default '60s',
   batch_size           INT4                 not null default 500,
   spec                 JSONB                not null,
   version              INT4                 not null default 1,
   remark               VARCHAR(500)         null,
   creater_id           INT8                 not null,
   create_ms            INT8                 not null,
   updater_id           INT8                 not null,
   update_ms            INT8                 not null,
   constraint PK_SYN_SOURCE primary key (id),
   constraint AK_CODE_SYN_SOURCE unique (code),
   constraint AK_TOPIC_SYN_SOURCE unique (topic)
);

comment on table syn_source is
'自拉数据源（poll）：一个数据源的一批数据可以同步到多个任务，任务侧不需要知道数据是推来的还是拉来的。';

comment on column syn_source.id is
'ID
由 idworker 生成，全局唯一';

comment on column syn_source.code is
'数据源编码
如 adm_person_full；虚拟 topic 由它拼出
@len 1..=64';

comment on column syn_source.name is
'名称
@len 1..=100';

comment on column syn_source.kind is
'取数方式
@enum SourceKind default=Sql
  0=Sql   按游标查库（推荐）
  1=Http  分页拉接口';

comment on column syn_source.topic is
'虚拟 topic
形如 source:adm_person_full；任务通过 topic 关联，五段规则不区分数据的来路
@len 1..=255';

comment on column syn_source.enabled is
'是否参与调度
停用不影响已配的游标，重新启用从原水位继续';

comment on column syn_source.interval_duration is
'期望的调度间隔
Duration 字符串，如 5s / 1m / 1h；实际触发由调度方保证（jobx 计划任务）
@len 1..=30';

comment on column syn_source.batch_size is
'单批行数
合并投递（dispatch.mode=batch）时这是一次请求的条数上限
@range 1..=5000';

comment on column syn_source.spec is
'取数定义
sql 的查询、游标列与重叠窗口；http 的地址与分页规则';

comment on column syn_source.version is
'配置版本号
@range 1..=2147483647';

comment on column syn_source.remark is
'备注
@len 0..=500';

comment on column syn_source.creater_id is
'创建者ID
由框架在新增时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_source.create_ms is
'创建时间戳
由框架在新增时写入当前时间
@unit ms';

comment on column syn_source.updater_id is
'更新者ID
由框架在修改时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_source.update_ms is
'更新时间戳
由框架在修改时写入当前时间
@unit ms';

/*==============================================================*/
/* Index: syn_source_PK                                         */
/*==============================================================*/
create unique index syn_source_PK on syn_source (
id
);


/*==============================================================*/
/* Table: syn_cursor                                            */
/*==============================================================*/
create table syn_cursor (
   id                   INT8                 not null,
   source_id            INT8                 not null,
   cursor_value         VARCHAR(500)         null,
   rows_synced          INT8                 not null default 0,
   last_run_ms          INT8                 null,
   last_error           VARCHAR(1000)        null,
   creater_id           INT8                 not null,
   create_ms            INT8                 not null,
   updater_id           INT8                 not null,
   update_ms            INT8                 not null,
   constraint PK_SYN_CURSOR primary key (id),
   constraint AK_SOURCE_ID_SYN_CURSOR unique (source_id)
);

comment on table syn_cursor is
'自拉数据源的水位（poll 模式）：单独一张表是因为它每轮都在写，而数据源是低频配置，混在一起会让读配置和推水位争同一行。';

comment on column syn_cursor.id is
'ID
由 idworker 生成，全局唯一';

comment on column syn_cursor.source_id is
'数据源 ID
一个数据源一条游标，不建历史多行';

comment on column syn_cursor.cursor_value is
'水位值（时间戳 / 自增 ID / 页码 token）
下一轮从这里继续；为空表示还没跑过，首轮从头取
@len 0..=500';

comment on column syn_cursor.rows_synced is
'累计同步行数
用于判断「这条链路还活着吗」
@range 0..=9223372036854775807';

comment on column syn_cursor.last_run_ms is
'上一轮开始时间戳
超过 3 个周期没动就是卡住了
@unit ms';

comment on column syn_cursor.last_error is
'上一轮的错误摘要
成功一轮就清空；失败时保留最后一次的原因，不必翻日志
@len 0..=1000';

comment on column syn_cursor.creater_id is
'创建者ID
由框架在新增时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_cursor.create_ms is
'创建时间戳
由框架在新增时写入当前时间
@unit ms';

comment on column syn_cursor.updater_id is
'更新者ID
由框架在修改时写入当前操作者；无登录态的系统写入写 0';

comment on column syn_cursor.update_ms is
'更新时间戳
由框架在修改时写入当前时间
@unit ms';

/*==============================================================*/
/* Index: syn_cursor_PK                                         */
/*==============================================================*/
create unique index syn_cursor_PK on syn_cursor (
id
);


alter table syn_task_version
   add constraint fk_task_id__from__syn_task foreign key (task_id)
      references syn_task (id)
      on delete cascade on update restrict;

alter table syn_idem
   add constraint fk_task_id__from__syn_task foreign key (task_id)
      references syn_task (id)
      on delete cascade on update restrict;

alter table syn_cursor
   add constraint fk_source_id__from__syn_source foreign key (source_id)
      references syn_source (id)
      on delete cascade on update restrict;

