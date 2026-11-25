import type { ReactNode } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { PanelImportMode, PanelImportResult } from "@/lib/api/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Drawer";
import { cn } from "@/lib/utils";
import {
  missingUrlCodes,
  planCounts,
  type ImportAction,
  type ImportPlan,
  type PanelArchive,
} from "./panel-archive";

interface Props {
  open: boolean;
  archive: PanelArchive | null;
  plan: ImportPlan | null;
  mode: PanelImportMode;
  /** 按数据源 code 存放用户补填的连接串 */
  urls: Record<string, string>;
  busy: boolean;
  /** 后端整批回滚后的错误说明 */
  error: string | null;
  /** 上一次成功的结果（失败时为空）；成功后窗体关闭，这里只用于“重试已成功”的极端情况 */
  result: PanelImportResult | null;
  onModeChange: (mode: PanelImportMode) => void;
  onUrlChange: (code: string, value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

const ACTION_META: Record<ImportAction, { label: string; tone: "success" | "info" | "muted" }> = {
  create: { label: "新建", tone: "success" },
  update: { label: "覆盖", tone: "info" },
  skip: { label: "跳过", tone: "muted" },
};

/**
 * 导入预览窗体。
 *
 * 先算清楚再动手：每条组件的新建 / 覆盖 / 跳过、文件与环境的引用冲突、
 * 新增数据源缺哪些连接串，全部在这一屏里给完。用户确认后由后端单事务落库，
 * 失败即整批回滚，所以窗体里不会出现「导了一半」的中间态。
 */
export function PanelImportDialog({
  open,
  archive,
  plan,
  mode,
  urls,
  busy,
  error,
  result,
  onModeChange,
  onUrlChange,
  onClose,
  onConfirm,
}: Props) {
  if (!archive || !plan) return null;
  const counts = planCounts(plan);
  const missing = missingUrlCodes(plan, urls);
  const blocked = plan.blockers.length > 0;
  const canImport = !busy && !blocked && missing.length === 0;

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="导入控制面板"
      subtitle={`文件导出于 ${formatWhen(archive.exported_at)} · 数据源 ${archive.summary.datasources} · 数据抽取 ${archive.summary.sources} · 任务 ${archive.summary.tasks} · 主题 ${archive.summary.topics}`}
      width={760}
      height={760}
      footer={
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Badge tone="success">{counts.create} 新建</Badge>
            <Badge tone="info">{counts.update} 覆盖</Badge>
            <Badge tone="muted">{counts.skip} 跳过</Badge>
          </div>
          <div className="flex items-center gap-2">
            {missing.length > 0 && (
              <span className="text-[12px] text-warn">还有 {missing.length} 个数据源未填连接串</span>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              loading={busy}
              disabled={!canImport}
            >
              {error ? "重试导入" : "开始导入"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warn/25 bg-warn-soft/60 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-warn">
              <ShieldAlert className="size-3.5" />
              文件含数据源连接串明文
            </div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-soft">
              按密钥保管，别随工单或群聊扩散。游标水位、最近拉取结果不在文件里：
              导入后沿用当前环境的水位；抽取定义变化的会清空该条水位（预览里会标出）。
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12.5px] font-medium text-ink">已存在的组件怎么处理</div>
            <div className="mt-0.5 text-[11.5px] text-muted">
              数据源按 code 识别、数据抽取按 topic 识别，任务按「topic + 名称」识别（同名多条按排序值就近匹配）
            </div>
          </div>
          <div className="flex shrink-0 rounded-lg border border-line bg-surface p-0.5">
            <ModeButton
              active={mode === "overwrite"}
              onClick={() => onModeChange("overwrite")}
              title="覆盖"
              hint="已有则更新"
            />
            <ModeButton
              active={mode === "skip"}
              onClick={() => onModeChange("skip")}
              title="仅补缺"
              hint="已有则跳过"
            />
          </div>
        </div>

        {plan.blockers.length > 0 && (
          <div className="rounded-lg border border-danger/25 bg-danger-soft/70 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium text-danger">
              <AlertTriangle className="size-3.5" />
              这些冲突不处理就没法导入（后端会整批回滚）
            </div>
            <ul className="space-y-1 text-[11.5px] leading-relaxed text-ink-soft">
              {plan.blockers.map((text) => (
                <li key={text}>· {text}</li>
              ))}
            </ul>
          </div>
        )}

        {plan.warnings.length > 0 && (
          <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
            <div className="mb-1 text-[12px] font-medium text-ink-soft">提示</div>
            <ul className="space-y-1 text-[11.5px] leading-relaxed text-muted">
              {plan.warnings.map((text) => (
                <li key={text}>· {text}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-danger/25 bg-danger-soft/70 px-3 py-2.5 text-[12px] leading-relaxed text-danger">
            导入失败，整批已回滚：{error}
          </div>
        )}
        {result && !error && (
          <div className="rounded-lg border border-success/25 bg-success-soft/60 px-3 py-2.5 text-[12px] leading-relaxed text-success">
            已写入：数据源 {result.datasources.created + result.datasources.updated} 条、
            数据抽取 {result.sources.created + result.sources.updated} 条、
            任务 {result.tasks.created + result.tasks.updated} 条
            {result.watermarks_reset > 0 ? `；${result.watermarks_reset} 条抽取的水位已清空` : ""}
          </div>
        )}

        <Section title="数据源" count={plan.datasources.length}>
          {plan.datasources.map((row) => {
            const item = archive.datasources[row.index];
            return (
              <Row key={row.code} action={row.action}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[12.5px] text-ink">{row.code}</span>
                  <span className="min-w-0 truncate text-[12.5px] text-ink-soft">{row.name}</span>
                  <Badge tone="muted">{item.engine}</Badge>
                  {row.target && (
                    <span className="font-mono text-[11px] text-muted">{row.target}</span>
                  )}
                </div>
                {row.needsUrl && row.action === "create" ? (
                  <div className="mt-2 max-w-xl">
                    <Field
                      label="连接串（新增必填）"
                      hint="含账号密码，只写入当前环境；不会回显"
                      required
                    >
                      <Input
                        value={urls[row.code] ?? ""}
                        onChange={(e) => onUrlChange(row.code, e.target.value)}
                        placeholder={`${item.engine}://user:password@host:5432/db`}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    </Field>
                    {(row.action === "create" && !(urls[row.code] ?? "").trim()) && (
                      <span className="mt-1 block text-[11.5px] text-warn">
                        这个数据源当前环境没有，不填连接串无法新建
                      </span>
                    )}
                  </div>
                ) : row.action === "update" ? (
                  <div className="mt-1 text-[11px] text-muted">
                    {item.url.trim()
                      ? "连接串按文件覆盖"
                      : "文件没带连接串，沿用当前环境已保存的那条"}
                  </div>
                ) : null}
              </Row>
            );
          })}
        </Section>

        <Section title="数据抽取" count={plan.sources.length}>
          {plan.sources.map((row) => {
            const item = archive.sources[row.index];
            return (
              <Row key={row.topic || row.index} action={row.action}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-[12.5px] text-ink">{row.name}</span>
                  <Badge tone={item.kind === "http" ? "info" : "accent"}>
                    {item.kind === "http" ? "HTTP" : "SQL"}
                  </Badge>
                  <span className="font-mono text-[11px] text-muted">{row.topic}</span>
                  {!item.enabled && <Badge tone="muted">停用</Badge>}
                </div>
                {row.action === "update" && (
                  <div className="mt-1 text-[11px] text-muted">
                    覆盖会按文件重写定义；游标字段 / 表 / 模式变化时旧水位会被清空
                  </div>
                )}
              </Row>
            );
          })}
        </Section>

        <Section title="任务" count={plan.tasks.length}>
          {plan.tasks.map((row) => {
            const item = archive.tasks[row.index];
            return (
              <Row key={`${row.topic}\u0000${row.name}\u0000${row.index}`} action={row.action}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-[12.5px] text-ink">{row.name}</span>
                  <span className="font-mono text-[11px] text-muted">{row.topic}</span>
                  <span className="text-[11px] text-muted">排序 {row.sort_order}</span>
                  {!item.enabled && <Badge tone="muted">停用</Badge>}
                  {item.exclusive === false && <Badge tone="info">继续向下</Badge>}
                </div>
              </Row>
            );
          })}
        </Section>
      </div>
    </Modal>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
        <span className="text-[11px] text-muted">{count} 条</span>
      </div>
      <div className="divide-y divide-line rounded-lg border border-line bg-surface">
        {children}
      </div>
    </section>
  );
}

function Row({ action, children }: { action: ImportAction; children: ReactNode }) {
  const meta = ACTION_META[action];
  return (
    <div className={cn("px-3 py-2.5", action === "skip" && "opacity-70")}>
      <div className="flex items-start gap-2">
        <Badge tone={meta.tone} className="mt-[1px] shrink-0">
          {meta.label}
        </Badge>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-left transition-colors",
        active ? "bg-accent text-on-accent" : "text-ink-soft hover:bg-ink/[0.04]",
      )}
    >
      <span className="block text-[12px] font-medium leading-tight">{title}</span>
      <span className={cn("block text-[10.5px] leading-tight", active ? "text-on-accent/80" : "text-muted")}>
        {hint}
      </span>
    </button>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return "未标注";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
