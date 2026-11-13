import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/utils";

/**
 * 期望值输入框。
 *
 * 配置里的 value 是任意 JSON，但让人写 `"c"`（带引号）太难受。规则：
 * - 能按 JSON 解析就用解析结果（`["c","u"]`、`1`、`true`）；
 * - 解析不了就当字符串（`c`、`2026-11-12`）。
 * 反过来显示时，字符串直接出原文，其余 `JSON.stringify` —— 这样「看什么改什么」
 * 能原样存回去。需要保留前导零之类的字符串值时加引号即可。
 */

export function displayValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function parseLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

export function ValueInput({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
  className,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState(() => displayValue(value));
  const focused = useRef(false);

  /**
   * 外部改了值（切换选中的规则、撤销等）要跟着变。
   * 输入过程中不回写：`[1,2` 这种半截 JSON 会被格式化掉，光标直接乱跳。
   */
  useEffect(() => {
    if (focused.current) return;
    const next = displayValue(value);
    setText((current) => (current === next ? current : next));
  }, [value]);

  return (
    <Input
      value={text}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      className={cn("h-8 font-mono text-[11.5px]", className)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(displayValue(value));
      }}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseLoose(event.target.value));
      }}
    />
  );
}
