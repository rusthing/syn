import { cn } from "@/lib/utils";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 真正不可操作（例如演示模式禁用某个动作）；请求进行中请用 `busy`，不要用这个 */
  disabled?: boolean;
  /**
   * 请求进行中：只给视觉/无障碍提示，**不禁用按钮**。
   *
   * 原生 `disabled` 的 button 连 `pointerdown` / `click` 都不派发。启停这类开关
   * 一旦在 mutate 前置灰，网络稍慢时用户会以为「点了没用」再点第二下；更糟的是
   * 请求失败/超时后如果置灰没解开，开关就永久点不动了。乐观更新已经能让每次
   * 点击立刻看到结果，请求期间保持可点、由最后一次点击决定终值才是对的。
   */
  busy?: boolean;
  label?: string;
  size?: "sm" | "md";
}

export function Switch({ checked, onChange, disabled, busy, label, size = "md" }: SwitchProps) {
  const track = size === "sm" ? "h-[18px] w-[32px]" : "h-5 w-9";
  const knob = size === "sm" ? "size-3.5" : "size-4";
  const shift = size === "sm" ? "translate-x-[14px]" : "translate-x-4";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        // after 伪元素把可点区域扩到约 44px，视觉尺寸不变
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 after:absolute after:-inset-2 after:content-['']",
        track,
        checked
          ? "border-accent-strong/30 bg-accent"
          : "border-line-strong/60 bg-[#e6e8e1] hover:bg-[#dde0d8]",
        busy && "ring-2 ring-accent/25",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "ml-[2px] rounded-full bg-white shadow-[0_1px_2px_rgb(25_27_22/0.25)] transition-transform duration-200",
          knob,
          checked ? shift : "translate-x-0",
        )}
      />
    </button>
  );
}

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  count?: number;
}

/**
 * 少量选项的选择控件（按钮组）。
 *
 * 与 dtw-web 的 `OptionButtons` 保持一致：2–5 个固定枚举用按钮组，不放下拉；
 * 选中项强调色描边 + 浅强调底，未选中为中性描边；容器 `radiogroup`，每项 `radio`。
 * 窄屏 `flex-wrap` 换行，按钮高度不低于 32px。
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel = "选项",
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** 保留旧调用点传参；两种尺寸统一按规范 32px 最小点击高度渲染。 */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-8 min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12.5px] transition-colors",
              "cursor-pointer",
              active
                ? "border-accent/40 bg-accent-soft font-medium text-accent"
                : "border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-sunken",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cn("tnum text-[10.5px]", active ? "text-accent/80" : "text-muted/80")}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
