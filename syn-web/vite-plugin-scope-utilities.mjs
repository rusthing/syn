/**
 * 把 Tailwind 的 utilities 层限制在联邦应用自己的根节点内。
 *
 * 背景：uiam 桌面把多个联邦应用的 CSS 注入同一文档，而每个 Tailwind v4 应用
 * 都会生成同名的原子类（.hidden / .flex / .md\:flex …）。级联时这些类同层、
 * 同特异性，最终「谁后注入谁生效」——adm 的 .hidden 会盖掉 dtw 侧栏的
 * .md\:flex，导致先开 dtw 再开 adm 后，dtw 侧栏消失。
 *
 * 做法：构建产物里找到 `@layer utilities{…}` 块，包一层
 * `@scope (<root>){ @layer utilities{…} }`。保留内层 @layer（theme/base 仍全局、
 * 层叠顺序不变），只给工具类加上作用域——其他应用的同名类再也命中不到本应用
 * 根节点之外的元素。作用域写入 @layer 内部，浏览器支持 @scope 即可（Chrome 118+ /
 * Safari 17.4+ / Firefox 128+，本项目 target es2022）。
 *
 * 独立站同样带 <root> 类（见各应用 main.tsx 给 #root 加的 class），因此独立入口
 * 的工具类依旧生效；一份 CSS 同时服务联邦与独立两种形态。
 *
 * @param {string} root 联邦入口根节点选择器，如 '.dtw-federated'
 */
export function scopeUtilities(root) {
  const marker = '@layer utilities{';
  return {
    name: 'scope-tailwind-utilities',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'asset' || !chunk.fileName.endsWith('.css')) continue;
        const css = typeof chunk.source === 'string' ? chunk.source : String(chunk.source);
        const out = scopeUtilitiesInCss(css, root, chunk.fileName);
        if (out !== null) chunk.source = out;
      }
    },
  };
}

/**
 * 对单个 CSS 产物做改写。可能有多处 `@layer utilities{…}`（Tailwind 折叠、按
 * 媒体查询拆块等），全部处理。用花括号计数找块尾，避免误伤内层 @media 的 }。
 * 返回 null 表示无需改动。
 */
export function scopeUtilitiesInCss(css, root, label = 'css') {
  let searchFrom = 0;
  let result = '';
  let changed = false;

  while (true) {
    const idx = css.indexOf('@layer utilities{', searchFrom);
    if (idx < 0) break;
    const bodyStart = idx + '@layer utilities{'.length;
    let depth = 1;
    let i = bodyStart;
    for (; i < css.length && depth > 0; i++) {
      const ch = css[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) break; // 括号不平衡：放弃这一处，不折腾产物

    const body = css.slice(bodyStart, i - 1);
    result += css.slice(searchFrom, idx);
    // 已是作用域内的块不重复包裹（幂等，便于反复构建）
    if (body.includes('@scope')) {
      result += css.slice(idx, i);
    } else {
      result += `@scope (${root}){@layer utilities{${body}}}`;
      changed = true;
    }
    searchFrom = i;
  }

  if (!changed) return null;
  result += css.slice(searchFrom);
  if (process.env.DEBUG_SCOPE_UTILITIES) {
    console.log(`[scope-utilities] 已作用域化 ${label} -> ${root}`);
  }
  return result;
}
