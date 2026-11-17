/* 投递明细补调试快照：变更操作、请求体、下游响应体。
 * 存量库由这份增量迁移加列；新库首建表 DDL 已含这三列，见 20261112000000。 */

alter table syn_delivery_log add column op VARCHAR(8) null;
alter table syn_delivery_log add column request_body TEXT null;
alter table syn_delivery_log add column response_body TEXT null;

comment on column syn_delivery_log.op is
'变更操作
c / r / u / d；记录缺 op 或取值不合法时为空';

comment on column syn_delivery_log.request_body is
'实际发出的请求体快照（映射后的 JSON）
映射段之前短路时为空；超长截断';

comment on column syn_delivery_log.response_body is
'下游响应体快照（JSON）
传输失败 / DB 直写失败时为空；超长截断';
