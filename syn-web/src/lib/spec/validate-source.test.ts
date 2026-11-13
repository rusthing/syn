/**
 * 取数来源保存校验的用例。
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
    select: "select id, name, updated_at from public.person",
    cursor_column: "updated_at,id",
    cursor_type: "timestamp",
    wrap: "row",
  },
  remark: "",
});

const paths = (input: SourceSaveInput) => validateSource(input).map((i) => i.path);

describe("validateSource", () => {
  it("合法配置零问题", () => {
    expect(validateSource(valid())).toEqual([]);
  });

  it("空编码只报一条错，不把必填与格式错误叠加", () => {
    const issues = validateSource({ ...valid(), code: "" });
    expect(issues.filter((i) => i.path === "code")).toHaveLength(1);
  });

  it("缺数据源 / 缺 SQL / 缺游标列各自定位到 spec 字段", () => {
    const input = valid();
    input.spec = { cursor_type: "timestamp", wrap: "row" };
    expect(paths(input)).toEqual(
      expect.arrayContaining(["spec.datasource", "spec.select", "spec.cursor_column"]),
    );
  });

  it("http 来源不要求数据源：分页取数没有 datasource 的概念", () => {
    const input = valid();
    input.kind = "http";
    input.spec = { url: "http://upstream/page?cursor={cursor}", page_size: 100, wrap: "row" };
    expect(validateSource(input)).toEqual([]);
  });

  it("select 只许单条 select/with；中间分号挡住", () => {
    const input = valid();
    input.spec.select = "select 1; select 2";
    expect(paths(input)).toContain("spec.select");
    input.spec.select = "delete from person";
    expect(paths(input)).toContain("spec.select");
    // 结尾分号是习惯写法，允许
    input.spec.select = "select 1;";
    expect(paths(input)).not.toContain("spec.select");
  });

  it("两列游标必须 timestamp；列名只允许小写下划线", () => {
    const input = valid();
    input.spec.cursor_type = "int";
    expect(paths(input)).toContain("spec.cursor_type");
    input.spec.cursor_type = "timestamp";
    input.spec.cursor_column = "UpdatedAt, id";
    expect(paths(input)).toContain("spec.cursor_column[0]");
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
      select: "select 1",
      cursor_column: "id",
    };
    const p = paths(input);
    expect(p).toContain("spec.datasource");
    expect(p).toContain("spec.select");
    expect(p).toContain("spec.cursor_column");
  });

  it("间隔 < 1s、批大小越界都要在保存前挡住", () => {
    expect(paths({ ...valid(), intervalDuration: "500ms" })).toContain("intervalDuration");
    expect(paths({ ...valid(), batchSize: 0 })).toContain("batchSize");
    expect(paths({ ...valid(), batchSize: 5001 })).toContain("batchSize");
  });
});
