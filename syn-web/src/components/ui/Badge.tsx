import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "accent" | "success" | "danger" | "warn" | "info" | "violet" | "muted";

const TONES: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent-strong border-accent/15",
  success: "bg-success-soft text-success border-success/15",
  danger: "bg-danger-soft text-danger border-danger/15",
  warn: "bg-warn-soft text-warn border-warn/15",
  info: "bg-info-soft text-info border-info/15",
  violet: "bg-violet-soft text-violet border-violet/15",
  muted: "bg-ink/[0.045] text-ink-soft border-line",
};

const DOTS: Record<Tone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  warn: "bg-warn",
  info: "bg-info",
  violet: "bg-violet",
  muted: "bg-muted",
};

export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  pulse?: boolean;
  mono?: boolean;
}

export function Badge({ tone = "muted", children, className, dot, pulse, mono }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-[1px] text-[11.5px] font-medium leading-[18px]",
        mono && "font-mono text-[11px]",
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span className="relative inline-flex size-1.5">
          <span className={cn("size-1.5 rounded-full", DOTS[tone], pulse && "live-dot relative")} />
        </span>
      )}
      {children}
    </span>
  );
}
