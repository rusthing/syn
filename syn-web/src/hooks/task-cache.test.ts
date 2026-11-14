/**
 * 任务启停缓存补丁的契约测试。
 *
 * 这几个断言锁的是「开关点了之后界面和库里最终会不会一致」，不是实现细节：
 * 只改 `enabled` 不改 `spec.enabled` 会由随后一次编辑保存把开关悄悄关回去；
 * 漏掉某个筛选条件下的分页缓存，列表页就会显示和拓扑页相反的状态。
 * 两种漂移都不报错，只是安静地显示错数据，所以必须有测试盯着。
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Page, SyncTask, TaskSpec } from "@/lib/api/types";
import {
  forgetToggleSeq,
  isLatestToggle,
  nextToggleSeq,
  patchTaskEnabled,
  restoreTaskCaches,
  snapshotTaskCaches,
} from "./task-cache";

function spec(enabled: boolean): TaskSpec {
  return {
    id: "demo",
    topic: "iot.region",
    priority: 10,
    enabled,
    target: { kind: "http", service: "demo-svr", base: "/api" },
    mapping: { rows: [] },
  };
}

function task(id: string, enabled: boolean): SyncTask {
  return {
    id,
    code: id,
    name: `任务 ${id}`,
    topic: "iot.region",
    priority: 10,
    enabled,
    version: 3,
    spec: spec(enabled),
    stats: { total: 0, success: 0, skip: 0, fatal: 0, retriable: 0, p95_ms: 0, last_hit_ms: null },
    creater_id: "0",
    create_ms: "0",
    updater_id: "0",
    update_ms: "0",
  };
}

function seed(client: QueryClient) {
  client.setQueryData(["tasks", "list"], [task("a", false), task("b", true)]);
  client.setQueryData(["tasks", "page", { pageNum: 1 }], {
    total: 2,
    list: [task("a", false), task("b", true)],
  } satisfies Page<SyncTask>);
  client.setQueryData(["tasks", "page", { enabled: false, pageNum: 1 }], {
    total: 1,
    list: [task("a", false)],
  } satisfies Page<SyncTask>);
  client.setQueryData(["tasks", "detail", "a"], task("a", false));
}

describe("patchTaskEnabled", () => {
  it("list、所有分页、detail 一起改，且 spec.enabled 同步", () => {
    const client = new QueryClient();
    seed(client);
    patchTaskEnabled(client, "a", true);

    const list = client.getQueryData<SyncTask[]>(["tasks", "list"])!;
    expect(list[0].enabled).toBe(true);
    expect(list[0].spec.enabled).toBe(true);
    expect(list[1].enabled).toBe(true); // 别的任务不动
    expect(list[1].spec.enabled).toBe(true);

    const page1 = client.getQueryData<Page<SyncTask>>(["tasks", "page", { pageNum: 1 }])!;
    expect(page1.list[0].enabled).toBe(true);
    expect(page1.list[0].spec.enabled).toBe(true);

    const filtered = client.getQueryData<Page<SyncTask>>([
      "tasks",
      "page",
      { enabled: false, pageNum: 1 },
    ])!;
    expect(filtered.list[0].enabled).toBe(true);

    const detail = client.getQueryData<SyncTask>(["tasks", "detail", "a"])!;
    expect(detail.enabled).toBe(true);
    expect(detail.spec.enabled).toBe(true);
  });

  it("patch 不改动原对象（React Query 靠引用变化触发重渲染）", () => {
    const client = new QueryClient();
    seed(client);
    const before = client.getQueryData<SyncTask[]>(["tasks", "list"])!;
    const original = before[0];
    patchTaskEnabled(client, "a", true);
    const after = client.getQueryData<SyncTask[]>(["tasks", "list"])!;
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(original);
    expect(original.enabled).toBe(false);
  });

  it("回滚要还原到点击前的整份缓存，含 spec.enabled", () => {
    const client = new QueryClient();
    seed(client);
    const snapshot = snapshotTaskCaches(client);
    patchTaskEnabled(client, "a", true);
    restoreTaskCaches(client, snapshot);
    const list = client.getQueryData<SyncTask[]>(["tasks", "list"])!;
    expect(list[0].enabled).toBe(false);
    expect(list[0].spec.enabled).toBe(false);
  });

  it("取消在途 refetch 之后再打一次补丁：开关留住，query 不变成 error", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(client);
    // 一个永不 resolve 的在途 list 请求；useTaskMutations 会先打补丁、再 cancel、再补一次
    const pending = client.fetchQuery({
      queryKey: ["tasks", "list"],
      queryFn: () => new Promise<SyncTask[]>(() => {}),
    });
    pending.catch(() => {}); // cancel 会把它拒绝掉，别让测试报未处理拒绝

    patchTaskEnabled(client, "a", true);
    await client.cancelQueries({ queryKey: ["tasks"] });
    patchTaskEnabled(client, "a", true);

    const query = client.getQueryCache().find({ queryKey: ["tasks", "list"] })!;
    expect(query.state.status).toBe("success");
    const list = client.getQueryData<SyncTask[]>(["tasks", "list"])!;
    expect(list[0].enabled).toBe(true);
    expect(list[0].spec.enabled).toBe(true);
  });
});

describe("连点序号", () => {
  it("只有最后一次点击有权收尾", () => {
    const first = nextToggleSeq("task-1");
    const second = nextToggleSeq("task-1");
    expect(first).not.toBe(second);
    expect(isLatestToggle("task-1", first)).toBe(false);
    expect(isLatestToggle("task-1", second)).toBe(true);

    forgetToggleSeq("task-1", second);
    expect(isLatestToggle("task-1", first)).toBe(false);
    expect(isLatestToggle("task-1", second)).toBe(false);
  });

  it("不同任务互不干扰", () => {
    const a = nextToggleSeq("task-a");
    const b = nextToggleSeq("task-b");
    expect(isLatestToggle("task-a", a)).toBe(true);
    expect(isLatestToggle("task-b", b)).toBe(true);
    forgetToggleSeq("task-a", a);
    expect(isLatestToggle("task-b", b)).toBe(true);
  });
});
