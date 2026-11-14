/**
 * 变换注册表（与 `syn-core/src/transform.rs`、`wkb.rs` 同构）。
 *
 * 前端这份是**试跑用的预演**：同一份配置要能在这里先看到结果，再去改库。
 * 因此实现上不做「差不多就行」的近似 —— 一旦两边结果不一致，试跑就失去了意义。
 * 唯一有意保留的差异在数字打印（JS 的 `String(number)` 与 Rust 的 `{}`），两者
 * 都输出最短可回读形式，实测在经纬度量级一致。
 */

export const TRANSFORMS = [
  "trim",
  "strip_nul",
  "strip_suffix",
  "strip_prefix",
  "truncate",
  "to_bool_01",
  "wkb_to_wkt",
  "to_ms",
  "upper",
  "lower",
  "map_enum",
] as const;

export type TransformName = (typeof TRANSFORMS)[number];

/** 每个变换的说明与参数提示，编辑器直接读这张表，避免文案散落 */
export const TRANSFORM_DOCS: Record<TransformName, { label: string; args?: string; note: string }> = {
  trim: { label: "去首尾空白", note: "只对字符串生效，非字符串原样返回" },
  strip_nul: { label: "去空字符", note: "去掉 \\u0000，MySQL 变长字段的填充符" },
  strip_suffix: { label: "去后缀", args: '"电子围栏区"', note: "带了引号，后缀本身可以含空格" },
  strip_prefix: { label: "去前缀", args: '"BJ-"', note: "同上" },
  truncate: { label: "截断", args: "100", note: "按**字符**截，不是字节：中文名不会被截成乱码" },
  to_bool_01: { label: "转布尔", note: "1/0、true/false、t/f 都认；其它值报错" },
  wkb_to_wkt: { label: "WKB→WKT", note: "十六进制与 base64（Debezium bytea 默认编码）都认，支持 Point/Line/Polygon 及 Multi" },
  to_ms: { label: "补成毫秒", args: "", note: "小于 1e11 的按秒处理乘 1000，否则原样" },
  upper: { label: "转大写", note: "只对字符串生效" },
  lower: { label: "转小写", note: "只对字符串生效" },
  map_enum: { label: "枚举映射", args: "1=男,2=女", note: "未命中保持原值，不做二次猜测" },
};

export class TransformError extends Error {
  constructor(
    readonly transform: string,
    message: string,
  ) {
    super(message);
    this.name = "TransformError";
  }
}

function parseSpec(spec: string): { name: string; args: string[] } {
  const text = spec.trim();
  const open = text.indexOf("(");
  if (open >= 0 && text.endsWith(")")) {
    const name = text.slice(0, open).trim();
    const inner = text.slice(open + 1, -1);
    return { name, args: splitArgs(inner) };
  }
  return { name: text, args: [] };
}

/** 逗号分隔，但引号内的逗号不算分隔符 */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.length > 0);
}

function argText(args: string[], index: number, transform: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new TransformError(transform, `缺少第 ${index + 1} 个参数`);
  }
  return value;
}

function argNumber(args: string[], index: number, transform: string): number {
  const raw = argText(args, index, transform);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TransformError(transform, `参数 ${raw} 不是数字`);
  }
  return value;
}

function isScalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

