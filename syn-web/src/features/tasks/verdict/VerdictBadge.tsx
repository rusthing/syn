/**
 * 结论徽标：判定段的四态语义色。
 *
 * 每种都有 1px 边框 —— soft 底对白底只有约 1.1:1，单靠底色分不出边界。
 * 颜色全部来自 styles.css 的令牌，这里只做组合，不新增 hex。
 */
import type { Verdict } from "@/lib/api/types";
import { verdictMeta } from "@/lib/spec/defaults";
import { cn } from "@/lib/utils";

const TONE: Record<"success" | "muted" | "danger" | "warn", string> = {
  success: "border-success/30 bg-success-soft text-success",
  danger: "border-danger/30 bg-danger-soft text-danger",
  warn: "border-warn/30 bg-warn-soft text-warn",
  muted: "border-line-strong bg-sunken text-ink-soft",
};

export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  const meta = verdictMeta(verdict);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-medium leading-none",
        TONE[meta.tone],
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
