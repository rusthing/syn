import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 表格的长相统一放这里。
 *
 * 各页只关心「哪几列、怎么排」，不重复描边距、hover 和 sticky 首列 —— 这些东西
 * 一旦各写一份，改一次视觉要翻五个文件。
 */

export function TableShell({
  children,
  className,
  minWidth = 720,
}: {
  children: ReactNode;
  className?: string;
  minWidth?: number;
}) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[12.5px]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = "left",
  sticky,
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  sticky?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-line bg-sunken/60 px-3 py-2 text-[11px] font-medium tracking-[0.02em] text-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        sticky && "col-sticky",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = "left",
  mono,
  sticky,
}: {
  children?: ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  mono?: boolean;
  sticky?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-line/70 px-3 py-2 align-middle text-ink-soft",
        align === "right" && "text-right",
        align === "center" && "text-center",
        mono && "font-mono tnum text-[11.5px]",
        sticky && "col-sticky",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-12 text-center text-[12.5px] text-muted">
        {children}
      </td>
    </tr>
  );
}

export function TableFoot({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="border-t border-line bg-sunken/40 px-3 py-2 text-[11.5px] text-muted">
        {children}
      </td>
    </tr>
  );
}
