/**
 * 由抽取定义生成「取数 SQL」预览。
 *
 * 真正执行时 SQL 由后端 `poll.rs` 按同一模板拼（表名/字段名白名单校验、值绑参数），
 * 这里只用于界面展示，让人确认「我填的字段会变成什么查询」。两边改模板要一起改。
 *
 * 手写 SQL 会作为子查询嵌进来：外层仍要加游标条件、排序与 LIMIT，所以预览显示的是
 * 最终执行的形态，而不是原样贴出用户那段。
 */

import type { SourceSpec } from "@/lib/api/types";

const CAST: Record<string, string> = {
  bigint: "int8",
  timestamptz: "timestamptz",
  uuid: "uuid",
  varchar: "text",
};

export function buildSourceSql(spec: SourceSpec, batchSize: number): string {
  const table = tableRef((spec.table ?? "").trim() || "your_table");
  const isCustom = spec.sql !== undefined;
  const custom = (spec.sql ?? "").trim().replace(/;$/, "").trim() || "-- 在此写单条 select / with";

  if ((spec.mode ?? "cursor") === "snapshot") {
    if (!isCustom) {
      return spec.snapshot_batched
        ? `SELECT *\nFROM ${table}\nLIMIT ${batchSize}\nOFFSET 0    -- 每批 +${batchSize}，拉完为止`
        : `SELECT *\nFROM ${table}`;
    }
    const lines = ["SELECT *", "FROM (", indent(custom), ") s"];
    if (spec.snapshot_batched) {
      lines.push(`LIMIT ${batchSize}`, `OFFSET 0    -- 每批 +${batchSize}，拉完为止`);
    }
    return lines.join("\n");
  }

  const cursor = (spec.cursor_field ?? "").trim() || "cursor_field";
  const tie = (spec.tie_field ?? "").trim() || "tie_field";
  const cursorType = spec.cursor_type ?? "bigint";
  const cursorCast = CAST[cursorType] ?? "int8";
  const tieCast = CAST[spec.tie_type ?? "bigint"] ?? "int8";

  const c = isCustom ? `s."${cursor}"` : quoteIdent(cursor);
  const t = isCustom ? `s."${tie}"` : quoteIdent(tie);
  const lines = isCustom
    ? [
        `SELECT to_jsonb(s) AS row, ${c}::text AS k0, ${t}::text AS k1`,
        "FROM (",
        indent(custom),
        ") s",
      ]
    : ["SELECT *", `FROM ${table}`];

  lines.push(`WHERE (${c}, ${t}) > ($1::${cursorCast}, $2::${tieCast})`);
  if (cursorType === "timestamptz") {
    lines.push(`  AND ${c} <= now() - interval '5 seconds'    -- 避开未提交事务`);
  }
  lines.push(`ORDER BY ${c} ASC, ${t} ASC`, `LIMIT ${batchSize}`);
  return lines.join("\n");
}

function indent(sql: string): string {
  return sql
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * 源库标识符带大写的要加引号显示。
 *
 * 后端拼 SQL 时一律按方言包引号（PG/SQLite 是 `"x"`，MySQL 是 `` `x` ``），大小写原样
 * 保留；这里若照裸名显示，``FROM WS_DEVICE`` 看上去像是会被源库折叠成小写，与实际
 * 执行的语句不是一回事。小写标识符在两种库里加不加引号等价，就不加，免得预览变吵。
 */
function quoteIdent(name: string): string {
  return /[A-Z]/.test(name) ? `"${name}"` : name;
}

/** `schema.table` 两段分别按需加引号 */
function tableRef(table: string): string {
  return table.split(".").map(quoteIdent).join(".");
}
