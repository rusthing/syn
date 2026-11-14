import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  Bug,
  CheckCircle2,
  CircleSlash,
  FlaskConical,
  Play,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Field";
import { Panel, PanelHeader, PanelState } from "@/components/ui/Panel";
import { PageHeader } from "@/components/page";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import {
  deliver,
  isLiveMode,
  sampleRecords,
  type SyncReply,
  type SyncTask,
} from "@/lib/api";
import type { Verdict } from "@/lib/api/types";
import { useAllTasks } from "@/hooks/use-tasks";
import { preview, selectTasks, type PreviewResult, type StepResult } from "@/lib/spec/evaluate";
import { VerdictBadge } from "@/components/spec/badges";

const VERDICT_ICON: Record<Verdict, typeof CheckCircle2> = {
  success: CheckCircle2,
  skip: CircleSlash,
  fatal: XCircle,
  retriable: CircleSlash,
};

export function PlaygroundPage() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { data: tasks, isLoading } = useAllTasks();

  const topicParam = params.get("topic") ?? "";
  const taskParam = params.get("task") ?? "";

  const topics = useMemo(() => [...new Set((tasks ?? []).map((t) => t.topic))].sort(), [tasks]);
  const [topic, setTopic] = useState(topicParam || "");
  const [recordText, setRecordText] = useState("{}");
  const [result, setResult] = useState<{
    record: unknown;
    chosen: SyncTask[];
    previews: PreviewResult[];
  } | null>(null);
  const [liveReply, setLiveReply] = useState<SyncReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delivering, setDelivering] = useState(false);

  // topic 由列表/编辑窗体带过来时，把样例报文一起填好：空着让人自己编一份太不友好
  useEffect(() => {
    if (!topic && topics.length > 0) setTopic(topics[0]);
  }, [topics, topic]);

  useEffect(() => {
    if (!topic) return;
    const samples = sampleRecords[topic];
    if (samples?.length) {
      setRecordText(JSON.stringify(samples[0].record, null, 2));
      setResult(null);
      setLiveReply(null);
      setError(null);
    }
  }, [topic]);

  const topicTasks = useMemo(() => (tasks ?? []).filter((t) => t.topic === topic), [tasks, topic]);

  const run = () => {
    setError(null);
    setLiveReply(null);
    let record: unknown;
    try {
      record = JSON.parse(recordText);
    } catch (err) {
      setError(err instanceof Error ? `报文不是合法 JSON：${err.message}` : "报文不是合法 JSON");
      setResult(null);
      return;
    }
    // 先按线上规则选出「谁会接这条记录」，再逐个预演：扇出判断必须和线上一致
    const specs = topicTasks.map((t) => ({ ...t.spec, id: t.code }));
    const chosen = selectTasks(specs, record)
      .map((spec) => topicTasks.find((t) => t.code === spec.id))
      .filter((t): t is SyncTask => Boolean(t));

    const targets = taskParam ? chosen.filter((t) => t.code === taskParam) : chosen;
    const previews = (targets.length > 0 ? targets : taskParam ? topicTasks.filter((t) => t.code === taskParam) : []).map(
      (t) => preview({ ...t.spec, id: t.code }, record),
    );

    if (chosen.length === 0) {
      setError("没有任何任务命中这条记录：sink 会收到 skip（200），记录被正常提交但不会下发。");
    }

    setResult({ record, chosen, previews });
  };

  const sendReal = async () => {
    let record: unknown;
    try {
      record = JSON.parse(recordText);
    } catch {
      setError("报文不是合法 JSON，发不出去");
      return;
    }
    setDelivering(true);
    try {
      const reply = await deliver(topic, record);
      setLiveReply(reply);
      toast.info(`服务端结论：${reply.result}`, reply.detail ?? reply.code);
    } catch (err) {
      toast.error("投递失败", err instanceof Error ? err.message : String(err));
    } finally {
      setDelivering(false);
    }
  };

  const live = isLiveMode();

  return (
    <>
      <PageHeader
        title="试跑"
        subtitle="把一条记录丢进五段，看它会命中谁、映射成什么、发到哪个地址。左侧是预演（不碰下游），右侧可切到真实投递。"
        actions={
          <>
            <Select
              value={topic}
              aria-label="topic"
              className="h-8 w-[210px] font-mono text-[12px]"
              onChange={(e) => {
                setTopic(e.target.value);
                setParams((prev) => {
                  prev.set("topic", e.target.value);
                  prev.delete("task");
                  return prev;
                });
              }}
            >
              {topics.length === 0 && <option value="">（还没有任务）</option>}
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="size-3.5" />}
              onClick={run}
              disabled={!topic || isLoading}
            >
              本地预演
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* 左：输入 */}
        <div className="space-y-3">
          <Panel>
            <PanelHeader
              title="记录报文"
              subtitle="sink 送进来的那条 JSON：op + before/after"
              actions={
                <Badge tone="muted" mono>
                  {recordText.length} B
                </Badge>
              }
            />
            <div className="space-y-2 p-3">
              {sampleRecords[topic]?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {sampleRecords[topic].map((sample) => (
                    <button
                      key={sample.label}
                      type="button"
                      onClick={() => {
                        setRecordText(JSON.stringify(sample.record, null, 2));
                        setResult(null);
                        setLiveReply(null);
                        setError(null);
                      }}
                      className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-soft transition-colors hover:border-line-strong hover:bg-sunken"
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <textarea
                value={recordText}
                spellCheck={false}
                onChange={(e) => setRecordText(e.target.value)}
                rows={20}
                className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/12"
              />

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  {topicTasks.length} 个任务匹配该 topic
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Send className="size-3.5" />}
                    loading={delivering}
                    disabled={!live}
                    title={live ? "真的调到 /syn/sync/{topic}，会写下游" : "演示模式下不发送真实请求"}
                    onClick={() => void sendReal()}
                  >
                    真实投递
                  </Button>
                </div>
              </div>
              {!live && (
                <p className="rounded-md bg-warn-soft/70 px-2 py-1.5 text-[10.5px] leading-snug text-warn">
                  当前是演示模式：预演在浏览器里跑同一套规则，「真实投递」需要切到实时接口。
                </p>
              )}
            </div>
          </Panel>

          {result && (
            <Panel>
              <PanelHeader title="谁会接走" subtitle="按 priority 升序，命中即停；独占=否则继续" />
              <ol className="divide-y divide-line/70">
                {topicTasks
                  .slice()
                  .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code))
                  .map((task) => {
                    const hit = result.chosen.some((t) => t.code === task.code);
                    return (
                      <li key={task.code} className="flex items-center gap-2 px-3 py-2">
                        <span className="tnum w-8 shrink-0 font-mono text-[10.5px] text-muted">
                          {task.priority}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[12px]",
                            hit ? "font-medium text-ink" : "text-muted",
                          )}
                        >
                          {task.code}
                        </span>
                        {task.spec.exclusive === false && <Badge tone="violet">非独占</Badge>}
                        {hit ? (
                          <Badge tone="accent" dot>
                            命中
                          </Badge>
                        ) : (
                          <Badge tone="muted">跳过</Badge>
                        )}
                      </li>
                    );
                  })}
              </ol>
            </Panel>
          )}
        </div>

        {/* 右：结果 */}
        <div className="space-y-3">
          {error && (
            <Panel className="border-warn/40">
              <div className="flex items-start gap-2 px-3 py-2.5 text-[12px] leading-relaxed text-warn">
                <Bug className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            </Panel>
          )}

          {liveReply && (
            <Panel className="border-accent/30">
              <PanelHeader
                title="服务端结论"
                subtitle={`POST /syn/sync/${topic}`}
                actions={<VerdictBadge verdict={liveReply.result} dot />}
              />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2.5 text-[12px]">
                <Row label="分类码" value={liveReply.code} mono />
                <Row label="任务" value={liveReply.task ?? "—"} mono />
                <Row label="得出结论的段" value={liveReply.stage} mono />
                <Row label="detail" value={liveReply.detail ?? "—"} />
              </dl>
            </Panel>
          )}

          {!result && !error && (
            <Panel>
              <PanelState
                icon={<FlaskConical className="size-4" />}
                title="还没有跑过"
                description="选一条样例报文，点右上角「本地预演」。预演在浏览器里执行与 syn-core 同构的五段逻辑，不发请求。"
                action={
                  <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" />} onClick={run}>
                    跑一次
                  </Button>
                }
              />
            </Panel>
          )}

          {result?.previews.map((item) => {
            const task = topicTasks.find((t) => t.code === item.task);
            const Icon = VERDICT_ICON[item.verdict];
            return (
              <Panel key={item.task}>
                <PanelHeader
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px]">{item.task}</span>
                      {task && <span className="text-[11.5px] font-normal text-muted">{task.name}</span>}
                    </span>
                  }
                  subtitle={`op=${item.op ?? "?"} · 目标 ${task?.spec.target.service ?? "?"}${task?.spec.target.base ?? ""}`}
                  icon={<Icon className="size-4 text-muted" />}
                  actions={
                    <>
                      {item.judgement && <Badge tone={item.judgement.fallback ? "danger" : "muted"}>规则 #{item.judgement.index}</Badge>}
                      {item.code === "preview_only" ? (
                        <Badge tone="muted" dot>
                          待投递
                        </Badge>
                      ) : (
                        <VerdictBadge verdict={item.verdict} />
                      )}
                    </>
                  }
                />

                <div className="space-y-3 p-3">
                  <ol className="space-y-1.5">
                    {item.steps.map((step, i) => (
                      <StepRow key={`${step.stage}-${i}`} step={step} />
                    ))}
                  </ol>

                  {item.body && (
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-muted">映射结果（请求体）</p>
                      <pre className="max-h-[260px] overflow-auto rounded-lg border border-line bg-sunken/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-soft">
                        {JSON.stringify(item.body, null, 2)}
                      </pre>
                    </div>
                  )}

                  {item.request && (
                    <div>
                      <p className="mb-1 text-[11px] font-medium text-muted">将要发出的请求</p>
                      <div className="overflow-hidden rounded-lg border border-line bg-sunken/60">
                        <div className="flex items-center gap-2 border-b border-line/70 px-2.5 py-1.5 font-mono text-[11.5px]">
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-strong">
                            {item.request.method}
                          </span>
                          <span className="min-w-0 truncate text-ink-soft">{item.request.url}</span>
                        </div>
                        {item.request.headers.length > 0 && (
                          <div className="border-b border-line/70 px-2.5 py-1.5">
                            {item.request.headers.map(([k, v]) => (
                              <div key={k} className="font-mono text-[10.5px] text-muted">
                                {k}: <span className="text-ink-soft">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {item.request.body !== undefined && (
                          <pre className="max-h-[200px] overflow-auto px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-soft">
                            {JSON.stringify(item.request.body, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  )}

                  <p className="text-[10.5px] leading-relaxed text-muted">
                    预演停在「待投递」：响应判定依赖下游真实返回，本地给不出结论。
                    勾上方「真实投递」可让服务端跑完整链路并返回判定。
                  </p>
                </div>
              </Panel>
            );
          })}
        </div>
      </div>
    </>
  );
}

function StepRow({ step }: { step: StepResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(step.asserts?.length || step.rows?.length);
  return (
    <li className="rounded-lg border border-line/80 bg-surface">
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
          hasDetail && "hover:bg-sunken/60",
        )}
      >
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full text-[9px]",
            step.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
          )}
        >
          {step.ok ? "✓" : "✕"}
        </span>
        <span className="text-[12px] font-medium text-ink">{step.title}</span>
        {step.detail && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{step.detail}</span>
        )}
        {hasDetail && <ArrowRight className={cn("ml-auto size-3 shrink-0 text-muted transition-transform", open && "rotate-90")} />}
      </button>

      {open && (
        <div className="border-t border-line/70 px-2.5 py-2">
          {step.asserts && (
            <ul className="space-y-1">
              {step.asserts.map((a, i) => (
                <li key={i} className="flex items-start gap-1.5 font-mono text-[10.5px]">
                  <span className={a.ok ? "text-success" : "text-danger"}>{a.ok ? "✓" : "✕"}</span>
                  <span className="min-w-0 flex-1 break-all text-ink-soft">
                    {a.assert.field ?? "（状态码）"} {a.assert.op}{" "}
                    <span className="text-muted">{JSON.stringify(a.assert.value)}</span>
                  </span>
                  <span className="shrink-0 text-muted">= {JSON.stringify(a.lhs)}</span>
                </li>
              ))}
            </ul>
          )}
          {step.rows && (
            <ul className="space-y-1">
              {step.rows.map((r, i) => (
                <li key={i} className="flex items-start gap-1.5 font-mono text-[10.5px]">
                  <span className={r.ok ? "text-success" : "text-danger"}>{r.ok ? "·" : "✕"}</span>
                  <span className="w-[110px] shrink-0 truncate text-ink">{r.to}</span>
                  <span className="min-w-0 flex-1 break-all text-muted">{r.error ?? r.note}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-ink-soft">
                    {r.omitted ? "省略" : JSON.stringify(r.value)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] text-muted">{label}</dt>
      <dd className={cn("truncate text-ink-soft", mono && "font-mono text-[11.5px]")} title={value}>
        {value}
      </dd>
    </div>
  );
}
