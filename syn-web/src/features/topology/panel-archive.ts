/**
 * # 控制面板导出 / 导入的本地模型
 *
 * 控制面板的图不落库：节点由数据源 / 数据抽取 / 任务三张表现拼。所以「导出面板」
 * 导出的是这三类组件的配置快照，外加一份**人可核对的结构摘要**（泳道、引用关系）。
 * 导入时以组件数据为准重建图，结构摘要只用来发现「文件被手工改过」。
 *
 * ## 文件里有什么、没有什么
 *
 * - 有：数据源（含连接串明文）、数据抽取、任务的完整配置与启停状态；
 * - 没有：游标水位、最近拉取结果。它们属于部署环境，跟着文件走会在换库时跳过
 *   一整段数据；启停是配置，照文件恢复。
 *
 * 连接串明文只由后端的 `GET /syn/panel/export` 提供（其余读接口一律脱敏），
 * 文件按密钥对待。导入是后端单事务批量写，前端只负责预检和展示。
 */

import type {
  DatasourceInfo,
  PanelDatasource,
  PanelExport,
  PanelImportInput,
  PanelImportMode,
  PanelSource,
  PanelTask,
  SourceSpec,
  SyncSource,
  SyncTask,
  TaskSpec,
} from "@/lib/api/types";

export const ARCHIVE_KIND = "syn-control-panel";
export const ARCHIVE_VERSION = 1;

/** 文件里的一句提醒，打开文件的人一眼能看到 */
export const ARCHIVE_NOTICE =
  "本文件含数据源连接串明文，请按密钥管理；游标水位与运行结果不在文件内。";

export interface ArchiveTaskRef {
  name: string;
  topic: string;
  sort_order: number;
}

/** 一条泳道：一个主题下的数据抽取与任务 */
export interface ArchiveLane {
  topic: string;
  sources: string[];
  tasks: ArchiveTaskRef[];
}

/** 面板结构摘要（人可读；导入时按组件数据重建） */
export interface PanelStructure {
  lanes: ArchiveLane[];
  /** 没有主题的组件（正常配置里不该出现，导出时如实列出） */
  orphans: {
    sources: string[];
    tasks: ArchiveTaskRef[];
  };
}

export interface PanelArchive {
  kind: typeof ARCHIVE_KIND;
  version: number;
  /** 导出时间（ISO）；手写文件可能为空 */
  exported_at: string;
  /** 服务端导出时间（毫秒） */
  exported_ms: string;
  notice: string;
  summary: {
    datasources: number;
    sources: number;
    tasks: number;
    topics: number;
  };
  panel: PanelStructure;
  datasources: PanelDatasource[];
  sources: PanelSource[];
  tasks: PanelTask[];
}

export type ImportAction = "create" | "update" | "skip";

export interface DatasourcePlanRow {
  /** 在 `archive.datasources` 里的下标 */
  index: number;
  action: ImportAction;
  code: string;
  name: string;
  target: string | null;
  /** 新增的数据源必须补连接串；覆盖时可留空沿用库里的 */
  needsUrl: boolean;
  existingId?: string;
}

export interface SourcePlanRow {
  index: number;
  action: ImportAction;
  name: string;
  topic: string;
  existingId?: string;
}

export interface TaskPlanRow {
  index: number;
  action: ImportAction;
  name: string;
  topic: string;
  sort_order: number;
  existingId?: string;
}

export interface ImportPlan {
  mode: PanelImportMode;
  datasources: DatasourcePlanRow[];
  sources: SourcePlanRow[];
  tasks: TaskPlanRow[];
  /** 不阻断导入，但值得在预览里看一眼 */
  warnings: string[];
  /** 必须处理才能导入（引用缺失、topic 缺失） */
  blockers: string[];
}

export interface CurrentPanel {
  datasources: DatasourceInfo[];
  sources: SyncSource[];
  tasks: SyncTask[];
}

/* -------------------------------- 构建快照 -------------------------------- */

/** 把后端导出结果补上面板结构，得到落盘的文件对象 */
export function buildArchive(payload: PanelExport, now = Date.now()): PanelArchive {
  const datasources = payload.datasources.map(cloneDatasource);
  const sources = payload.sources.map(cloneSource);
  const tasks = payload.tasks.map(cloneTask);

  return {
    kind: ARCHIVE_KIND,
    version: ARCHIVE_VERSION,
    exported_at: new Date(now).toISOString(),
    exported_ms: String(payload.exported_ms ?? now),
    notice: ARCHIVE_NOTICE,
    summary: summarize(datasources, sources, tasks),
    panel: deriveStructure(sources, tasks),
    datasources,
    sources,
    tasks,
  };
}

