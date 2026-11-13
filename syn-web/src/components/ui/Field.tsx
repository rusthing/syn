import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

const BASE =
  "rounded-lg border border-line bg-surface px-2.5 text-[13.5px] text-ink placeholder:text-muted/70 " +
  "transition-shadow duration-150 hover:border-line-strong focus:border-accent/60 focus:outline-none " +
  "focus:ring-2 focus:ring-accent/12 disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted";

const CONTROL = `${BASE} w-full`;

/** 下拉箭头直接画在 select 的背景上：少一层 wrapper，宽度类才能老实生效 */
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%237b8175' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E\")";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, "py-2 leading-relaxed", className)} {...rest} />;
}

export function Select({ className, style, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(BASE, "h-9 shrink-0 appearance-none pr-8", className)}
      style={{
        backgroundImage: CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
        backgroundSize: "12px 12px",
        ...style,
      }}
      {...rest}
    >
      {children}
    </select>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  /** label 右侧的补充控件（如「插入模板」），放在 label 元素之外，避免误触焦点 */
  extra?: ReactNode;
}

export function Field({ label, hint, error, required, children, className, extra }: FieldProps) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] font-medium text-ink-soft">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </span>
        {extra}
      </div>
      <label className="block">{children}</label>
      {error ? (
        <span className="mt-1 block text-[11.5px] leading-snug text-danger">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[11.5px] leading-snug text-muted">{hint}</span>
      ) : null}
    </div>
  );
}
