import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "xs" | "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-white border border-accent-strong/20 shadow-[0_1px_0_rgb(255_255_255/0.12)_inset,0_1px_2px_rgb(12_74_60/0.28)] hover:bg-accent-strong",
  secondary:
    "bg-surface text-ink border border-line hover:border-line-strong hover:bg-sunken shadow-[0_1px_1px_rgb(25_27_22/0.03)]",
  ghost: "bg-transparent text-ink-soft border border-transparent hover:bg-ink/[0.05] hover:text-ink",
  danger: "bg-transparent text-danger border border-transparent hover:bg-danger-soft",
  subtle: "bg-accent-soft text-accent-strong border border-transparent hover:bg-[#d9ebe3]",
};

const SIZES: Record<Size, string> = {
  xs: "h-7 px-2 text-[12px] gap-1 rounded-md",
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-lg",
  md: "h-9 px-3.5 text-[13.5px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
      {iconRight}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: "default" | "danger";
  size?: "sm" | "md";
}

export function IconButton({
  label,
  tone = "default",
  size = "sm",
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex items-center justify-center rounded-md border border-transparent text-muted transition-colors",
        size === "sm" ? "size-7" : "size-8",
        tone === "danger"
          ? "hover:bg-danger-soft hover:text-danger"
          : "hover:bg-ink/[0.06] hover:text-ink",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