/** 由组件数据推导泳道结构。图的唯一事实来源永远是组件，不是这份摘要 */
export function deriveStructure(
  sources: PanelSource[],
  tasks: PanelTask[],
): PanelStructure {
  const topicSet = new Set<string>();
  for (const s of sources) if (s.topic) topicSet.add(s.topic);
  for (const t of tasks) if (t.topic) topicSet.add(t.topic);

  const lanes: ArchiveLane[] = [...topicSet]
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .map((topic) => ({
      topic,
      sources: sources
        .filter((s) => s.topic === topic)
        .map((s) => s.topic)
        .sort((a, b) => a.localeCompare(b)),
      tasks: tasks
        .filter((t) => t.topic === topic)
        .map(taskRef)
        .sort(compareTaskRef),
    }));

  return {
    lanes,
    orphans: {
      sources: sources
        .filter((s) => !s.topic)
        .map((s) => s.name)
        .sort((a, b) => a.localeCompare(b)),
      tasks: tasks.filter((t) => !t.topic).map(taskRef).sort(compareTaskRef),
    },
  };
}

export function summarize(
  datasources: PanelDatasource[],
  sources: PanelSource[],
  tasks: PanelTask[],
): PanelArchive["summary"] {
  const topics = new Set<string>();
  for (const s of sources) if (s.topic) topics.add(s.topic);
  for (const t of tasks) if (t.topic) topics.add(t.topic);
  return {
    datasources: datasources.length,
    sources: sources.length,
    tasks: tasks.length,
    topics: topics.size,
  };
}

function cloneDatasource(d: PanelDatasource): PanelDatasource {
  return {
    code: d.code,
    name: d.name,
    engine: d.engine,
    url: d.url ?? "",
    maxConnections: d.maxConnections,
    enabled: d.enabled,
    remark: d.remark ?? null,
    target: d.target ?? null,
  };
}

function cloneSource(s: PanelSource): PanelSource {
  return {
    name: s.name,
    kind: s.kind,
    topic: s.topic,
    enabled: s.enabled,
    interval_duration: s.interval_duration,
    batch_size: s.batch_size,
    spec: cloneJson(s.spec),
    remark: s.remark ?? null,
  };
}

function cloneTask(t: PanelTask): PanelTask {
  const spec = {
    ...cloneJson(t.spec),
    topic: t.topic,
    sort_order: t.sort_order,
    enabled: t.enabled,
    exclusive: t.exclusive,
  };
  return {
    name: t.name,
    topic: t.topic,
    sort_order: t.sort_order,
    enabled: t.enabled,
    exclusive: t.exclusive,
    spec,
    remark: t.remark ?? null,
  };
}

function taskRef(t: PanelTask): ArchiveTaskRef {
  return { name: t.name, topic: t.topic, sort_order: t.sort_order };
}

function compareTaskRef(a: ArchiveTaskRef, b: ArchiveTaskRef): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name);
}

/* -------------------------------- 解析文件 -------------------------------- */

