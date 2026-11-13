import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  className,
  children,
  as: Tag = "section",
}: {
  className?: string;
  children: ReactNode;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag
      className={cn(
        "rounded-[14px] border border-line bg-surface shadow-panel",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  subtitle,
  icon,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line/80 px-4 py-3",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-[1px] text-muted">{icon}</span>}
        <div className="min-w-0">
          <h2 className="truncate text-[13.5px] font-semibold tracking-[0.01em] text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate text-[11.5px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** 面板内的空态 / 错误态 / 加载态统一长相 */
export function PanelState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
      )}
    >
      {icon && (
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-sunken text-muted">
          {icon}
        </span>
      )}
      <p className="text-[13px] font-medium text-ink-soft">{title}</p>
      {description && (
        <p className="max-w-[320px] text-[12px] leading-relaxed text-muted">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-[#eceee7]", className)}
      aria-hidden
    />
  );
}