export function applyTransform(value: unknown, spec: string): unknown {
  const { name, args } = parseSpec(spec);
  switch (name) {
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "strip_nul":
      return typeof value === "string" ? value.replace(/\u0000/g, "") : value;
    case "strip_suffix": {
      const suffix = argText(args, 0, name);
      if (typeof value !== "string") return value;
      return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
    }
    case "strip_prefix": {
      const prefix = argText(args, 0, name);
      if (typeof value !== "string") return value;
      return value.startsWith(prefix) ? value.slice(prefix.length) : value;
    }
    case "truncate": {
      const n = argNumber(args, 0, name);
      if (typeof value !== "string") return value;
      // 按码点截，不是按 UTF-16 单元：emoji 与中文都算一个字符
      return Array.from(value).slice(0, n).join("");
    }
    case "to_bool_01": {
      if (value === null || value === undefined) return null;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
        throw new TransformError(name, `${value} 不是 0/1`);
      }
      if (typeof value === "string") {
        const text = value.trim();
        if (["1", "true", "TRUE", "t"].includes(text)) return true;
        if (["0", "false", "FALSE", "f"].includes(text)) return false;
        throw new TransformError(name, `${text} 不是 0/1`);
      }
      throw new TransformError(name, `${JSON.stringify(value)} 不是 0/1`);
    }
    case "to_ms": {
      if (typeof value !== "number") throw new TransformError(name, "不是数字");
      // 秒级时间戳补成毫秒；已经是毫秒的不动，避免乘两次
      return value > 0 && value < 1e11 ? Math.trunc(value * 1000) : Math.trunc(value);
    }
    case "upper":
      return typeof value === "string" ? value.toUpperCase() : value;
    case "lower":
      return typeof value === "string" ? value.toLowerCase() : value;
    case "map_enum": {
      const src = isScalarText(value);
      for (const pair of args) {
        const at = pair.indexOf("=");
        if (at < 0) continue;
        if (pair.slice(0, at).trim() === src) return pair.slice(at + 1).trim();
      }
      return value;
    }
    case "wkb_to_wkt": {
      if (typeof value !== "string") throw new TransformError(name, "WKB 不是字符串");
      return wkbToWkt(value);
    }
    default:
      throw new TransformError(name, "未注册的变换");
  }
}

/* ------------------------------- WKB → WKT ------------------------------- */

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error("WKB 提前结束");
    return this.bytes[this.pos++];
  }

  u32(le: boolean): number {
    const slice = this.take(4);
    const view = new DataView(slice.buffer, slice.byteOffset, 4);
    return view.getUint32(0, le);
  }

  f64(le: boolean): number {
    const slice = this.take(8);
    const view = new DataView(slice.buffer, slice.byteOffset, 8);
    return view.getFloat64(0, le);
  }

  private take(n: number): Uint8Array {
    const end = this.pos + n;
    if (end > this.bytes.length) throw new Error("WKB 提前结束");
    const slice = this.bytes.subarray(this.pos, end);
    this.pos = end;
    return slice;
  }
}

const num = (v: number): string => String(v);

