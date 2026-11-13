import { useEffect } from "react";

/**
 * 弹层打开时锁住 body 滚动。
 *
 * 用引用计数而不是「记住上一层的值再还原」：抽屉和确认框可能同时打开，各自记住一份
 * 会在内层卸载时把 `overflow` 提前还原，外层还开着页面却已经能滚。
 *
 * 滚动条消失引起的布局位移由 `html { scrollbar-gutter: stable }`（styles.css）兜住，
 * 所以这里不必再补 padding。
 */
let lockCount = 0;
let previousOverflow = "";

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    if (lockCount === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = previousOverflow;
    };
  }, [locked]);
}
