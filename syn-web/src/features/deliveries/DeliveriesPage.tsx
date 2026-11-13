import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Panel, PanelState, Skeleton } from "@/components/ui/Panel";
import { PageHeader } from "@/components/page";
import { EmptyRow, TableFoot, TableShell, Td, Th } from "@/components/table";
import { cn } from "@/lib/utils";
import { formatCompact, formatDuration } from "@/lib/time";
import type { Verdict } from "@/lib/api/types";
import { useDeliveries } from "@/hooks/use-deliveries";
import { useAllTasks } from "@/hooks/use-tasks";
import { useDebounced } from "@/hooks/use-debounce";
import { StageBadge, VerdictBadge } from "@/components/spec/badges";

const VERDICT_FILTERS: Array<{ value: "" | Verdict; label: string }> = [
  { value: "", label: "全部" },
  { value: "fatal", label: "失败" },
  { value: "retriable", label: "重试" },
  { value: "skip", label: "跳过" },
  { value: "success", label: "成功" },
];

const PAGE_SIZE = 25;

export function DeliveriesPage() {
  const [taskCode, setTaskCode] = useState("");
  const [verdict, setVerdict] = useState<"" | Verdict>("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);

  const debounced = useDebounced(keyword, 250);
  const { data: tasks } = useAllTasks();

  const query = useMemo(
    () => ({
      task_code: taskCode || undefined,
      verdict: verdict || undefined,
      keyword: debounced.trim() || undefined,
      pageNum: page,
      pageSize: PAGE_SIZE,
    }),
    [taskCode, verdict, debounced, page],
  );

  const { data, isLoading, error, refetch, isFetching } = useDeliveries(query);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="投递记录"
        subtitle="每条记录一次结论。结论 → 状态码：成功/跳过 200、失败 400、重试 503 —— sink 只看状态码决定提交还是进死信。"
      />

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={keyword}
              placeholder="记录键 / 分类码"
              className="h-8 w-[210px] pl-8 text-[12.5px]"
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select
            value={taskCode}
            className="h-8 w-[190px] text-[12px]"
            onChange={(e) => {
              setTaskCode(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部任务</option>
            {(tasks ?? []).map((t) => (
              <option key={t.code} value={t.code}>
                {t.code}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-1">
            {VERDICT_FILTERS.map((item) => (
              <button
                key={item.value || "all"}
                type="button"
                onClick={() => {
                  setVerdict(item.value);
                  setPage(1);
                }}
                className={cn(
                  "h-8 rounded-md border px-2.5 text-[12px] transition-colors",
                  verdict === item.value
                    ? "border-accent/40 bg-accent-soft font-medium text-accent"
                    : "border-line bg-surface text-ink-soft hover:bg-sunken",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          {isFetching && <span className="text-[11px] text-muted">刷新中…</span>}
          <span className="ml-auto text-[11.5px] text-muted">共 {total} 条</span>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : error ? (
          <PanelState
            title="加载失败"
            description={(error as Error).message}
            action={
              <Button size="sm" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <TableShell minWidth={960}>
            <thead>
              <tr>
                <Th className="w-[108px]">时间</Th>
                <Th className="w-[132px]">任务</Th>
                <Th align="center" className="w-[46px]">
                  op
                </Th>
                <Th className="w-[84px]">结论</Th>
                <Th className="w-[150px]">分类码</Th>
                <Th className="w-[62px]">段</Th>
                <Th className="w-[210px]">记录键</Th>
                <Th align="right" className="w-[56px]">
                  HTTP
                </Th>
                <Th align="right" className="w-[76px]">
                  耗时
                </Th>
                <Th>详情</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.list ?? []).length === 0 && <EmptyRow colSpan={10}>没有符合条件的投递记录。</EmptyRow>}
              {(data?.list ?? []).map((d) => (
                <tr key={d.id} className="hover:bg-sunken/50">
                  <Td mono className="whitespace-nowrap text-[11px] text-muted">
                    {formatCompact(d.create_ms)}
                  </Td>
                  <Td mono className="text-[11px]">
                    {d.task_code}
                  </Td>
                  <Td align="center" mono className="text-[11px] uppercase text-muted">
                    {d.op ?? "—"}
                  </Td>
                  <Td>
                    <VerdictBadge verdict={d.verdict} dot />
                  </Td>
                  <Td mono className="text-[11px] text-ink-soft">
                    {d.code}
                  </Td>
                  <Td>
                    <StageBadge stage={d.stage} />
                  </Td>
                  <Td mono className="max-w-[210px] truncate text-[10.5px] text-muted" >
                    <span title={d.record_key}>{d.record_key}</span>
                  </Td>
                  <Td align="right" mono className="text-[11px] text-muted">
                    {d.http_status ?? "—"}
                  </Td>
                  <Td align="right" mono className="text-[11px] text-muted">
                    {formatDuration(d.latency_ms)}
                  </Td>
                  <Td className="max-w-[260px]">
                    <span className="block truncate text-[11px] text-muted" title={d.detail ?? ""}>
                      {d.detail ?? "—"}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <TableFoot colSpan={10}>
                <div className="flex items-center justify-between">
                  <span>
                    第 {page} / {pages} 页 · 每页 {PAGE_SIZE} 条
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<ChevronLeft className="size-3" />}
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      iconRight={<ChevronRight className="size-3" />}
                      disabled={page >= pages}
                      onClick={() => setPage((p) => Math.min(pages, p + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              </TableFoot>
            </tfoot>
          </TableShell>
        )}
      </Panel>

      <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted">
        「重试」不是执行器在重试：它把结论翻成 503 交还 sink，重试预算在 sink 的{" "}
        <code className="font-mono">http.retry.*</code> 里。执行器自己从不重试。
      </p>
    </>
  );
}
