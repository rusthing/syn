/**
 * # 控制面板 · 右侧属性栏
 *
 * 单击画布上任意卡片即显示它的属性（点空白取消选中）。数据源直接取 `GraphNode`，
 * 不另发请求、不另存一份状态 —— 图是从三张业务表现拼的，属性栏就不可能和画布不一致。
 *
 * 这里同时给任务卡右上角那个开关一个**原尺寸**的替身：画布默认缩到 45%，
 * 18px 的开关实际只有 8px 出头，属性栏里的开关不会跟着缩，改配置时更好点。
 *
 * 主题是虚拟节点，没有实体可编辑，所以不给「编辑配置」按钮，改成说明文字。
 */

import type { ReactNode } from "react";
import { MousePointerClick, Pencil, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/time";
import { targetDetail, targetSummary, type GraphNode, type TaskStage } from "./graph";

const KIND_LABEL: Record<GraphNode["kind"], string> = {
  datasource: "数据源",
  source: "取数来源",
  topic: "主题（虚拟节点）",
  task: "同步任务",
};

const TONE_BADGE: Record<GraphNode["tone"], "success" | "warn" | "danger" | "muted"> = {
  ok: "success",
  warn: "warn",
  bad: "danger",
  muted: "muted",
};

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-[7px] last:border-0">
      <span className="shrink-0 pt-px text-[11.5px] text-muted">{label}</span>
      <span
        className={cn(
          "min-w-0 break-all text-right text-[12px] text-ink",
          mono && "font-mono text-[11px] leading-[18px]",
        )}
      >
        {children}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted">{title}</h3>
      <div className="rounded-lg border border-line bg-canvas/60 px-2.5 py-0.5">{children}</div>
    </section>
  );
}

interface Props {
  node: GraphNode | null;
  onClose: () => void;
  /** 双击同效：打开居中窗体改配置 */
  onOpenEntity: (node: GraphNode) => void;
  onOpenStage: (node: GraphNode, stage: TaskStage) => void;
  onToggleEnabled: (node: GraphNode, next: boolean) => void;
  enabledBusy?: boolean;
}

