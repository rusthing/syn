import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import { cn } from "@/lib/utils";
import { IconButton } from "./Button";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 弹层打开时把 Tab 圈在弹层内，关闭后把焦点还给触发元素。
 * 不这样做的话键盘用户会 Tab 到遮罩背后的页面，抽屉「看起来打开了」实际焦点已经跑走。
 */
function useDialogFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    const focusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];

    (focusables()[0] ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !node) return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open]);

  return ref;
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 右侧抽屉用固定宽度；居中窗体用最大宽度。默认 580 */
  width?: number;
  /** `right` = 右侧抽屉（默认），`center` = 居中弹出窗体 */
  placement?: "right" | "center";
  /** 标题区的额外内容（如状态徽标） */
  badge?: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 580,
  placement = "right",
  badge,
}: DrawerProps) {
  const centered = placement === "center";
  useBodyScrollLock(open);
  const dialogRef = useDialogFocus(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        centered ? "items-center justify-center p-5" : "justify-end",
      )}
    >
      {/*
        遮罩**不要**加 `backdrop-blur`：一层覆盖整个视口的 backdrop-filter 会让浏览器每帧
        重新模糊遮罩下的整页（实测抽屉内滚动 55fps → 30fps，Retina 上按物理像素再翻 4 倍）。
        纯半透明色同样能拉开层次，成本为零。
      */}
      <div className="absolute inset-0 animate-fade bg-ink/25" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex min-h-0 flex-col border-line bg-surface shadow-float focus:outline-none",
          centered
            ? "max-h-[calc(100vh-40px)] w-full animate-rise rounded-[14px] border"
            : "h-full max-w-full animate-slide-left border-l",
        )}
        style={centered ? { maxWidth: width } : { width }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
              {badge}
            </div>
            {subtitle && <div className="mt-1 text-[12px] text-muted">{subtitle}</div>}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="border-t border-line bg-sunken/70 px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 新增 / 编辑用的居中弹出窗体。
 *
 * 与 `Drawer` 共用遮罩、焦点圈定、ESC 与 body 滚动锁，只是位置和尺寸不同 ——
 * 复制一套弹层逻辑迟早会在焦点或 ESC 上出现两份不一致的行为。编辑页签多、
 * 表单宽，居中窗体比贴右抽屉更容易看清整行，也不会把画布完全盖住。
 */
export function Modal(props: Omit<DrawerProps, "placement">) {
  return <Drawer {...props} placement="center" />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  tone = "danger",
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useBodyScrollLock(open);
  const dialogRef = useDialogFocus(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
      <div className="absolute inset-0 animate-fade bg-ink/30" onClick={onCancel} aria-hidden />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative w-full max-w-[400px] animate-rise rounded-[14px] border border-line bg-surface p-5 shadow-float focus:outline-none"
      >
        <h2 className="text-[14.5px] font-semibold text-ink">{title}</h2>
        {description && (
          <div className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">{description}</div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-lg border border-line px-3 text-[13px] font-medium text-ink-soft hover:bg-sunken"
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className={cn(
              "h-9 rounded-lg px-3 text-[13px] font-medium text-white disabled:opacity-50",
              tone === "danger" ? "bg-danger hover:brightness-95" : "bg-accent hover:bg-accent-strong",
            )}
          >
            {loading ? "处理中…" : confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
