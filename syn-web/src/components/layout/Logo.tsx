import { cn } from "@/lib/utils";

/**
 * 字标：左侧一个「进 / 出」两条箭头的方块，右边小写字标。
 * 图形直接画 SVG，不引图标库 —— 字标要能跟着文字基线和颜色走。
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("size-7", className)} aria-hidden>
      <rect x="0.5" y="0.5" width="27" height="27" rx="7" fill="#191b16" />
      <path
        d="M7 11.5h11l-3-3M21 16.5H10l3 3"
        fill="none"
        stroke="#6fd0ae"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Logo />
      <div className="leading-none">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[15px] font-semibold tracking-[0.02em] text-ink">syn</span>
          {!compact && (
            <span className="text-[11px] font-medium tracking-[0.06em] text-muted">同步控制台</span>
          )}
        </div>
      </div>
    </div>
  );
}