export type ArchiveParseResult =
  | { ok: true; archive: PanelArchive; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * 解析并校验导入文件。错误带下标路径（`datasources[2].code`），
 * 预览里直接列给用户；能修的小问题（缺导出时间、结构摘要过期）只记 warning。
 */
export function parseArchive(text: string): ArchiveParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`不是合法的 JSON：${errorText(e)}`] };
  }
  if (!isRecord(raw)) return { ok: false, errors: ["文件根节点不是对象"] };
  if (raw.kind !== ARCHIVE_KIND) {
    return {
      ok: false,
      errors: [`不是控制面板导出文件（kind 应为 ${ARCHIVE_KIND}）`],
    };
  }
  if (num(raw.version) !== ARCHIVE_VERSION) {
    return {
      ok: false,
      errors: [`文件版本 ${String(raw.version)} 不受支持（当前支持 ${ARCHIVE_VERSION}）`],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  const datasources = parseDatasources(raw.datasources, errors);
  const sources = parseSources(raw.sources, errors);
  const tasks = parseTasks(raw.tasks, errors);

  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  if (!datasources.length && !sources.length && !tasks.length) {
    return { ok: false, errors: ["文件里没有任何组件（数据源 / 数据抽取 / 任务）"] };
  }

  const expected = deriveStructure(sources, tasks);
  const expectedSummary = summarize(datasources, sources, tasks);
  if (raw.panel !== undefined && !sameStructure(raw.panel, expected)) {
    warnings.push("文件里的结构摘要与组件数据不一致，已按组件数据重建（组件为准）");
  }
  if (raw.summary !== undefined && !sameSummary(raw.summary, expectedSummary)) {
    warnings.push("文件里的计数摘要与组件数据不一致，已按组件数据重算");
  }
  if (!str(raw.exported_at)) warnings.push("文件没有导出时间，无法核对是哪一版面板");

  return {
    ok: true,
    warnings,
    archive: {
      kind: ARCHIVE_KIND,
      version: ARCHIVE_VERSION,
      exported_at: str(raw.exported_at) ?? "",
      exported_ms: String(num(raw.exported_ms)),
      notice: str(raw.notice) ?? ARCHIVE_NOTICE,
      summary: expectedSummary,
      panel: expected,
      datasources,
      sources,
      tasks,
    },
  };
}

function parseDatasources(raw: unknown, errors: string[]): PanelDatasource[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push("datasources 不是数组");
    return [];
  }
  const rows = (raw ?? []) as unknown[];
  const seen = new Set<string>();
  const out: PanelDatasource[] = [];
  rows.forEach((row, i) => {
    const path = `datasources[${i}]`;
    if (!isRecord(row)) {
      errors.push(`${path} 不是对象`);
      return;
    }
    const code = reqStr(row.code, `${path}.code`, errors).trim();
    if (code && seen.has(code)) errors.push(`${path}.code ${code} 在文件里重复`);
    seen.add(code);
    const name = reqStr(row.name, `${path}.name`, errors).trim();
    const engine = parseEngine(row.engine, `${path}.engine`, errors);
    const maxConnections = intField(row.maxConnections, `${path}.maxConnections`, 8, 1, 1000, errors);
    const remark = nullableStr(row.remark, `${path}.remark`, errors);
    const target = nullableStr(row.target, `${path}.target`, errors);
    out.push({
      code,
      name,
      engine,
      url: str(row.url)?.trim() ?? "",
      maxConnections,
      enabled: bool(row.enabled, true),
      remark,
      target,
    });
  });
  return out;
}

function parseSources(raw: unknown, errors: string[]): PanelSource[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push("sources 不是数组");
    return [];
  }
  const rows = (raw ?? []) as unknown[];
  const seen = new Set<string>();
  const out: PanelSource[] = [];
  rows.forEach((row, i) => {
    const path = `sources[${i}]`;
    if (!isRecord(row)) {
      errors.push(`${path} 不是对象`);
      return;
    }
    const name = reqStr(row.name, `${path}.name`, errors).trim();
    const kind = parseSourceKind(row.kind, `${path}.kind`, errors);
    const spec = reqRecord(row.spec, `${path}.spec`, errors);
    const topic = reqStr(row.topic, `${path}.topic`, errors).trim();
    if (topic && seen.has(topic)) errors.push(`${path}.topic ${topic} 在文件里重复`);
    seen.add(topic);
    out.push({
      name,
      kind,
      topic,
      enabled: bool(row.enabled, true),
      interval_duration: str(row.interval_duration)?.trim() || "1m",
      batch_size: intField(row.batch_size, `${path}.batch_size`, 100, 1, 5000, errors),
      spec: spec as SourceSpec,
      remark: nullableStr(row.remark, `${path}.remark`, errors),
    });
  });
  return out;
}

function parseTasks(raw: unknown, errors: string[]): PanelTask[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push("tasks 不是数组");
    return [];
  }
  const rows = (raw ?? []) as unknown[];
  const out: PanelTask[] = [];
  rows.forEach((row, i) => {
    const path = `tasks[${i}]`;
    if (!isRecord(row)) {
      errors.push(`${path} 不是对象`);
      return;
    }
    const name = reqStr(row.name, `${path}.name`, errors).trim();
    const topic = reqStr(row.topic, `${path}.topic`, errors).trim();
    const sortOrder = intField(row.sort_order, `${path}.sort_order`, 0, -1_000_000, 1_000_000, errors);
    const spec = reqRecord(row.spec, `${path}.spec`, errors);
    const enabled = bool(row.enabled, typeof spec.enabled === "boolean" ? spec.enabled : true);
    const exclusive = bool(
      row.exclusive,
      typeof spec.exclusive === "boolean" ? spec.exclusive : true,
    );
    out.push({
      name,
      topic,
      sort_order: sortOrder,
      enabled,
      exclusive,
      spec: {
        ...spec,
        topic,
        sort_order: sortOrder,
        enabled,
        exclusive,
      } as TaskSpec,
      remark: nullableStr(row.remark, `${path}.remark`, errors),
    });
  });
  return out;
}

