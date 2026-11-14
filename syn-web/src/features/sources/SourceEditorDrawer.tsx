/**
 * 取数来源的新增 / 编辑窗体。
 *
 * 后端 `syn_source` 的 CRUD 一直在，缺的是这个入口：以前只能靠直接写库或调接口
 * 建来源，界面上只有「看 / 拉 / 启停」。连接串不在这里维护 —— 那是
 * `[syn.datasources.*]`（toml / consul）的事，这里只从只读清单里选名字。
 */

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, DatabaseZap, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog, Modal } from "@/components/ui/Drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import type { SourceSaveInput, SourceSpec, SyncSource } from "@/lib/api/types";
import { sourceIssue, validateSource } from "@/lib/spec/validate-source";
import { useDatasources, useSourceMutations } from "@/hooks/use-sources";

const SQL_TEMPLATE =
  "select id, name, updated_at\n" +
  "from public.demo_table\n" +
  "where (updated_at, id) > ($1, $2)\n" +
  "order by updated_at, id\n" +
  "limit $3";

function newSource(): SourceSaveInput {
  return {
    code: "",
    name: "",
    kind: "sql",
    topic: "",
    enabled: true,
    intervalDuration: "60s",
    batchSize: 500,
    spec: {
      datasource: "",
      cursor_type: "timestamp",
      cursor_column: "updated_at,id",
      wrap: "row",
      select: SQL_TEMPLATE,
    },
    remark: "",
  };
}

function fromSource(s: SyncSource): SourceSaveInput {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    kind: s.kind,
    topic: s.topic,
    enabled: s.enabled,
    intervalDuration: s.interval_duration,
    batchSize: s.batch_size,
    spec: { ...s.spec },
    remark: s.remark ?? "",
  };
}

