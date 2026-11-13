import { useState } from "react";
import { Fingerprint, Search } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Panel, PanelState, Skeleton } from "@/components/ui/Panel";
import { PageHeader } from "@/components/page";
import { EmptyRow, TableShell, Td, Th } from "@/components/table";
import { formatCompact, formatRelative } from "@/lib/time";
import { useIdem } from "@/hooks/use-idem";
import { useDebounced } from "@/hooks/use-debounce";
import { VerdictBadge } from "@/components/spec/badges";
import { cn } from "@/lib/utils";

/**
 * 幂等台账。
 *
 * 键是 `(task_id, idem_key)`：同一个 key 在同一个任务下只成功一次，重复的记为
 * 「命中」。扇出时每个任务各记各的 —— 共用一个 key 空间会让「A 成功、B 失败」
 * 变成「B 被 A 挡掉」。
 */
export function IdemPage() {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebounced(keyword, 250);

  const { data, isLoading, error, refetch } = useIdem({
    keyword: debounced.trim() || undefined,
    pageNum: page,
    pageSize: 25,
  });

  const list = data?.list ?? [];
  const dup = list.filter((r) => r.hits > 1).length;

  return (
    <>
      <PageHeader
        title="幂等台账"
        subtitle="快照重放、5 秒重叠回读、人工重投都会送来同一份数据。键命中了就按已处理对待，不再写库、不再发下游。"
      />

      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={keyword}
              placeholder="幂等键 / 任务"
              className="h-8 w-[240px] pl-8 text-[12.5px]"
              onChange={(e) => {
                setKeyword(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <span className="ml-auto flex items-center gap-3 text-[11.5px] text-muted">
            <span>共 {data?.total ?? 0} 条</span>
            {dup > 0 && <span className="text-warn">本页重复命中 {dup} 条</span>}
          </span>
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
          <TableShell minWidth={820}>
            <thead>
              <tr>
                <Th className="w-[150px]">任务</Th>
                <Th>幂等键</Th>
                <Th align="center" className="w-[92px]">
                  命中次数
                </Th>
                <Th className="w-[84px]">最近结论</Th>
                <Th align="right" className="w-[132px]">
                  首次
                </Th>
                <Th align="right" className="w-[132px]">
                  最近
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <EmptyRow colSpan={6}>还没有幂等记录。台账在第一次成功投递后开始积累。</EmptyRow>}
              {list.map((record) => (
                <tr key={record.id} className="hover:bg-sunken/50">
                  <Td mono className="text-[11px]">
                    {record.task_code}
                  </Td>
                  <Td mono className="max-w-[380px] truncate text-[11px] text-ink-soft">
                    <span title={record.idem_key}>{record.idem_key}</span>
                  </Td>
                  <Td align="center">
                    <span
                      className={cn(
                        "tnum inline-flex min-w-6 items-center justify-center rounded px-1.5 font-mono text-[11px]",
                        record.hits > 1 ? "bg-warn-soft text-warn" : "bg-ink/[0.05] text-muted",
                      )}
                    >
                      {record.hits}
                    </span>
                  </Td>
                  <Td>
                    <VerdictBadge verdict={record.verdict} />
                  </Td>
                  <Td align="right" mono className="text-[10.5px] text-muted">
                    {formatCompact(record.first_ms)}
                  </Td>
                  <Td align="right" mono className="text-[10.5px] text-muted">
                    {formatRelative(record.last_ms)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Panel>

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
        <Fingerprint className="mt-0.5 size-4 shrink-0 text-muted" />
        <p className="text-[11.5px] leading-relaxed text-muted">
          键由执行器生成：<code className="font-mono">topic + 主键 + 版本号</code> 的摘要。同一条记录改报文重投不会命中
          —— 那是「新的处理」，不该被旧台账挡住。命中次数持续增长的键，通常在说明上游在反复重放。
        </p>
      </div>
    </>
  );
}
