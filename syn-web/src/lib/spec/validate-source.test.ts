/**
 * 数据抽取保存校验的用例。
 *
 * 这些断言的价值是「跟后端同源」：后端 `SourceSpec::validate` /
 * `SynSourceSaveDto` 的约束改了而这里没跟上，界面会让人保存一个后端必拒的
 * 配置（或反过来卡住一个合法配置）。新增规则时两边一起改，并在这里补一条。
 */

import { describe, expect, it } from "vitest";
import type { SourceSaveInput } from "@/lib/api/types";
import { validateSource } from "./validate-source";

const valid = (): SourceSaveInput => ({
  code: "adm_person",
  name: "人员表",
  kind: "sql",
  topic: "",
  enabled: true,
  intervalDuration: "60s",
  batchSize: 500,
  spec: {
    datasource: "adm",
    mode: "cursor",
    table: "public.person",
    cursor_field: "updated_at",
    cursor_type: "timestamptz",
    tie_field: "id",
    tie_type: "bigint",
    wrap: "row",
  },
  remark: "",
});

const paths = (input: SourceSaveInput) => validateSource(input).map((i) => i.path);

describe("validateSource", () => {
  it("合法配置零问题", () => {
    expect(validateSource(valid())).toEqual([]);
  });

  it("全量快照只要数据源 + 表名", () => {
    const input = valid();
    input.spec = { datasource: "adm", mode: "snapshot", table: "public.person", wrap: "row" };
    expect(validateSource(input)).toEqual([]);
  });

  it("空编码只报一条错，不把必填与格式错误叠加", () => {
    const issues = validateSource({ ...valid(), code: "" });
    expect(issues.filter((i) => i.path === "code")).toHaveLength(1);
  });

  it("缺数据源 / 表名 / 主游标 / 决胜字段各自定位到 spec 字段", () => {
    const input = valid();
    input.spec = { mode: "cursor", wrap: "row" };
    expect(paths(input)).toEqual(
      expect.arrayContaining(["spec.datasource", "spec.table", "spec.cursor_field", "spec.tie_field"]),
    );
  });

  it("表名只允许标识符，可用 schema.table", () => {
    const input = valid();
    input.spec.table = "person; drop table x";
    expect(paths(input)).toContain("spec.table");
    input.spec.table = "public.person";
    expect(paths(input)).not.toContain("spec.table");
  });

  it("表名与字段名允许大写：按源库里的真实名字填", () => {
    const input = valid();
    input.spec.table = "WS_DEVICE";
    input.spec.cursor_field = "UPDATE_TIME";
    input.spec.tie_field = "ID";
    expect(validateSource(input)).toEqual([]);

    // schema 段同样收大写
    input.spec.table = "CRM.WS_DEVICE";
    expect(validateSource(input)).toEqual([]);

    // 放松大小写不放宽字符集
    input.spec.table = '"WS_DEVICE"';
    expect(paths(input)).toContain("spec.table");
    input.spec.table = "WS_DEVICE";
    input.spec.cursor_field = "UPDATE TIME";
    expect(paths(input)).toContain("spec.cursor_field");
  });

  it("主游标与决胜字段不能相同，类型要符合各自可选集", () => {
    const input = valid();
    input.spec.tie_field = "updated_at";
    expect(paths(input)).toContain("spec.tie_field");
    input.spec.tie_field = "id";
    input.spec.cursor_type = "uuid" as "bigint";
    expect(paths(input)).toContain("spec.cursor_type");
    input.spec.cursor_type = "timestamptz";
    input.spec.tie_type = "timestamptz" as "bigint";
    expect(paths(input)).toContain("spec.tie_type");
  });

  it("手写 SQL 可以替代表名", () => {
    const input = valid();
    input.spec.table = undefined;
    input.spec.sql = "select id, updated_at from person where deleted = false;";
    expect(validateSource(input)).toEqual([]);
  });

  it("手写 SQL 必须非空且是单条 select / with", () => {
    const empty = valid();
    empty.spec.table = undefined;
    empty.spec.sql = "";
    expect(paths(empty)).toContain("spec.sql");

    const write = valid();
    write.spec.sql = "update person set deleted = true";
    expect(paths(write)).toContain("spec.sql");

    const multi = valid();
    multi.spec.sql = "select 1; drop table person";
    expect(paths(multi)).toContain("spec.sql");
  });

  it("http 数据抽取不要求数据源：分页取数没有 datasource 的概念", () => {
    const input = valid();
    input.kind = "http";
    input.spec = { url: "http://upstream/page?cursor={cursor}", page_size: 100, wrap: "row" };
    expect(validateSource(input)).toEqual([]);
  });

  it("http 全量：路径要以 $ 开头、方法只许 GET/POST", () => {
    const input = valid();
    input.kind = "http";
    input.spec = {
      url: "http://upstream/page?cursor={cursor}&size={size}",
      data_path: "data.list",
      next_path: "data.next",
      // 类型上只允许 GET/POST，这里模拟「从接口/旧数据里带进来的非法值」
      method: "PUT" as "GET",
    };
    const p = paths(input);
    expect(p).toContain("spec.data_path");
    expect(p).toContain("spec.next_path");
    expect(p).toContain("spec.method");

    input.spec.data_path = "$.data.list";
    input.spec.next_path = "$.data.next";
    input.spec.method = "POST";
    expect(validateSource(input)).toEqual([]);
  });

  it("http 源里残留 sql 字段要报冲突，不能静默忽略", () => {
    const input = valid();
    input.kind = "http";
    input.spec = {
      url: "http://upstream/page?cursor={cursor}",
      datasource: "adm",
      table: "person",
      cursor_field: "id",
    };
    const p = paths(input);
    expect(p).toContain("spec.datasource");
    expect(p).toContain("spec.table");
    expect(p).toContain("spec.cursor_field");
  });

  it("间隔 < 1s、批大小越界都要在保存前挡住", () => {
    expect(paths({ ...valid(), intervalDuration: "500ms" })).toContain("intervalDuration");
    expect(paths({ ...valid(), batchSize: 0 })).toContain("batchSize");
    expect(paths({ ...valid(), batchSize: 5001 })).toContain("batchSize");
  });
});