export function SourceEditorDrawer({
  open,
  source,
  onClose,
  onSaved,
}: {
  open: boolean;
  source: SyncSource | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const { save } = useSourceMutations();
  const { data: datasourceList, isLoading: dsLoading } = useDatasources();
  const [draft, setDraft] = useState<SourceSaveInput>(() => newSource());

  useEffect(() => {
    if (!open) return;
    setDraft(source ? fromSource(source) : newSource());
  }, [open, source]);

  const issues = useMemo(() => validateSource(draft), [draft]);
  const err = (path: string) => sourceIssue(issues, path);
  const patch = (p: Partial<SourceSaveInput>) => setDraft((d) => ({ ...d, ...p }));
  const patchSpec = (p: Partial<SourceSpec>) =>
    setDraft((d) => ({ ...d, spec: { ...d.spec, ...p } }));

  const names = datasourceList ?? [];
  const spec = draft.spec;
  const isSql = draft.kind === "sql";

  const submit = () => {
    if (issues.length > 0) {
      toast.error("配置还没通过校验", `${issues[0].path}：${issues[0].message}`);
      return;
    }
    save.mutate(draft, {
      onSuccess: (saved) => {
        toast.success(source ? "来源已更新" : "来源已创建", `${saved.code} · 游标保留在 ${saved.topic}`);
        onSaved?.();
        onClose();
      },
      onError: (e: Error) => toast.error("保存失败", e.message),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={source ? `编辑 ${source.code}` : "新增取数来源"}
      subtitle="配完点「立即拉取」先验一轮；保存不会推进游标"
      badge={
        <Badge tone={issues.length > 0 ? "danger" : "success"} dot>
          {issues.length > 0 ? `${issues.length} 处待修` : "校验通过"}
        </Badge>
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[11px] text-muted">
            {issues.length > 0 ? (
              <span className="flex items-center gap-1 text-danger">
                <TriangleAlert className="size-3.5" />
                {issues[0].path}：{issues[0].message}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success">
                <CircleCheck className="size-3.5" />
                结构校验通过；SQL 能不能跑要连源库才知道
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <SectionTitle title="基本" hint="编码建好后不能改：虚拟 topic 和游标都按它指代" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="编码" required error={err("code")} hint="小写字母 / 数字 / 下划线">
              <Input
                value={draft.code}
                disabled={!!source}
                placeholder="dtw_src_region"
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ code: e.target.value })}
              />
            </Field>
            <Field label="名称" required error={err("name")}>
              <Input value={draft.name} placeholder="区域增量拉取" onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="取数方式" hint="http 分页取数的运行时尚未实现，只能先存配置">
              <Select value={draft.kind} onChange={(e) => patch({ kind: e.target.value as SourceSaveInput["kind"] })}>
                <option value="sql">sql — 按复合游标查库</option>
                <option value="http">http — 分页拉接口（未实现）</option>
              </Select>
            </Field>
            <Field label="虚拟 topic" error={err("topic")} hint={<>留空自动生成 <code className="font-mono">source:{draft.code || "编码"}</code></>}>
              <Input
                value={draft.topic ?? ""}
                placeholder="留空自动生成"
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ topic: e.target.value })}
              />
            </Field>
            <Field label="调度间隔" required error={err("intervalDuration")} hint="jobx 按它触发，最小 1s">
              <Input
                value={draft.intervalDuration}
                placeholder="60s"
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ intervalDuration: e.target.value })}
              />
            </Field>
            <Field label="单批行数" required error={err("batchSize")} hint="1..=5000">
              <Input
                type="number"
                min={1}
                max={5000}
                value={draft.batchSize}
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ batchSize: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="备注" error={err("remark")}>
            <Input value={draft.remark ?? ""} placeholder="选填" onChange={(e) => patch({ remark: e.target.value })} />
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-line/70 px-3 py-2">
            <div>
              <p className="text-[12.5px] font-medium text-ink">启用</p>
              <p className="text-[11px] text-muted">停用不删游标，重新启用从原水位继续</p>
            </div>
            <Switch checked={draft.enabled} label="启用来源" onChange={(enabled) => patch({ enabled })} />
          </div>
        </section>

        <section className="space-y-3 border-t border-line/70 pt-4">
          <SectionTitle
            title="取数定义"
            hint={isSql ? "SQL 只读，游标占位 ($1, $2) 与 limit $3 由执行器注入" : "HTTP 分页配置只会入库，不会被执行"}
          />

          <Field
            label="数据源连接"
            required={isSql}
            error={err("spec.datasource")}
            hint={
              <>
                连接串在 <code className="font-mono">[syn.datasources.*]</code>（toml / consul）维护，
                这里按 code 选；{dsLoading ? "正在读取…" : `当前有 ${names.length} 个可选`}
              </>
            }
          >
            {names.length > 0 ? (
              <Select
                value={spec.datasource ?? ""}
                onChange={(e) => patchSpec({ datasource: e.target.value })}
                className="font-mono text-[12.5px]"
              >
                <option value="">请选择…</option>
                {names.map((d) => (
                  <option key={d.id ?? d.code} value={d.code}>
                    {d.code}{d.target ? ` · ${d.target}` : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={spec.datasource ?? ""}
                placeholder="还没读到可用连接，可先手填 code"
                className="font-mono text-[12.5px]"
                onChange={(e) => patchSpec({ datasource: e.target.value })}
              />
            )}
          </Field>

          {isSql ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="游标类型" error={err("spec.cursor_type")} hint="两列游标必须 timestamp">
                  <Select
                    value={spec.cursor_type ?? "timestamp"}
                    onChange={(e) => patchSpec({ cursor_type: e.target.value as SourceSpec["cursor_type"] })}
                    className="font-mono text-[12.5px]"
                  >
                    <option value="timestamp">timestamp</option>
                    <option value="int">int</option>
                    <option value="text">text</option>
                  </Select>
                </Field>
                <Field label="行包装" hint="row → op=r 的快照读；cdc → 查询本身就返回 CDC 形态">
                  <Select
                    value={spec.wrap ?? "row"}
                    onChange={(e) => patchSpec({ wrap: e.target.value as SourceSpec["wrap"] })}
                    className="font-mono text-[12.5px]"
                  >
                    <option value="row">row</option>
                    <option value="cdc">cdc</option>
                  </Select>
                </Field>
              </div>
              <Field
                label="游标列"
                required
                error={err("spec.cursor_column") || err("spec.cursor_column[0]") || err("spec.cursor_column[1]")}
                hint="最多两列：时间戳 + ID，逗号分隔；回读 5 秒重叠窗口靠第一列"
              >
                <Input
                  value={spec.cursor_column ?? ""}
                  placeholder="updated_at,id"
                  className="font-mono text-[12.5px]"
                  onChange={(e) => patchSpec({ cursor_column: e.target.value })}
                />
              </Field>
              <Field label="取数 SQL" required error={err("spec.select")} hint="单条 select / with；不要写分号结尾之外的第二条语句">
                <Textarea
                  rows={7}
                  spellCheck={false}
                  value={spec.select ?? ""}
                  className="font-mono text-[11.5px]"
                  onChange={(e) => patchSpec({ select: e.target.value })}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-lg bg-sunken/70 px-3 py-2 text-[11.5px] leading-snug text-muted">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  全量分页取数：一轮推一页，翻到底自动标记完成、此后不再拉。只用于
                  <b className="font-semibold text-ink">首次同步</b>
                  ——增量交给 dbz，两边别同时写同一张表。
                </span>
              </div>
              <Field label="分页地址" required error={err("spec.url")} hint="用 {cursor} / {size} 占位">
                <Input
                  value={spec.url ?? ""}
                  placeholder="http://upstream/api/page?cursor={cursor}&size={size}"
                  className="font-mono text-[12.5px]"
                  onChange={(e) => patchSpec({ url: e.target.value })}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="数据数组路径"
                  error={err("spec.data_path")}
                  hint="响应里放行的位置，缺省 $（响应本身是数组）"
                >
                  <Input
                    value={spec.data_path ?? ""}
                    placeholder="$.data.list"
                    className="font-mono text-[12.5px]"
                    onChange={(e) => patchSpec({ data_path: e.target.value })}
                  />
                </Field>
                <Field
                  label="下一页游标路径"
                  error={err("spec.next_path")}
                  hint="不填就按页码 1,2,3… 翻，空页即结束"
                >
                  <Input
                    value={spec.next_path ?? ""}
                    placeholder="$.extra.nextCursor"
                    className="font-mono text-[12.5px]"
                    onChange={(e) => patchSpec({ next_path: e.target.value })}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="请求方法" error={err("spec.method")}>
                  <Select
                    value={spec.method ?? "GET"}
                    onChange={(e) => patchSpec({ method: e.target.value as "GET" | "POST" })}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </Select>
                </Field>
                <Field label="单页条数" error={err("spec.page_size")} hint="缺省用上面的单批行数">
                  <Input
                    type="number"
                    min={1}
                    value={spec.page_size ?? ""}
                    className="font-mono text-[12.5px]"
                    onChange={(e) =>
                      patchSpec({ page_size: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
            </>
          )}
        </section>

        <div className="flex items-start gap-2 rounded-lg bg-sunken/70 px-3 py-2 text-[11px] leading-relaxed text-muted">
          <DatabaseZap className="mt-0.5 size-3.5 shrink-0" />
          <span>
            来源把行包进虚拟 topic <code className="font-mono">{draft.topic?.trim() || `source:${draft.code || "编码"}`}</code>；
            要真正投递，还得有一个监听这个 topic 的同步任务。改来源配置不会让执行器立刻生效，任务那边保存时会自动通知各副本刷新快照。
          </span>
        </div>
      </div>
    </Modal>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{hint}</p>
    </div>
  );
}

/** 删除确认。级联清掉 syn_cursor，水位不会留下孤儿 */
export function RemoveSourceDialog({
  source,
  onClose,
}: {
  source: SyncSource | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const { remove } = useSourceMutations();
  return (
    <ConfirmDialog
      open={!!source}
      title={`删除来源 ${source?.code ?? ""}？`}
      description="配置与游标会一起删掉（syn_cursor 级联）。已经投递到下游的数据不受影响；下次用同名重建会从零水位重跑。"
      confirmText="删除"
      loading={remove.isPending}
      onCancel={onClose}
      onConfirm={() => {
        if (!source) return;
        remove.mutate(source.id, {
          onSuccess: () => {
            toast.success("来源已删除", `${source.code} 的配置与游标已清除`);
            onClose();
          },
          onError: (e: Error) => toast.error("删除失败", e.message),
        });
      }}
    />
  );
}
