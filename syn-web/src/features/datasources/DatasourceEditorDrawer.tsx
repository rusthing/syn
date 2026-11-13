/**
 * 数据源的新增 / 编辑抽屉。
 *
 * 连接串（含账号密码）是唯一「只写不读」的字段：新建必填；编辑态输入框永远留空，
 * 只显示服务端返回的脱敏 target，绝不回显明文 url，留空保存即表示不修改连接串。
 */

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Drawer } from "@/components/ui/Drawer";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import type { DatasourceInfo, DatasourceSaveInput } from "@/lib/api/types";
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
}: {
  open: boolean;
  datasource: DatasourceInfo | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const { create, update } = useDatasourceMutations();
  const [draft, setDraft] = useState<DatasourceSaveInput>(() => newDatasource());
  const isEdit = datasource !== null;

  useEffect(() => {
    if (!open) return;
    setDraft(datasource ? fromDatasource(datasource) : newDatasource());
  }, [open, datasource]);

  const issues = useMemo(() => validateDraft(draft, isEdit), [draft, isEdit]);
  const err = (path: string) => issues.find((i) => i.path === path)?.message ?? null;
  const patch = (p: Partial<DatasourceSaveInput>) => setDraft((d) => ({ ...d, ...p }));
  const saving = create.isPending || update.isPending;

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
    <Drawer
      open={open}
      onClose={onClose}
      width={600}
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
                结构校验通过；连接能不能用要保存后由执行器验证
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
          <SectionTitle title="基本" hint="编码建好后不建议改：取数来源与任务的 db 目标都按它指代连接" />
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
          <div className="flex items-center justify-between rounded-lg border border-line/70 px-3 py-2">
            <div>
              <p className="text-[12.5px] font-medium text-ink">启用</p>
              <p className="text-[11px] text-muted">停用后仍保留配置，但不会被新的取数 / 投递引用</p>
            </div>
            <Switch checked={draft.enabled} label="启用数据源" onChange={(enabled) => patch({ enabled })} />
          </div>
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
              onChange={(e) => patch({ url: e.target.value })}
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
    </Drawer>
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
