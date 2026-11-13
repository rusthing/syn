/**
 * JSONPath 的一个子集：`$.a.b`、`$.a[0].b`、`a.b`。
 *
 * 与 `syn-core/src/value.rs` 完全同构。刻意不支持通配与过滤表达式：配置里的路径
 * 必须一眼看出取的是哪个字段，能写过滤器就意味着能写逻辑，那就退化成脚本了。
 */

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

function parse(path: string): Segment[] | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const body = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;

  const segs: Segment[] = [];
  let key = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === ".") {
      if (key) {
        segs.push({ kind: "key", key });
        key = "";
      }
      i += 1;
    } else if (c === "[") {
      if (key) {
        segs.push({ kind: "key", key });
        key = "";
      }
      let digits = "";
      i += 1;
      while (i < body.length && body[i] !== "]") {
        digits += body[i];
        i += 1;
      }
      i += 1; // 跳过 ]
      const index = Number(digits);
      if (!Number.isInteger(index) || index < 0) return null;
      segs.push({ kind: "index", index });
    } else {
      key += c;
      i += 1;
    }
  }
  if (key) segs.push({ kind: "key", key });
  return segs;
}

/** 取不到返回 `undefined`，与「取到 null」区分开：exists / absent 依赖这个区别 */
export function getPath(root: unknown, path: string): unknown {
  const segs = parse(path);
  if (!segs) return undefined;
  let cur: unknown = root;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (seg.kind === "key") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.key];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
    }
  }
  return cur;
}

/**
 * 按点路径写入，`to: "addr.city"` 写成 `{"addr":{"city":…}}`。
 *
 * 中途遇到非对象（比如上一次写成了字符串）就整个替换成对象：下游要的是结构，
 * 不是「保留上一次的错值」。这与 Rust 侧的行为一致。
 */
export function insertPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".").filter(Boolean);
  if (segs.length === 0) return;
  if (segs.length === 1) {
    target[segs[0]] = value;
    return;
  }
  let node = target;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const seg = segs[i];
    const next = node[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      node[seg] = {};
    }
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1]] = value;
}

/** 值 → 拼 URL / 头用的标量文本 */
export function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
