/**
 * 取数 SQL 预览的用例。
 *
 * 后端拼 SQL 时按方言给标识符包引号，预览要跟着同形：源库表名/字段名带大写时
 * 裸名会被读成「源库会折叠成小写」，与实际执行的语句不是一回事。
 */

import { describe, expect, it } from "vitest";
import { buildSourceSql } from "./source-sql";

const spec = {
  datasource: "adm",
  mode: "cursor" as const,
  table: "dtw_polygon",
  cursor_field: "update_timestamp",
  cursor_type: "timestamptz" as const,
  tie_field: "id",
  tie_type: "bigint" as const,
  wrap: "row" as const,
};

describe("buildSourceSql", () => {
  it("小写标识符照裸名显示，预览不额外加引号", () => {
    expect(buildSourceSql(spec, 500)).toContain("FROM dtw_polygon");
    expect(buildSourceSql(spec, 500)).toContain("(update_timestamp, id) >");
  });

  it("大写标识符按后端形态加引号，大小写不会被折叠", () => {
    const upper = { ...spec, table: "CRM.WS_DEVICE", cursor_field: "UPDATE_TIME", tie_field: "ID" };
    const sql = buildSourceSql(upper, 500);
    expect(sql).toContain('FROM "CRM"."WS_DEVICE"');
    expect(sql).toContain('("UPDATE_TIME", "ID") >');
    expect(sql).toContain('ORDER BY "UPDATE_TIME" ASC, "ID" ASC');
  });
});
