/**
 * 任务目标校验的用例（与后端 `TaskSpec::validate` 同源）。
 *
 * 目标库的表名 / 冲突键跟着目标库走：别的系统建的表常是 `WS_PERSON` / `ID`
 * 这种全大写名字，写库时按方言包引号、大小写原样保留，所以校验必须放行。
 */

import { describe, expect, it } from "vitest";
import type { TaskSpec } from "@/lib/api/types";
import { validateSpec } from "./validate";

/** db 直写的最小配置：动作段必须为空，判定只读 $.affected */
const dbSpec = (table: string, key: string[]): TaskSpec => ({
  topic: "tp",
  sort_order: 1,
  target: { kind: "db", datasource: "dtw", table, key, on_conflict: "update" } as TaskSpec["target"],
  mapping: { rows: key.map((k) => ({ to: k, from: `$.${k.toLowerCase()}` })) },
  actions: [],
  outcomes: [
    { scope: "body", assert: [{ field: "$.affected", op: "gte", value: 1 }], verdict: "success" },
  ],
});

const targetIssues = (spec: TaskSpec) => validateSpec(spec).filter((i) => i.path.startsWith("target"));

describe("目标表与冲突键", () => {
  it("小写表名与键列照旧通过", () => {
    expect(targetIssues(dbSpec("public.dtw_person", ["id"]))).toEqual([]);
  });

  it("大写表名与键列同样通过：按目标库里的真实名字填", () => {
    expect(targetIssues(dbSpec("CRM.WS_PERSON", ["ID", "TENANT_ID"]))).toEqual([]);
  });

  it("放松大小写不放宽字符集", () => {
    const issues = targetIssues(dbSpec("WS_PERSON; drop table x", ["ID"]));
    expect(issues.map((i) => i.path)).toContain("target.table");
    expect(validateSpec(dbSpec("WS_PERSON", ['"ID"'])).some((i) => i.path === "target.key[0]")).toBe(true);
  });
});
