/**
 * 数据入口。上层只 import 这里的 `tasks` / `sources` / …，不关心背后是真服务还是演示数据。
 *
 * 模式选择：
 * - 配了 `VITE_API_BASE` → 默认连真实服务；
 * - 没配 → 默认演示数据（没有可连的地址，硬着头皮请求只会白屏）。
 * 用户可在侧栏手动切换，选择存 localStorage，优先级最高。
 */

import { API_BASE, HAS_API, syncRecord } from "./http";
import {
  liveDatasources,
  liveDeliveries,
  liveIdem,
  liveOverview,
  liveSources,
  liveTasks,
} from "./live";
import {
  mockDatasources,
  mockDeliveries,
  mockIdem,
  mockSources,
  mockTasks,
  mockTopics,
  overview as mockOverview,
  SAMPLE_RECORDS,
} from "./mock";
import type {
  DatasourceInfo,
  Delivery,
  IdemRecord,
  Overview,
  Page,
  PullResult,
  SourceSaveInput,
  SyncReply,
  SyncSource,
  SyncTask,
  TaskSpec,
  Verdict,
} from "./types";

export type DataMode = "mock" | "live";

const MODE_KEY = "syn.data-mode";
const MODE_EVENT = "syn:data-mode";

export const DEFAULT_MODE: DataMode = HAS_API ? "live" : "mock";

export function getDataMode(): DataMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === "mock" || stored === "live") return stored;
  } catch {
    /* localStorage 可能被禁；回落到默认值即可 */
  }
  return DEFAULT_MODE;
}

export function setDataMode(mode: DataMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent<DataMode>(MODE_EVENT, { detail: mode }));
}

export function subscribeDataMode(listener: (mode: DataMode) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<DataMode>).detail);
  window.addEventListener(MODE_EVENT, handler);
  return () => window.removeEventListener(MODE_EVENT, handler);
}

export function endpointLabel(): string {
  if (getDataMode() === "mock") return "内存演示数据";
  return API_BASE || "未配置接口前缀";
}

const isMock = () => getDataMode() === "mock";

export interface TaskQuery {
  keyword?: string;
  topic?: string;
  enabled?: boolean;
  pageNum?: number;
  pageSize?: number;
}

export const tasks = {
  page: (query: TaskQuery = {}): Promise<Page<SyncTask>> =>
    isMock() ? mockTasks.page(query) : liveTasks.page(query),
  list: (): Promise<SyncTask[]> => (isMock() ? mockTasks.list() : liveTasks.list()),
  get: (id: string): Promise<SyncTask> => (isMock() ? mockTasks.get(id) : liveTasks.get(id)),
  create: (input: { name: string; spec: TaskSpec }): Promise<SyncTask> =>
    isMock() ? mockTasks.create(input) : liveTasks.create(input),
  update: (id: string, input: { name: string; spec: TaskSpec }): Promise<SyncTask> =>
    isMock() ? mockTasks.update(id, input) : liveTasks.update(id, input),
  toggle: (id: string, enabled: boolean): Promise<SyncTask> =>
    isMock() ? mockTasks.toggle(id, enabled) : liveTasks.toggle(id, enabled),
  remove: (id: string): Promise<null> => (isMock() ? mockTasks.remove(id) : liveTasks.remove(id)),
  reload: (): Promise<{ count: number } | null> =>
    isMock() ? mockTasks.reload() : liveTasks.reload(),
};

export const sources = {
  list: (): Promise<SyncSource[]> => (isMock() ? mockSources.list() : liveSources.list()),
  /** 有 `id` 走修改、没有走新增；编辑器不用关心两种模式 */
  save: (input: SourceSaveInput): Promise<SyncSource> =>
    isMock()
      ? mockSources.save(input)
      : input.id
        ? liveSources.update(input.id, input)
        : liveSources.create(input),
  remove: (id: string): Promise<null> =>
    isMock() ? mockSources.remove(id) : liveSources.remove(id),
  pull: (id: string): Promise<PullResult> =>
    isMock() ? mockSources.pull(id) : liveSources.pull(id),
  toggle: (id: string, enabled: boolean): Promise<SyncSource> =>
    isMock() ? mockSources.toggle(id, enabled) : liveSources.toggle(id, enabled),
};

/** 数据源连接清单。演示模式下也给出同样的名字，编辑器两边表现一致 */
export const datasources = {
  list: (): Promise<DatasourceInfo[]> =>
    isMock() ? mockDatasources.list() : liveDatasources.list(),
};

export interface DeliveryQuery {
  task_code?: string;
  verdict?: Verdict;
  keyword?: string;
  pageNum?: number;
  pageSize?: number;
}

export const deliveries = {
  page: (query: DeliveryQuery = {}): Promise<Page<Delivery>> =>
    isMock() ? mockDeliveries.page(query) : liveDeliveries.page(query),
};

export const idem = {
  page: (query: { keyword?: string; pageNum?: number; pageSize?: number } = {}): Promise<
    Page<IdemRecord>
  > => (isMock() ? mockIdem.page(query) : liveIdem.page(query)),
};

export const overview = {
  get: (window = "24h"): Promise<Overview> =>
    isMock() ? mockOverview({ window }) : liveOverview.get(window),
};

/** 真实投递。演示模式下不发任何请求，界面上按钮本来就是禁用的 */
export async function deliver(topic: string, record: unknown): Promise<SyncReply> {
  if (isMock()) {
    throw new Error("演示模式不发送真实请求；切到「实时接口」后再试");
  }
  return syncRecord(topic, record);
}

export const isLiveMode = (): boolean => !isMock();

/** 样例报文与 topic 列表来自演示数据，实时模式下同样可用来试跑 */
export const sampleRecords = SAMPLE_RECORDS;
export const knownTopics = mockTopics;

export { ApiError } from "./http";
export * from "./types";