/* -------------------------------- 导入预检 -------------------------------- */

/**
 * 对比文件与当前环境，算出每条组件的动作。纯函数：预览、确认、测试都看同一份结果。
 *
 * 阻断项只放「无论用户怎么选都会失败」的问题：
 * - 抽取 / db 任务引用的数据源在「当前环境 + 文件」里都不存在；
 * - 抽取缺 topic（topic 必填且唯一，是关联键与身份键）。
 * 「新增数据源缺连接串」不在这里阻断：连接串由用户在预览里现填，填完即可导。
 */
export function planImport(
  archive: PanelArchive,
  current: CurrentPanel,
  mode: PanelImportMode,
): ImportPlan {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const finalDsCodes = new Set(current.datasources.map((d) => d.code));
  for (const d of archive.datasources) finalDsCodes.add(d.code);

  /* ------------------------------ 数据源 ------------------------------ */
  const currentDs = new Map(current.datasources.map((d) => [d.code, d]));
  const datasources: DatasourcePlanRow[] = archive.datasources.map((d, index) => {
    const existing = currentDs.get(d.code);
    const action: ImportAction = existing ? (mode === "skip" ? "skip" : "update") : "create";
    return {
      index,
      action,
      code: d.code,
      name: d.name,
      target: d.target ?? null,
      needsUrl: !existing,
      existingId: existing?.id,
    };
  });

  /* ----------------------------- 数据抽取 ----------------------------- */
  // 去掉 code 后 topic 是数据抽取的唯一身份：既是导入识别键，也是关联键
  const currentSrc = new Map(current.sources.map((s) => [s.topic, s]));
  const sources: SourcePlanRow[] = archive.sources.map((s, index) => {
    const topic = s.topic.trim();
    const existing = topic ? currentSrc.get(topic) : undefined;
    const action: ImportAction = existing ? (mode === "skip" ? "skip" : "update") : "create";

    if (action !== "skip") {
      if (!topic) {
        blockers.push(`数据抽取「${s.name}」没有填 topic（topic 必填且必须唯一）`);
      }
      const ds = s.spec.datasource?.trim();
      if (ds && !finalDsCodes.has(ds)) {
        blockers.push(`数据抽取 ${topic || s.name} 引用的数据源 ${ds} 既不在文件里、也不在当前环境`);
      }
    }

    return { index, action, name: s.name, topic, existingId: existing?.id };
  });

  /* ------------------------------- 任务 ------------------------------- */
  const pool = new Map<string, SyncTask[]>();
  for (const t of current.tasks) {
    const key = taskKey(t.topic, t.name);
    const list = pool.get(key);
    if (list) list.push(t);
    else pool.set(key, [t]);
  }
  const archiveIdentity = new Set<string>();
  const tasks: TaskPlanRow[] = archive.tasks.map((t, index) => {
    const identity = taskKey(t.topic, t.name);
    if (archiveIdentity.has(identity)) {
      warnings.push(`任务「${t.topic} / ${t.name}」在文件里出现多次，将按排序值依次匹配`);
    }
    archiveIdentity.add(identity);

    const candidates = (pool.get(identity) ?? []).slice().sort(
      (a, b) => Math.abs(a.sort_order - t.sort_order) - Math.abs(b.sort_order - t.sort_order),
    );
    const existing = candidates[0];
    if (existing) {
      pool.set(
        identity,
        (pool.get(identity) ?? []).filter((x) => x.id !== existing.id),
      );
    }
    const action: ImportAction = existing ? (mode === "skip" ? "skip" : "update") : "create";

    if (action !== "skip" && t.spec.target.kind === "db") {
      const ds = t.spec.target.datasource?.trim();
      if (ds && !finalDsCodes.has(ds)) {
        blockers.push(`任务 ${t.name} 直写的数据源 ${ds} 既不在文件里、也不在当前环境`);
      }
    }

    return {
      index,
      action,
      name: t.name,
      topic: t.topic,
      sort_order: t.sort_order,
      existingId: existing?.id,
    };
  });

  // 同主题同排序值不是错，但「首个命中即停」的语义会变成看插入顺序
  const sortSeen = new Map<string, Set<number>>();
  for (const t of current.tasks) {
    if (t.topic) addSort(sortSeen, t.topic, t.sort_order);
  }
  for (const row of tasks) {
    if (row.action === "skip") continue;
    if (addSort(sortSeen, row.topic, row.sort_order)) {
      warnings.push(`主题「${row.topic}」下排序值 ${row.sort_order} 重名，命中顺序将取决于主键`);
    }
  }

  return {
    mode,
    datasources,
    sources,
    tasks,
    warnings: dedupe(warnings),
    blockers: dedupe(blockers),
  };
}

