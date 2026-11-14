/**
 * # 带候选清单的输入框（自绘下拉，不用原生 datalist）
 *
 * 为什么不用 `<datalist>`：它的弹出层是浏览器原生控件，显示什么由浏览器决定
 * （Chrome 显示 option 的文本、Firefox 显示 value），样式不可控、层级不受 z-index
 * 约束，且点输入框不一定会展开。候选只有几十条时，自绘一个可筛、可滚、可点的
 * 列表反而更省事，也能在 DOM 里断言。
 *
 * 语义仍然是「输入框」：值可以完全手输。候选只是辅助，所以
 * - 输入内容一律原样回传给 `onChange`（手输的、不在清单里的名字照样能存）；
 * - 点候选等于把该值填进去；
 * - 失焦 / Escape / 选中后收起。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";

export interface SuggestOption {
  /** 选中后填进输入框的值 */
  value: string;
  /** 列表里右侧的补充说明，例如数据源名称 */
  hint?: string;
}

interface SuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  options: SuggestOption[];
  placeholder?: string;
  /** 展开时列表底部的统计文案；空清单时换成 emptyText */
  countText?: (n: number) => string;
  emptyText?: string;
  className?: string;
  inputId?: string;
}

/** 大小写无关的子串匹配：候选多的时候用户是「记得半截名字」，不是背全名 */
function match(value: string, query: string): boolean {
  if (!query) return true;
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

export function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  countText,
  emptyText = "没有候选项",
  className,
  inputId,
}: SuggestInputProps) {
  const [open, setOpen] = useState(false);
  /** 选中候选后紧接着会触发一次 click/focus，用它把「刚选完」的那一下挡掉，避免面板又弹出来 */
  const pickedAt = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const requestOpen = () => {
    if (Date.now() - pickedAt.current < 250) return;
    setOpen(true);
  };

  const matched = useMemo(() => options.filter((o) => match(o.value, value)), [options, value]);

  // 点面板外面收起：光靠 blur 不够，输入框同级的按钮/页签也会夺焦点
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const show = open && options.length > 0;

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={inputId}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        className={cn("h-9 font-mono text-[12.5px]", className)}
        autoComplete="off"
        onFocus={requestOpen}
        onClick={requestOpen}
        onChange={(e) => {
          onChange(e.target.value);
          requestOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {show && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <ul className="max-h-64 overflow-auto py-1" role="listbox">
            {matched.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left font-mono text-[12.5px] hover:bg-sunken",
                    o.value === value ? "bg-sunken/70 text-accent" : "text-ink",
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    pickedAt.current = Date.now();
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{o.value}</span>
                  {o.hint && <span className="shrink-0 text-[11px] text-muted">{o.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-2.5 py-1 text-[11px] text-muted">
            {matched.length === 0 ? "没有匹配的候选，可直接手输" : (countText?.(matched.length) ?? `共 ${matched.length} 个候选`)}
          </div>
        </div>
      )}
      {/* 手输名字、候选为空都要能存，所以这里只提示，不拦提交 */}
      {!show && emptyText && options.length === 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted">{emptyText}</p>
      )}
    </div>
  );
}
