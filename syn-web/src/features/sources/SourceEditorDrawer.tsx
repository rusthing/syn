/**
 * 数据抽取的新增 / 编辑窗体。
 *
 * 后端 `syn_source` 的 CRUD 一直在，缺的是这个入口：以前只能靠直接写库或调接口
 * 建抽取定义，界面上只有「看 / 拉 / 启停」。连接串不在这里维护 —— 那是
 * `[syn.datasources.*]`（toml / consul）的事，这里只从只读清单里选名字。
 *
 * 功能上只让人填「表名 + 游标字段」，取数 SQL 由系统生成（下方预览与后端执行器同模板）。
 */

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, DatabaseZap, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog, Modal } from "@/components/ui/Drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import type { SourceSaveInput, SourceSpec, SyncSource } from "@/lib/api/types";
import { buildSourceSql } from "@/lib/spec/source-sql";
import { sourceIssue, validateSource } from "@/lib/spec/validate-source";
import { useDatasources, useSourceMutations } from "@/hooks/use-sources";

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
      mode: "cursor",
      table: "",
      cursor_field: "",
      cursor_type: "bigint",
      tie_field: "",
      tie_type: "bigint",
      snapshot_batched: false,
      wrap: "row",
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
  /** 自动生成 / 手写 SQL。手写时 spec.sql 存在（哪怕是空串），后端据此判定「手写模式」 */
  const [sqlMode, setSqlMode] = useState<"auto" | "custom">("auto");

  useEffect(() => {
    if (!open) return;
    setDraft(source ? fromSource(source) : newSource());
    setSqlMode(source?.spec.sql !== undefined ? "custom" : "auto");
  }, [open, source]);

  const issues = useMemo(() => validateSource(draft), [draft]);
  const err = (path: string) => sourceIssue(issues, path);
  const patch = (p: Partial<SourceSaveInput>) => setDraft((d) => ({ ...d, ...p }));
  const patchSpec = (p: Partial<SourceSpec>) =>
    setDraft((d) => ({ ...d, spec: { ...d.spec, ...p } }));

  const names = datasourceList ?? [];
  const spec = draft.spec;
  const isSql = draft.kind === "sql";
  const mode = spec.mode ?? "cursor";
  const isCursor = isSql && mode === "cursor";

  /** 切抽取方式时把半边字段清掉：http 源里残留库表字段会被后端判为冲突 */
  const switchKind = (kind: SourceSaveInput["kind"]) => {
    if (kind === draft.kind) return;
    setSqlMode("auto");
    patch({
      kind,
      spec:
        kind === "sql"
          ? { ...newSource().spec }
          : { url: "", data_path: "", next_path: "", method: "GET", wrap: spec.wrap ?? "row" },
    });
  };

  /** 切「自动 / 手写」：切回自动要真的删掉 sql，否则后端仍按手写跑 */
  const switchSqlMode = (next: "auto" | "custom") => {
    setSqlMode(next);
    if (next === "auto") patchSpec({ sql: undefined });
    else patchSpec({ sql: spec.sql ?? "" });
  };

  const submit = () => {
    if (issues.length > 0) {
      toast.error("配置还没通过校验", `${issues[0].path}：${issues[0].message}`);
      return;
    }
    save.mutate(draft, {
      onSuccess: (saved) => {
        if (saved.notice) {
          // 抽取定义变了，后端已清空水位：用 info 而不是 success，避免被当成普通保存
          toast.info(source ? "数据抽取已更新" : "数据抽取已创建", saved.notice);
        } else {
          toast.success(
            source ? "数据抽取已更新" : "数据抽取已创建",
            `${saved.code} · 游标保留在 ${saved.topic}`,
          );
        }
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
      width={760}
      title={source ? `编辑 ${source.code}` : "新增数据抽取"}
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
            <Field label="抽取方式" hint="SQL 库表可选全量快照 / 游标增量；http 按页全量拉接口，只用于首次同步">
              <Select
                value={draft.kind}
                onChange={(e) => switchKind(e.target.value as SourceSaveInput["kind"])}
              >
                <option value="sql">sql — 库表取数</option>
                <option value="http">http — 分页拉接口</option>
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
            <Field label="单批行数" required error={err("batchSize")} hint="1..=5000；也是快照分批的大小">
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
        </section>

        <section className="space-y-3 border-t border-line/70 pt-4">
          <SectionTitle
            title="抽取定义"
            hint={isSql ? "表名与游标字段填好后，取数 SQL 由系统生成" : "HTTP 全量分页：一轮推一页，翻到底自动完成"}
          />

          {isSql && (
            <div className="grid gap-2 sm:grid-cols-2">
              <ModeCard
                active={mode === "cursor"}
                title="游标增量"
                desc="按主游标 + 决胜字段定时拉，捕获不到物理删除"
                onClick={() => patchSpec({ mode: "cursor" })}
              />
              <ModeCard
                active={mode === "snapshot"}
                title="全量快照"
                desc="一次性把整表拉一遍，用于初始化"
                onClick={() => patchSpec({ mode: "snapshot" })}
              />
            </div>
          )}

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
              <Field label="SQL 来源" hint="自动生成按源表名拼；手写适合 join / 自定义过滤，输出仍受游标条件约束">
                <Select value={sqlMode} onChange={(e) => switchSqlMode(e.target.value as "auto" | "custom")}>
                  <option value="auto">自动生成 — 填源表名</option>
                  <option value="custom">手写 SQL — 单条 select / with</option>
                </Select>
              </Field>

              {sqlMode === "auto" ? (
                <Field label="源表名" required error={err("spec.table")} hint="表名写库里的真实名字（区分大小写），可用 schema.table">
                  <Input
                    value={spec.table ?? ""}
                    placeholder="dtw_polygon"
                    className="font-mono text-[12.5px]"
                    onChange={(e) => patchSpec({ table: e.target.value })}
                  />
                </Field>
              ) : (
                <Field
                  label="手写 SQL"
                  required
                  error={err("spec.sql")}
                  hint="输出必须含主游标字段与决胜字段；系统会把它当子查询，再套游标条件、排序与 LIMIT"
                >
                  <Textarea
                    rows={8}
                    value={spec.sql ?? ""}
                    placeholder={"select id, update_time\nfrom dtw_polygon\nwhere deleted = false"}
                    className="font-mono text-[11.5px] leading-relaxed"
                    onChange={(e) => patchSpec({ sql: e.target.value })}
                  />
                </Field>
              )}

              {isCursor ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="主游标字段"
                      required
                      error={err("spec.cursor_field")}
                      hint="时间戳 / 自增 ID，按库里真实列名（区分大小写）"
                    >
                      <Input
                        value={spec.cursor_field ?? ""}
                        placeholder="update_timestamp"
                        className="font-mono text-[12.5px]"
                        onChange={(e) => patchSpec({ cursor_field: e.target.value })}
                      />
                    </Field>
                    <Field label="主游标类型" error={err("spec.cursor_type")} hint="按源库真实类型选">
                      <Select
                        value={spec.cursor_type ?? "bigint"}
                        onChange={(e) =>
                          patchSpec({ cursor_type: e.target.value as SourceSpec["cursor_type"] })
                        }
                        className="font-mono text-[12.5px]"
                      >
                        <option value="bigint">bigint</option>
                        <option value="timestamptz">timestamptz</option>
                        <option value="varchar">varchar</option>
                      </Select>
                    </Field>
                    <Field
                      label="决胜字段"
                      required
                      error={err("spec.tie_field")}
                      hint="必须唯一：解决同一主游标值并发写入"
                    >
                      <Input
                        value={spec.tie_field ?? ""}
                        placeholder="id"
                        className="font-mono text-[12.5px]"
                        onChange={(e) => patchSpec({ tie_field: e.target.value })}
                      />
                    </Field>
                    <Field label="决胜字段类型" error={err("spec.tie_type")} hint="uuid 不能做主游标，时间戳不能决胜">
                      <Select
                        value={spec.tie_type ?? "bigint"}
                        onChange={(e) => patchSpec({ tie_type: e.target.value as SourceSpec["tie_type"] })}
                        className="font-mono text-[12.5px]"
                      >
                        <option value="bigint">bigint</option>
                        <option value="uuid">uuid</option>
                        <option value="varchar">varchar</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="flex items-start gap-2 rounded-lg bg-warn-soft/60 px-3 py-2 text-[11.5px] leading-snug text-ink-soft">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    <span>
                      基于 SQL 轮询的增量机制<b className="font-semibold text-ink">无法捕获源库的物理删除</b>；
                      需要同步删除得靠 CDC 或软删标记。
                    </span>
                  </div>
                </>
              ) : (
                <Field
                  label="拉取方式"
                  hint="分批按单批行数循环翻页，一次调用内拉完；单次全表适合小表"
                >
                  <Select
                    value={spec.snapshot_batched ? "batched" : "single"}
                    onChange={(e) => patchSpec({ snapshot_batched: e.target.value === "batched" })}
                  >
                    <option value="single">单次全表 — SELECT * FROM 表</option>
                    <option value="batched">分批拉取 — 每批按单批行数翻页</option>
                  </Select>
                </Field>
              )}

              <Field label="取数 SQL（预览）" hint="只读：最终执行形态；手写 SQL 会被包成子查询">
                <pre className="max-h-[190px] overflow-auto rounded-lg bg-sunken/70 p-3 font-mono text-[11.5px] leading-relaxed text-ink-soft">
                  {buildSourceSql(spec, draft.batchSize)}
                </pre>
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
            数据抽取把行包进虚拟 topic <code className="font-mono">{draft.topic?.trim() || `source:${draft.code || "编码"}`}</code>；
            要真正投递，还得有一个监听这个 topic 的同步任务。改抽取配置不会让执行器立刻生效，任务那边保存时会自动通知各副本刷新快照。
          </span>
        </div>
      </div>
    </Modal>
  );
}

function ModeCard({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border px-3 py-2 text-left transition-colors",
        active
          ? "border-accent bg-accent-soft"
          : "border-line bg-surface hover:border-line-strong hover:bg-sunken",
      )}
    >
      <div className="flex items-center justify-between text-[13px] font-semibold text-ink">
        {title}
        {active && <CircleCheck className="size-3.5 text-accent-strong" />}
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{desc}</p>
    </button>
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
      title={`删除数据抽取 ${source?.code ?? ""}？`}
      description="配置与游标会一起删掉（syn_cursor 级联）。已经投递到下游的数据不受影响；下次用同名重建会从零水位重跑。"
      confirmText="删除"
      loading={remove.isPending}
      onCancel={onClose}
      onConfirm={() => {
        if (!source) return;
        remove.mutate(source.id, {
          onSuccess: () => {
            toast.success("数据抽取已删除", `${source.code} 的配置与游标已清除`);
            onClose();
          },
          onError: (e: Error) => toast.error("删除失败", e.message),
        });
      }}
    />
  );
}
