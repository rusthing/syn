import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  push: (toast: Omit<ToastItem, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let seed = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      seed += 1;
      const id = seed;
      setItems((current) => [...current.slice(-3), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.tone === "error" ? 6_000 : 4_000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, description) => push({ tone: "success", title, description }),
      error: (title, description) => push({ tone: "error", title, description }),
      info: (title, description) => push({ tone: "info", title, description }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-relevant="additions"
          className="pointer-events-none fixed bottom-5 right-4 z-[80] flex w-[calc(100vw-2rem)] max-w-[340px] flex-col gap-2 sm:right-5"
        >
          {items.map((item) => (
            <div
              key={item.id}
              role={item.tone === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex animate-rise items-start gap-2.5 rounded-xl border bg-surface px-3 py-2.5 shadow-float",
                item.tone === "success" && "border-success/25",
                item.tone === "error" && "border-danger/25",
                item.tone === "info" && "border-line",
              )}
            >
              <span
                className={cn(
                  "mt-[1px]",
                  item.tone === "success" && "text-success",
                  item.tone === "error" && "text-danger",
                  item.tone === "info" && "text-info",
                )}
              >
                {item.tone === "success" ? (
                  <CheckCircle2 className="size-4" />
                ) : item.tone === "error" ? (
                  <AlertTriangle className="size-4" />
                ) : (
                  <Info className="size-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium leading-5 text-ink">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 break-words text-[11.5px] leading-snug text-muted">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(item.id)}
                className="-mr-1.5 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 必须在 ToastProvider 内使用");
  return context;
}