export function TopologyInspector({
  node,
  onClose,
  onOpenEntity,
  onOpenStage,
  onToggleEnabled,
  enabledBusy,
}: Props) {
  return (
    <aside className="flex w-[292px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <MousePointerClick className="size-3.5 text-accent" />
          <span className="text-[12.5px] font-semibold text-ink">属性</span>
          {node && <span className="text-[11px] text-muted">· {KIND_LABEL[node.kind]}</span>}
        </div>
        {node && (
          <IconButton label="关闭属性栏" onClick={onClose}>
            <X className="size-3.5" />
          </IconButton>
        )}
      </header>

      {!node ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <MousePointerClick className="size-6 text-line-strong" />
          <p className="text-[12.5px] font-medium text-ink-soft">还没有选中节点</p>
          <p className="text-[11.5px] leading-relaxed text-muted">
            单击画布上的卡片查看它的属性；双击打开窗体改配置，拖动节点保存摆位。
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <div className="pt-3">
              <div className="flex items-start justify-between gap-2">
                <h2 className="min-w-0 break-words text-[14.5px] font-semibold leading-snug text-ink">
                  {node.title}
                </h2>
                <Badge tone={TONE_BADGE[node.tone]} dot>
                  {node.status}
                </Badge>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-muted">
                {node.subtitle}
              </p>
            </div>

            {(node.issues.length > 0 || node.hints.length > 0) && (
              <div className="mt-3 space-y-1.5">
                {node.issues.map((text) => (
                  <p
                    key={text}
                    className="flex items-start gap-1.5 rounded-md bg-danger-soft px-2 py-1.5 text-[11.5px] leading-relaxed text-danger"
                  >
                    <TriangleAlert className="mt-px size-3 shrink-0" />
                    {text}
                  </p>
                ))}
                {node.hints.map((text) => (
                  <p
                    key={text}
                    className="rounded-md bg-warn-soft px-2 py-1.5 text-[11.5px] leading-relaxed text-warn"
                  >
                    {text}
                  </p>
                ))}
              </div>
            )}

            <Section title="节点">
              <Row label="标识" mono>
                {node.key}
              </Row>
              <Row label="节点 ID" mono>
                {node.id}
              </Row>
              <Row label="状态">{node.status}</Row>
              <Row label="上游 / 下游">
                {node.producers} / {node.consumers}
              </Row>
            </Section>

            {node.task && (
              <>
                <Section title="运行开关">
                  <div className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="text-[12px] text-ink">启用</p>
                      <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">
                        停用后事件落到下一个任务或死信
                      </p>
                    </div>
                    <Switch
                      checked={node.task.enabled}
                      busy={enabledBusy}
                      label={`${node.task.enabled ? "停用" : "启用"} ${node.title}`}
                      onChange={(next) => onToggleEnabled(node, next)}
                    />
                  </div>
                  <Row label="独占">
                    {node.task.spec.exclusive === false ? "否 · 命中后继续匹配" : "是 · 命中即止"}
                  </Row>
                  <Row label="主题" mono>
                    {node.task.topic || "—"}
                  </Row>
                  <Row label="优先级">{node.task.priority}</Row>
                  <Row label="版本">v{node.task.version}</Row>
                  <Row label="最后修改">{formatDateTime(node.task.update_ms)}</Row>
                </Section>

                <Section title="投递目标">
                  <Row label={node.task.spec.target.kind === "db" ? "直写库表" : "HTTP"}>
                    {targetSummary(node.task.spec)}
                  </Row>
                  <Row label="细节" mono>
                    {targetDetail(node.task.spec)}
                  </Row>
                </Section>

                <Section title="流水线六段 · 点某段直达窗体">
                  <div className="py-1.5">
                    {(node.segments ?? []).map((segment) => (
                      <button
                        key={segment.stage}
                        type="button"
                        onClick={() => onOpenStage(node, segment.stage)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent-soft"
                      >
                        <span className="shrink-0 text-[11.5px] text-ink-soft">{segment.label}</span>
                        <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">
                          {segment.detail}
                        </span>
                        {segment.issues > 0 && (
                          <span className="shrink-0 rounded bg-danger-soft px-1 text-[10px] text-danger">
                            {segment.issues} 处
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </Section>
              </>
            )}

            {node.source && (
              <Section title="取数配置">
                <Row label="启用">{node.source.enabled ? "是" : "否"}</Row>
                <Row label="方式">{node.source.kind}</Row>
                <Row label="主题" mono>
                  {node.source.topic || "—"}
                </Row>
                <Row label="数据源" mono>
                  {node.source.spec.datasource || "—"}
                </Row>
                <Row label="间隔">{node.source.interval_duration}</Row>
                <Row label="批量">{node.source.batch_size}</Row>
                <Row label="游标" mono>
                  {node.source.cursor?.position || "—"}
                </Row>
                <Row label="累计行数">{node.source.cursor?.rows_total ?? 0}</Row>
                <Row label="最近运行">
                  {node.source.last_run_ms ? formatDateTime(node.source.last_run_ms) : "还没跑过"}
                </Row>
                {node.source.last_error && (
                  <Row label="最近错误">{node.source.last_error}</Row>
                )}
              </Section>
            )}

            {node.datasource && (
              <Section title="连接">
                <Row label="编码" mono>
                  {node.datasource.code}
                </Row>
                <Row label="目标（脱敏）" mono>
                  {node.datasource.target || "—"}
                </Row>
                <Row label="启用">{node.datasource.enabled ? "是" : "否"}</Row>
                <Row label="最大连接数">{node.datasource.maxConnections}</Row>
                <Row label="引用来源数">{node.consumers}</Row>
                <Row label="版本">v{node.datasource.version}</Row>
                {node.datasource.remark && <Row label="备注">{node.datasource.remark}</Row>}
              </Section>
            )}

            {node.kind === "topic" && (
              <Section title="主题">
                <Row label="写入来源">{node.producers}</Row>
                <Row label="消费任务">{node.consumers}</Row>
                <p className="py-2 text-[11px] leading-relaxed text-muted">
                  主题不是库表实体，由来源写入、被任务消费。要改它请编辑两端的取数来源或任务。
                </p>
              </Section>
            )}
          </div>

          <footer className="shrink-0 border-t border-line bg-sunken/60 px-3 py-2.5">
            {node.kind === "topic" ? (
              <p className="text-center text-[11px] text-muted">虚拟节点，无可编辑的实体</p>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="w-full"
                icon={<Pencil className="size-3.5" />}
                onClick={() => onOpenEntity(node)}
              >
                编辑配置
              </Button>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
