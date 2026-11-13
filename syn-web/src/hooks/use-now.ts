import { useEffect, useState } from "react";

/**
 * 一个整秒跳动的 now。倒计时、相对时间都靠它，避免每个组件各自 setInterval。
 * 页面不可见时暂停，回到前台立刻对齐——后台标签页不该烧 CPU。
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;

    const tick = () => setNow(Date.now());

    const start = () => {
      window.clearInterval(timer);
      tick();
      timer = window.setInterval(tick, intervalMs);
    };

    const stop = () => window.clearInterval(timer);

    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
}
