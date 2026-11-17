/* 规则注释更正：五段 → 任务规则（target / 五段 / 判定）。
 *
 * 只改注释，不动结构。为什么单独出一条而不是改 20261112000000：那条已经
 * 在联调库与测试机上跑过，改文件会让 sqlx 的校验和对不上、必须重建库才能启动；
 * 注释这种纯元数据修正不值得让人重建库。 */

comment on table syn_task is
'同步任务：规则与投递的载体。';

comment on column syn_task.spec is
'任务规则（target / match / mapping / guards / actions / rules）
嵌套结构，整体被执行器消费，没有任何一列参与检索，所以按 JSONB 存
target.kind=http 时 actions 是四态调用矩阵；kind=db 时 actions 必须为空：op 由记录自带，写库形状由 target.on_conflict 决定
判定段的输入跟着出口走：http 是下游响应，db 是合成响应 { "affected": n }，所以 db 只能看 $.affected
topic / sort_order / enabled / exclusive 以本表的列为准，spec 里的同名字段只是导入来源';

comment on column syn_task_version.spec is
'该版本的完整任务规则（target / 五段 / 判定）';
