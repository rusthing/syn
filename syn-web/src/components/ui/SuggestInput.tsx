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
 *
 * 展开与过滤是两件事：
 * - **展开时永远给全量候选**（并把当前值滚到可见处高亮）。字段里已有值很常见
 *   （编辑已有任务、或刚手输完想再确认还有哪些），此时若按当前值过滤，面板里就
 *   只剩自己那一行、底部写着「共 1 个候选」，看上去像清单没拉到。
 * - 只有用户**这一次真的打字**（onChange）才按输入内容过滤，底部改成
 *   「匹配 m / 共 n 个候选」，从数上就能看出清单本身是全的。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";

export interface SuggestOption {
  /** 选中后填进输入框的值 */
  value: string;
  /** 列表里右侧的补充说明，例如数据源名称、健康实例数 */
  hint?: string;
}

interface SuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  options: SuggestOption[];
  placeholder?: string;
  /** 计数里的量词，默认「候选」 */
  unit?: string;
  /** 候选清单底部的补充说明，接在「共 N 个候选」后面 */
  footNote?: string;
  /** 候选清单为空时的提示（手输照常能存，所以只提示不拦） */
  emptyText?: string;
  className?: string;
  inputId?: string;
}

/** 大小写无关的子串匹配：候选多的时候用户是「记得半截名字」，不是背全名 */
function match(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

export function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  unit = "候选",
  footNote,
  emptyText = "没有候选项",
  className,
  inputId,
}: SuggestInputProps) {
  const [open, setOpen] = useState(false);
  /** 本次展开期间用户打的字；null 表示「还没打字」，此时展示全量清单 */
  const [query, setQuery] = useState<string | null>(null);
  /** 选中候选后紧接着会触发一次 click/focus，用它把「刚选完」的那一下挡掉，避免面板又弹出来 */
  const pickedAt = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const pickedRef = useRef<HTMLButtonElement>(null);

  const openAll = () => {
    if (Date.now() - pickedAt.current < 250) return;
    setQuery(null);
    setOpen(true);
  };

  const matched = useMemo(
    () => (query === null ? options : options.filter((o) => match(o.value, query))),
    [options, query],
  );

  // 点面板外面收起：光靠 blur 不够，输入框同级的按钮/页签也会夺焦点
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 全量清单展开时，把当前值滚到可视区，省得用户在几十条里自己找
  useEffect(() => {
    if (open && query === null) pickedRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, query]);

  const show = open && options.length > 0;
  const filtered = query !== null && query.trim() !== "";

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={inputId}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        className={cn("h-9 font-mono text-[12.5px]", className)}
        autoComplete="off"
        onFocus={openAll}
        onClick={openAll}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
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
                  ref={o.value === value ? pickedRef : undefined}
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
            {matched.length === 0
              ? "没有匹配的候选，可直接手输"
              : `${filtered ? `匹配 ${matched.length} / 共 ${options.length} 个` : `共 ${options.length} 个`}${unit}${
                  filtered ? "" : (footNote ?? "")
                }`}
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
