import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[21px] font-semibold leading-tight tracking-[-0.015em] text-ink">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  suffix,
  icon,
  footer,
  accent,
  className,
}: {
  label: string;
  value: ReactNode;
  suffix?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  accent?: "default" | "success" | "warn" | "danger";
  className?: string;
}) {
  const valueTone = {
    default: "text-ink",
    success: "text-success",
    warn: "text-warn",
    danger: "text-danger",
  }[accent ?? "default"];

  return (
    <section
      className={cn(
        "flex flex-col justify-between rounded-[14px] border border-line bg-surface px-4 py-3.5 shadow-panel",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11.5px] font-medium tracking-[0.01em] text-muted">{label}</span>
        {icon && <span className="text-muted/70">{icon}</span>}
      </div>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className={cn("tnum text-[27px] font-semibold leading-none tracking-[-0.02em]", valueTone)}>
          {value}
        </span>
        {suffix && <span className="text-[11.5px] text-muted">{suffix}</span>}
      </div>

      {footer && <div className="mt-3 text-[11px] text-muted">{footer}</div>}
    </section>
  );
}
