import type { Plugin } from 'vite';

/** 把 Tailwind utilities 层限制在 root 选择器作用域内，避免多联邦应用同名类互相覆盖。 */
export declare function scopeUtilities(root: string): Plugin;
export declare function scopeUtilitiesInCss(
  css: string,
  root: string,
  label?: string,
): string | null;