function decodeHex(text: string): Uint8Array | null {
  let hex = text.trim();
  if (hex.startsWith("\\x") || hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const hi = parseInt(hex[i], 16);
    const lo = parseInt(hex[i + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

function readGeometry(r: Reader, depth = 0): string {
  if (depth > 8) throw new Error("WKB 几何嵌套过深");
  const endian = r.u8();
  const le = endian === 1;
  if (!le && endian !== 0) throw new Error(`WKB 字节序非法: ${endian}`);

  const rawType = r.u32(le);
  const hasZ = (rawType & 0x80000000) !== 0;
  const hasM = (rawType & 0x40000000) !== 0;
  const hasSrid = (rawType & 0x20000000) !== 0;
  const ty = rawType & 0x0fffffff;
  // SRID 读出来就丢：下游的 WKT 不带 SRID，带上去反而可能被拒
  if (hasSrid) r.u32(le);

  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const suffix = hasZ ? " Z" : hasM ? " M" : "";

  const coord = (): string => {
    const parts: string[] = [];
    for (let d = 0; d < dims; d += 1) {
      const v = r.f64(le);
      if (!Number.isFinite(v)) throw new Error("WKB 坐标不是有限数");
      parts.push(num(v));
    }
    return parts.join(" ");
  };
  const seq = (): string => {
    const n = r.u32(le);
    const pts: string[] = [];
    for (let i = 0; i < n; i += 1) pts.push(coord());
    return `(${pts.join(", ")})`;
  };
  const rings = (): string => {
    const n = r.u32(le);
    const list: string[] = [];
    for (let i = 0; i < n; i += 1) list.push(seq());
    return ` (${list.join(", ")})`;
  };

  switch (ty) {
    case 1:
      return `POINT${suffix} (${coord()})`;
    case 2:
      return `LINESTRING${suffix} ${seq()}`;
    case 3:
      return `POLYGON${suffix}${rings()}`;
    case 4:
    case 5:
    case 6: {
      const name = ty === 4 ? "MULTIPOINT" : ty === 5 ? "MULTILINESTRING" : "MULTIPOLYGON";
      const n = r.u32(le);
      const items: string[] = [];
      for (let i = 0; i < n; i += 1) {
        // MULTIPOINT 里每个元素是完整 POINT，但 WKT 惯用不带关键字的裸坐标
        items.push(ty === 4 ? `(${coord()})` : readGeometry(r, depth + 1));
      }
      return `${name}${suffix} (${items.join(", ")})`;
    }
    case 7: {
      const n = r.u32(le);
      const items: string[] = [];
      for (let i = 0; i < n; i += 1) items.push(readGeometry(r, depth + 1));
      return `GEOMETRYCOLLECTION${suffix} (${items.join(", ")})`;
    }
    default:
      throw new Error(`不支持的 WKB 几何类型 ${ty}`);
  }
}

export function wkbToWkt(raw: string): string {
  // 十六进制优先；不是合法十六进制时按 base64 解（Debezium 对 bytea 列的默认编码），
  // 与 syn-core `wkb.rs` 的判定顺序保持同构
  const stripped = raw.trim().startsWith("\\x") || raw.trim().startsWith("0x")
    ? raw.trim().slice(2)
    : raw.trim();
  if (stripped.length === 0) throw new TransformError("wkb_to_wkt", "WKB 为空");
  let parsed: { bytes: Uint8Array; wkt: string } | null = null;
  try {
    const bytes = decodeHex(stripped);
    if (bytes && bytes.length > 0) parsed = { bytes, wkt: readAll(bytes) };
  } catch {
    parsed = null;
  }
  if (!parsed) {
    const bytes = decodeBase64(stripped);
    if (!bytes || bytes.length === 0) {
      throw new TransformError("wkb_to_wkt", "WKB 不是合法的十六进制或 base64");
    }
    parsed = { bytes, wkt: readAll(bytes) };
  }
  return parsed.wkt;
}

function readAll(bytes: Uint8Array): string {
  const reader = new Reader(bytes);
  const wkt = readGeometry(reader);
  if (reader.pos !== bytes.length) {
    // 多出来的字节说明读错了格式，宁可失败也不要发出半截几何
    throw new TransformError("wkb_to_wkt", `WKB 解析后剩余 ${bytes.length - reader.pos} 字节`);
  }
  return wkt;
}

const B64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64Val(c: string): number {
  const at = B64_TABLE.indexOf(c);
  if (at >= 0) return at;
  const atUrl = B64_URL_SAFE.indexOf(c);
  if (atUrl >= 0) return atUrl;
  return -1;
}

function decodeBase64(text: string): Uint8Array | null {
  const data: number[] = [];
  for (const c of text) {
    if (/[A-Za-z0-9+/_-]/.test(c)) data.push(b64Val(c));
  }
  if (data.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.slice(i, i + 4);
    let acc = 0;
    for (const v of chunk) acc = (acc << 6) | v;
    // 尾块不足 4 字符时补零对齐到 24 位，再按整块取字节
    acc <<= 6 * (4 - chunk.length);
    if (chunk.length === 4) out.push((acc >> 16) & 255, (acc >> 8) & 255, acc & 255);
    else if (chunk.length === 3) out.push((acc >> 16) & 255, (acc >> 8) & 255);
    else out.push((acc >> 16) & 255);
  }
  return new Uint8Array(out);
}
