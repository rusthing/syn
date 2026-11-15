/**
 * 判定语义的共享用例，与 `syn-core/tests/verdict_cases.rs` 读同一个文件。
 *
 * 为什么不在各自包里抄一份：这两份求值器必须是同一个函数的两份实现。抄成两份
 * 用例就等于允许它们慢慢分叉，而分叉的表现是「试跑说成功、线上判致命」。
 */

import { describe, expect, it } from "vitest";
import raw from "../../../../fixtures/verdict-cases.json";
import type { TaskSpec } from "@/lib/api/types";
import { judge } from "./evaluate";

interface Case {
  name: string;
  spec: Record<string, unknown>;
  status: number;
  body: unknown;
  expect: { index: number; verdict: string; code: string; fallback: boolean };
}

const base = raw.base as unknown as Record<string, unknown>;
const cases = raw.cases as unknown as Case[];

describe("判定语义（与 Rust 共享用例）", () => {
  it("用例文件不为空", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(c.name, () => {
      const spec = { ...base, ...c.spec } as unknown as TaskSpec;
      const hit = judge(spec, c.status, c.body);
      expect({ ...hit, verdict: hit.verdict }).toEqual({
        index: c.expect.index,
        verdict: c.expect.verdict,
        code: c.expect.code,
        fallback: c.expect.fallback,
      });
    });
  }
});
