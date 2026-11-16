/**
 * 数据源的新增 / 编辑窗体。
 *
 * 连接串（含账号密码）是唯一「只写不读」的字段：新建必填；编辑态输入框永远留空，
 * 只显示服务端返回的脱敏 target，绝不回显明文 url，留空保存即表示不修改连接串。
 *
 * **窗体里没有启用开关**：启停是卡片右上角的事。同一件事两个入口，用户在一处关掉、
 * 在另一处又打开，最后没人说得清是哪次生效（照 dbz 控制面板的规矩）。
 *
 * 「测试连接」是唯一允许留在窗体里的动作，它不写库、不改任何状态，只回答
 * 「现在这条能不能连上」。结果写在底部状态栏 —— 和卡片状态栏是同一句话。
 */

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, KeyRound, Plug, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Drawer";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import type { DatasourceInfo, DatasourceSaveInput, DatasourceTestResult } from "@/lib/api/types";
import { useDatasourceMutations } from "@/hooks/use-sources";

interface Issue {
  path: string;
  message: string;
}

function newDatasource(): DatasourceSaveInput {
  return {
    code: "",
    name: "",
    url: "",
    maxConnections: 4,
    enabled: true,
    remark: "",
  };
}

/** 编辑态从脱敏实体取可改字段；`url` 必须留空 —— 明文从来没到过浏览器 */
function fromDatasource(d: DatasourceInfo): DatasourceSaveInput {
  return {
    code: d.code,
    name: d.name,
    url: "",
    maxConnections: d.maxConnections,
    enabled: d.enabled,
    remark: d.remark ?? "",
  };
}

function validateDraft(d: DatasourceSaveInput, isEdit: boolean): Issue[] {
  const issues: Issue[] = [];
  // 后端对 code 只校验长度（列注释 `@len 1..=64`）。这里**不要**额外收紧字符集：
  // 前端比后端严会出现「页面拦下一个后端本来能存的名字」，两边规则必须一致。
  const code = d.code.trim();
  if (!code) issues.push({ path: "code", message: "必填，最长 64 字符" });
  else if (code.length > 64) issues.push({ path: "code", message: "编码最长 64 字符" });
  if (!d.name.trim()) issues.push({ path: "name", message: "名称必填" });
  if (!isEdit && !d.url?.trim()) issues.push({ path: "url", message: "新增必须填连接串" });
  if (!Number.isInteger(d.maxConnections) || d.maxConnections < 1 || d.maxConnections > 100) {
    issues.push({ path: "maxConnections", message: "连接池上限需在 1..=100 之间" });
  }
  return issues;
}

