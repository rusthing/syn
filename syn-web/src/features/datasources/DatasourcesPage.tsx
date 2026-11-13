/**
 * 数据源管理页：列出已配置的 DB 连接，支持新增 / 编辑 / 启停 / 删除。
 *
 * 连接串明文只在编辑抽屉的写入口出现，列表里永远只有脱敏后的 target —— 页面
 * 拿到的是适配层转好的 `DatasourceInfo`，不碰 wire 形状、也不碰 /syn/registry。
 */

import { useState } from "react";
import { DatabaseZap, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/Drawer";
import { Panel, PanelState, Skeleton } from "@/components/ui/Panel";
import { Switch } from "@/components/ui/Switch";
import { PageHeader, StatCard } from "@/components/page";
import { EmptyRow, TableShell, Td, Th } from "@/components/table";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/time";
import type { DatasourceInfo } from "@/lib/api/types";
import { useDatasourceMutations, useDatasources } from "@/hooks/use-sources";
import { DatasourceEditorDrawer } from "./DatasourceEditorDrawer";

export function DatasourcesPage() {
  const { data, isLoading, error, refetch } = useDatasources();
  const { setEnabled, remove } = useDatasourceMutations();
  const toast = useToast();
  /** null 数据源 = 新建；带实体 = 编辑 */
  const [editor, setEditor] = useState<{ open: boolean; datasource: DatasourceInfo | null }>({
    open: false,
    datasource: null,
  });
  const [removing, setRemoving] = useState<DatasourceInfo | null>(null);

  const list = data ?? [];
  const enabled = list.filter((d) => d.enabled).length;
  const connTotal = list.reduce((acc, d) => acc + d.maxConnections, 0);

  return (
    <>
      <PageHeader
        title="数据源"
        subtitle="已配置的 DB 连接。连接串（含账号密码）只在保存时提交，列表里只显示脱敏后的目标；取数来源与投递的 db 目标都按 code 引用这里。"
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setEditor({ open: true, datasource: null })}
          >
            新增数据源
          </Button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="数据源总数"
          value={list.length}
          suffix={`/ ${enabled} 启用`}
          icon={<DatabaseZap className="size-4" />}
          footer="取数来源与 db 投递都按 code 引用"
        />
        <StatCard
          label="启用中"
          value={enabled}
          suffix="个"
          accent="success"
          footer="停用后仍保留配置，不会被引用"
        />
        <StatCard
          label="连接池上限合计"
          value={connTotal}
          suffix="连接"
          footer="所有数据源 maxConnections 之和"
        />
      </div>

      <Panel>
        {isLoading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : error ? (
          <PanelState
            title="加载失败"
            description={(error as Error).message}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <TableShell minWidth={1040}>
            <thead>
              <tr>
                <Th className="w-[140px]">编码 code</Th>
                <Th className="w-[150px]">名称</Th>
                <Th className="w-[200px]">目标（脱敏）</Th>
                <Th align="right" className="w-[104px]">
                  连接池上限
                </Th>
                <Th align="center" className="w-[70px]">
                  启用
                </Th>
                <Th className="w-[180px]">备注</Th>
                <Th className="w-[110px]">更新时间</Th>
                <Th align="right" className="w-[96px]">
                  操作
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <EmptyRow colSpan={8}>还没有数据源。点右上角「新增数据源」建一个。</EmptyRow>
              )}
              {list.map((d) => (
                <tr
                  key={d.id}
                  className={cn(
                    "group transition-colors hover:bg-sunken/50",
                    !d.enabled && "opacity-60",
                  )}
                >
                  <Td mono className="text-[11px]">
                    {d.code}
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-ink">{d.name}</span>
                      <span className="shrink-0 rounded bg-ink/[0.05] px-1 font-mono text-[10px] text-muted">
                        v{d.version}
                      </span>
                    </span>
                  </Td>
                  <Td mono className="text-[11px]">
                    {d.target ?? <span className="text-muted">—</span>}
                  </Td>
                  <Td align="right" mono>
                    {d.maxConnections}
                  </Td>
                  <Td align="center">
                    <Switch
                      checked={d.enabled}
                      size="sm"
                      label={`${d.enabled ? "停用" : "启用"} ${d.name}`}
                      disabled={setEnabled.isPending}
                      onChange={(next) =>
                        setEnabled.mutate(
                          { id: d.id, enabled: next },
                          {
                            onSuccess: () =>
                              toast.success(
                                next ? "已启用" : "已停用",
                                `${d.code} · 引用它的配置需重新保存才生效`,
                              ),
                            onError: (e: Error) => toast.error("操作失败", e.message),
                          },
                        )
                      }
                    />
                  </Td>
                  <Td className="max-w-[180px] truncate text-[11.5px]">
                    {d.remark ?? <span className="text-muted">—</span>}
                  </Td>
                  <Td>
                    <span className="text-[11.5px] text-muted">
                      {d.update_ms ? formatRelative(d.update_ms) : "—"}
                    </span>
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-0.5">
                      <IconButton label="编辑数据源" onClick={() => setEditor({ open: true, datasource: d })}>
                        <Pencil className="size-3.5" />
                      </IconButton>
                      <IconButton label="删除数据源" tone="danger" onClick={() => setRemoving(d)}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Panel>

      <p className="mt-2 flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
        连接串含账号密码，服务端读接口一律返回脱敏后的
        <code className="font-mono"> target </code>（host:port/db），绝不回显明文；编辑时留空连接串即表示不修改。
      </p>

      <DatasourceEditorDrawer
        open={editor.open}
        datasource={editor.datasource}
        onClose={() => setEditor({ open: false, datasource: null })}
        onSaved={() => void refetch()}
      />

      <ConfirmDialog
        open={removing !== null}
        title={`删除数据源 ${removing?.code ?? ""}？`}
        description="连接配置会一起删掉。引用了它的取数来源 / 任务不会自动改，按 code 找不到连接会报错；只是想暂停就关掉「启用」。"
        confirmText="删除"
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success("数据源已删除", `${removing.code} 的连接配置已清除`);
              setRemoving(null);
            },
            onError: (e: Error) => toast.error("删除失败", e.message),
          });
        }}
      />
    </>
  );
}