/** 三类组件在任一模式下的动作计数（预览页脚、按钮文案共用） */
export function planCounts(plan: ImportPlan): {
  create: number;
  update: number;
  skip: number;
} {
  const all = [...plan.datasources, ...plan.sources, ...plan.tasks];
  return {
    create: all.filter((r) => r.action === "create").length,
    update: all.filter((r) => r.action === "update").length,
    skip: all.filter((r) => r.action === "skip").length,
  };
}

/** 新增且仍未填连接串的数据源；预览里据此禁用「开始导入」 */
export function missingUrlCodes(plan: ImportPlan, urls: Record<string, string>): string[] {
  return plan.datasources
    .filter((row) => row.needsUrl && row.action === "create" && !(urls[row.code] ?? "").trim())
    .map((row) => row.code);
}

/** 文件 → 后端批量导入入参（只带组件，不带结构摘要） */
export function toImportInput(archive: PanelArchive, mode: PanelImportMode): PanelImportInput {
  return {
    mode,
    datasources: archive.datasources,
    sources: archive.sources,
    tasks: archive.tasks,
  };
}

/** 下载文件名：`syn-control-panel-20261117-1530.json`（本地时间，便于排序） */
export function archiveFileName(archive: PanelArchive, now = new Date()): string {
  const date = new Date(archive.exported_at || now.toISOString());
  const d = Number.isNaN(date.getTime()) ? now : date;
  const p = (n: number) => String(n).padStart(2, "0");
  return `syn-control-panel-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}.json`;
}

/* -------------------------------- 小工具 -------------------------------- */

function taskKey(topic: string, name: string): string {
  return `${topic.trim()}\u0000${name.trim()}`;
}

function addSort(map: Map<string, Set<number>>, topic: string, sort: number): boolean {
  const set = map.get(topic);
  if (!set) {
    map.set(topic, new Set([sort]));
    return false;
  }
  if (set.has(sort)) return true;
  set.add(sort);
  return false;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function reqStr(v: unknown, path: string, errors: string[]): string {
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`${path} 必须是非空字符串`);
    return "";
  }
  return v;
}

function reqRecord(
  v: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> {
  if (!isRecord(v)) {
    errors.push(`${path} 必须是对象`);
    return {};
  }
  return v;
}

function nullableStr(v: unknown, path: string, errors: string[]): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    errors.push(`${path} 必须是字符串`);
    return null;
  }
  return v;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function intField(
  v: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  if (v === undefined || v === null) return fallback;
  const n = num(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${path} 必须在 ${min}..=${max} 之间`);
    return fallback;
  }
  return n;
}

function parseEngine(v: unknown, path: string, errors: string[]) {
  if (v === undefined || v === null) return "postgres" as const;
  if (v === "postgres" || v === "mysql" || v === "sqlite") return v;
  errors.push(`${path} 只能是 postgres / mysql / sqlite`);
  return "postgres" as const;
}

function parseSourceKind(v: unknown, path: string, errors: string[]) {
  if (v === undefined || v === null) return "sql" as const;
  if (v === "sql" || v === "http") return v;
  if (v === 0) return "sql" as const;
  if (v === 1) return "http" as const;
  errors.push(`${path} 只能是 sql / http`);
  return "sql" as const;
}

function sameStructure(raw: unknown, expected: PanelStructure): boolean {
  if (!isRecord(raw)) return false;
  const lanes = raw.lanes;
  if (!Array.isArray(lanes) || lanes.length !== expected.lanes.length) return false;
  const got = new Set(
    lanes
      .filter(isRecord)
      .map((lane) => str(lane.topic))
      .filter((v): v is string => !!v),
  );
  return expected.lanes.every((lane) => got.has(lane.topic));
}

function sameSummary(raw: unknown, expected: PanelArchive["summary"]): boolean {
  if (!isRecord(raw)) return false;
  return (
    num(raw.datasources) === expected.datasources &&
    num(raw.sources) === expected.sources &&
    num(raw.tasks) === expected.tasks &&
    num(raw.topics) === expected.topics
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
