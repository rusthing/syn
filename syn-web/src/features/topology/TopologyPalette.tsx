/**
 * # 组件栏
 *
 * 参照 dbz 控制面板：画布左边一列可添加的组件，点一下就在本页开抽屉新建，
 * 不用先跑到数据源 / 取数来源 / 任务的维护页。保存成功后节点按默认位置上图
 * （坐标落在本类列的第一个空位，之后可拖）。
 *
 * 主题不放进来：它是虚拟节点，由取数来源写入、被任务消费，没有「新建」可言 ——
 * 但仍列出来置灰，告诉用户图里那列灰色药丸是什么。
 */

import { Database, Layers, MousePointerClick, Radio, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

/** 可新建的三类；颜色与卡片 tone 一致（info / violet / accent） */
const ADDABLE = [
  {
    kind: "datasource" as const,
    label: "数据源",
    icon: Database,
    accent: "text-info",
    hint: "连接配置：类型、连接串、账号。连接串脱敏存储，服务端不回显明文。",
  },
  {
    kind: "source" as const,
    label: "取数来源",
    icon: Radio,
    accent: "text-violet",
    hint: "从业务库周期取数的来源：选数据源、表与游标列。 CDC 源在取数来源页登记。",
  },
  {
    kind: "task" as const,
    label: "任务",
    icon: Workflow,
    accent: "text-accent",
    hint: "同步流水线：取数 → 校验 → 转换 → 判定 → 落库 → 投递，六段都在抽屉里配。",
  },
];

export type AddableKind = (typeof ADDABLE)[number]["kind"];

export function TopologyPalette({
  onAdd,
  className,
}: {
  onAdd: (kind: AddableKind) => void;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex w-[88px] shrink-0 flex-col gap-1.5 rounded-[14px] border border-line bg-surface p-2",
        className,
      )}
    >
      <p className="flex items-center gap-1 px-1 text-[10.5px] font-medium text-muted">
        <MousePointerClick className="size-3" />
        组件栏
      </p>
      {ADDABLE.map((item) => (
        <button
          key={item.kind}
          type="button"
          onClick={() => onAdd(item.kind)}
          title={item.hint}
          className="flex flex-col items-center gap-1 rounded-lg border border-line bg-canvas px-1 py-2.5 text-[11px] text-ink-soft transition hover:border-accent hover:bg-accent-soft hover:text-ink"
        >
          <item.icon className={cn("size-4", item.accent)} />
          {item.label}
        </button>
      ))}
      <button
        type="button"
        disabled
        title="主题是虚拟节点：由取数来源写入、被任务消费，图上自动生成，不需要手动添加"
        className="flex cursor-not-allowed flex-col items-center gap-1 rounded-lg border border-dashed border-line px-1 py-2.5 text-[11px] text-muted opacity-60"
      >
        <Layers className="size-4" />
        主题
      </button>
      <p className="mt-auto px-1 pt-1 text-[10px] leading-relaxed text-muted">
        点选新建，保存即上图
      </p>
    </aside>
  );
}
