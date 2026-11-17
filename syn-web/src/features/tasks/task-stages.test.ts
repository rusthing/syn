/**
 * 左侧六段轨道的元数据契约。
 *
 * 顺序和段名同时被控制面板卡片、属性栏六个直达入口和窗体右上的「n / 6」引用，
 * 改动一处漏了另一处不会报错，只会把人送到错的段。概要文字是纯逻辑，单测固定住。
 */
import { describe, expect, it } from "vitest";
import { newTask } from "@/lib/spec/defaults";
import {
  STAGES,
  stageExists,
  stageFilled,
  stageSummary,
  stagesFor,
  tabOfPath,
} from "./task-stages";

describe("段序", () => {
  it("投递在动作之前、判定在最后，JSON 是额外项且不占圈号", () => {
    expect(STAGES.map((s) => s.key)).toEqual([
      "match",
      "mapping",
      "guards",
      "target",
      "actions",
      "outcomes",
      "json",
    ]);
    expect(STAGES.map((s) => s.stage)).toEqual(["1", "2", "3", "4", "5", "6", "—"]);
  });

  it("db 直写没有动作段，圈号顺延不留空号", () => {
    const spec = newTask();
    spec.target = { kind: "db", service: "", base: "", datasource: "dtw", table: "public.region" };
    expect(stagesFor(spec).map((s) => s.key)).toEqual([
      "match",
      "mapping",
      "guards",
      "target",
      "outcomes",
      "json",
    ]);
    expect(stagesFor(spec).map((s) => s.stage)).toEqual(["1", "2", "3", "4", "5", "—"]);
    expect(stageExists(spec, "actions")).toBe(false);
    // http 任务照旧
    expect(stageExists(newTask(), "actions")).toBe(true);
  });
});

describe("tabOfPath", () => {
  it("按校验问题的路径前缀直达对应段", () => {
    expect(tabOfPath("mapping.rows[3].to")).toBe("mapping");
    expect(tabOfPath("match[0].value")).toBe("match");
    expect(tabOfPath("actions[1].path")).toBe("actions");
    expect(tabOfPath("guards[0].on_fail.code")).toBe("guards");
    expect(tabOfPath("outcomes[2].verdict")).toBe("outcomes");
    expect(tabOfPath("target.base")).toBe("target");
  });

  it("身份证区的问题和未知路径落回第一段", () => {
    expect(tabOfPath("id")).toBe("match");
    expect(tabOfPath("topic")).toBe("match");
    expect(tabOfPath("something.else")).toBe("match");
  });
});

describe("stageSummary / stageFilled", () => {
  it("新建模板：五段已填、守卫留空是合法的不设闸", () => {
    const spec = newTask();
    expect(STAGES.filter((s) => s.key !== "json" && stageFilled(spec, s.key))).toHaveLength(5);
    expect(stageSummary(spec, "guards")).toBe("0 条守卫");
    expect(stageSummary(spec, "json")).toBe("整份 spec 原文");
  });

  it("http 与 db 两种投递方式看不同的服务标识", () => {
    const spec = newTask();
    expect(stageSummary(spec, "target")).toBe("http · dtw-rs-svr");
    spec.target = {
      kind: "db",
      service: "",
      base: "",
      datasource: "dtw",
      table: "public.region",
    };
    expect(stageSummary(spec, "target")).toBe("db · dtw");
    expect(stageFilled(spec, "target")).toBe(true);
  });

  it("空匹配写「全收」，行级 null 策略按行数计", () => {
    const spec = newTask();
    spec.match = [];
    expect(stageSummary(spec, "match")).toBe("全收 · 无条件");
    expect(stageSummary(spec, "mapping")).toBe("1 行 · null 省略");
    spec.mapping.rows[0]!.on_null = "keep";
    expect(stageSummary(spec, "mapping")).toBe("1 行 · 1 行 null 保留");
    expect(stageFilled(spec, "match")).toBe(false);
  });

  it("动作段列出已配的 op，未配时明说", () => {
    const spec = newTask();
    expect(stageSummary(spec, "actions")).toBe("c / r 已配");
    spec.actions = [];
    expect(stageSummary(spec, "actions")).toBe("未配置动作");
    expect(stageFilled(spec, "actions")).toBe(false);
  });
});