export function DatasourceEditorDrawer({
  open,
  datasource,
  onClose,
  onSaved,
  onTested,
}: {
  open: boolean;
  datasource: DatasourceInfo | null;
  onClose: () => void;
  onSaved?: () => void;
  /** 窗体里测出的结果同步给页面：关掉窗体后卡片状态栏还留着这句话 */
  onTested?: (result: DatasourceTestResult) => void;
}) {
  const toast = useToast();
  const { create, update, test } = useDatasourceMutations();
  const [draft, setDraft] = useState<DatasourceSaveInput>(() => newDatasource());
  /** 最近一次连接测试的结果；改了连接串就清掉，免得「测过了」的结论落在旧串上 */
  const [tested, setTested] = useState<DatasourceTestResult | null>(null);
  const isEdit = datasource !== null;

  useEffect(() => {
    if (!open) return;
    setDraft(datasource ? fromDatasource(datasource) : newDatasource());
    setTested(null);
  }, [open, datasource]);

  const issues = useMemo(() => validateDraft(draft, isEdit), [draft, isEdit]);
  const err = (path: string) => issues.find((i) => i.path === path)?.message ?? null;
  const patch = (p: Partial<DatasourceSaveInput>) => setDraft((d) => ({ ...d, ...p }));
  const saving = create.isPending || update.isPending;

  /** 测试：填了新连接串就测草稿，否则测库里那条（编辑态不必为重测再输一遍密码） */
  const runTest = () => {
    const id = datasource?.id;
    const url = draft.url?.trim();
    if (!url && !id) {
      toast.error("没有可测的连接串", "先填上连接串，或保存后再测");
      return;
    }
    test.mutate(
      { id, url: url || undefined },
      {
        onSuccess: (result) => {
          setTested(result);
          onTested?.(result);
          if (result.ok) {
            toast.success(
              "连上了",
              `${result.elapsedMs}ms${result.server ? ` · ${result.server}` : ""}`,
            );
          } else {
            toast.error("连不上", result.message);
          }
        },
        onError: (err) => toast.error("测试失败", err.message),
      },
    );
  };

  const submit = () => {
    if (issues.length > 0) {
      toast.error("配置还没通过校验", `${issues[0].path}：${issues[0].message}`);
      return;
    }
    const done = (saved: DatasourceInfo) => {
      toast.success(isEdit ? "数据源已更新" : "数据源已创建", `${saved.code} · 连接串不会回显`);
      onSaved?.();
      onClose();
    };
    const fail = (e: Error) => toast.error("保存失败", e.message);
    if (isEdit && datasource) {
      update.mutate({ id: datasource.id, input: draft }, { onSuccess: done, onError: fail });
    } else {
      create.mutate(draft, { onSuccess: done, onError: fail });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={isEdit ? `编辑 ${datasource?.code ?? ""}` : "新增数据源"}
      subtitle={
        isEdit
          ? "连接串留空即不修改；服务端只返回脱敏后的目标"
          : "连接串含账号密码，只在保存时提交，绝不会回显"
      }
      badge={
        <Badge tone={issues.length > 0 ? "danger" : "success"} dot>
          {issues.length > 0 ? `${issues.length} 处待修` : "校验通过"}
        </Badge>
      }
      footer={
        // 状态栏：测试结果优先（那是刚发生的事实），其次才是结构校验的结论
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[11px] text-muted">
            {tested ? (
              <span
                className={cn(
                  "flex items-center gap-1",
                  tested.ok ? "text-success" : "text-danger",
                )}
              >
                {tested.ok ? <CircleCheck className="size-3.5" /> : <XCircle className="size-3.5" />}
                <span className="truncate">
                  {tested.ok
                    ? `连通 · ${tested.elapsedMs}ms${tested.server ? ` · ${tested.server}` : ""}`
                    : tested.message}
                </span>
              </span>
            ) : issues.length > 0 ? (
              <span className="flex items-center gap-1 text-danger">
                <TriangleAlert className="size-3.5" />
                {issues[0].path}：{issues[0].message}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success">
                <CircleCheck className="size-3.5" />
                结构校验通过，可以先点「测试」确认连得上
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Plug className="size-3.5" />}
              loading={test.isPending}
              onClick={runTest}
            >
              测试
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={saving} onClick={submit}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <section className="space-y-3">
          <SectionTitle title="基本" hint="编码建好后不建议改：数据抽取与任务的 db 目标都按它指代连接" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="编码" required error={err("code")} hint="小写字母 / 数字 / 下划线">
              <Input
                value={draft.code}
                disabled={isEdit}
                placeholder="dtw"
                spellCheck={false}
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ code: e.target.value })}
              />
            </Field>
            <Field label="名称" required error={err("name")}>
              <Input value={draft.name} placeholder="定位库" onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="连接池上限" required error={err("maxConnections")} hint="1..=100">
              <Input
                type="number"
                min={1}
                max={100}
                value={draft.maxConnections}
                className="font-mono text-[12.5px]"
                onChange={(e) => patch({ maxConnections: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="备注" hint="选填，最长 500 字">
            <Textarea
              rows={2}
              value={draft.remark ?? ""}
              placeholder="用途、负责人等"
              className="text-[12.5px]"
              onChange={(e) => patch({ remark: e.target.value })}
            />
          </Field>
        </section>

        <section className="space-y-3 border-t border-line/70 pt-4">
          <SectionTitle
            title="连接串"
            hint="含账号密码，只在写入口收；读接口一律返回脱敏后的 host:port/db"
          />
          {isEdit && (
            <div className="flex items-start gap-2 rounded-lg bg-sunken/70 px-3 py-2 text-[11.5px] leading-snug text-muted">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
              <span>
                当前脱敏目标：
                <code className="font-mono">{datasource?.target || "（未解析出目标）"}</code>
                。出于安全，服务端不返回连接串明文，这里也不会回显。
              </span>
            </div>
          )}
          <Field
            label="连接串"
            required={!isEdit}
            error={err("url")}
            hint={
              isEdit
                ? "留空表示不修改连接串；填写则覆盖原值"
                : "postgres://user:password@host:5432/db；只在保存时提交"
            }
          >
            <Input
              value={draft.url ?? ""}
              placeholder={isEdit ? "留空表示不修改" : "postgres://user:password@host:5432/db"}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12.5px]"
              onChange={(e) => {
                patch({ url: e.target.value });
                setTested(null);
              }}
            />
          </Field>
        </section>

        <div className="flex items-start gap-2 rounded-lg bg-sunken/70 px-3 py-2 text-[11px] leading-relaxed text-muted">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <span>
            连接串只在保存时发给服务端，列表与详情都只拿得到脱敏后的
            <code className="font-mono"> target </code>
            。编辑时不填就是不改，输入框不会带出任何已保存的明文。
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
