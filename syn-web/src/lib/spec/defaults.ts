/**
 * 五段的界面元数据与模板。
 *
 * 所有「标签、顺序、默认值」集中在这里，编辑器按表渲染。散在组件里最大的问题是
 * 加一个操作符要改三处，漏一处就出现「下拉里有、说明里没有」。
 */

import type {
  Action,
  Assert,
  BodyMode,
  Method,
  OnEmpty,
  Op,
  Operator,
  Scope,
  TaskSpec,
  Verdict,
} from "@/lib/api/types";

export interface OperatorMeta {
  value: Operator;
  label: string;
  /** 需要期望值 */
  needsValue: boolean;
  /** 文本散文匹配：要提示上游补错误码 */
  textual?: boolean;
  hint?: string;
}

export const OPERATORS: OperatorMeta[] = [
  { value: "eq", label: "等于", needsValue: true },
  { value: "ne", label: "不等于", needsValue: true },
  { value: "in", label: "属于", needsValue: true, hint: "期望值是数组" },
  { value: "not_in", label: "不属于", needsValue: true, hint: "期望值是数组" },
  { value: "exists", label: "存在", needsValue: false, hint: "非 null 即算存在" },
  { value: "absent", label: "不存在", needsValue: false, hint: "不存在或为 null" },
  { value: "present", label: "非空", needsValue: false, hint: "字符串非空白、数组/对象非空" },
  { value: "starts_with", label: "前缀", needsValue: true },
  { value: "contains", label: "包含", needsValue: true, textual: true },
  { value: "regex", label: "正则", needsValue: true, textual: true },
  { value: "gt", label: "大于", needsValue: true },
  { value: "lt", label: "小于", needsValue: true },
];

export const operatorMeta = (op: Operator): OperatorMeta =>
  OPERATORS.find((o) => o.value === op) ?? OPERATORS[0];

export const SCOPES: Array<{ value: Scope; label: string; hint: string }> = [
  { value: "record", label: "记录", hint: "sink 送进来的原始变更记录" },
  { value: "body", label: "请求体", hint: "映射之后的报文" },
  { value: "status", label: "状态码", hint: "下游返回的 HTTP 状态码" },
];

export const OPS: Array<{ value: Op; label: string; note: string }> = [
  { value: "c", label: "新增", note: "insert" },
  { value: "r", label: "快照读", note: "snapshot read，自拉数据必用" },
  { value: "u", label: "修改", note: "update" },
  { value: "d", label: "删除", note: "delete" },
];

export const METHODS: Method[] = ["POST", "PUT", "PATCH", "DELETE", "GET"];

export const BODY_MODES: Array<{ value: BodyMode; label: string; hint: string }> = [
  { value: "mapped", label: "映射结果", hint: "发送 mapping 段产出的报文" },
  { value: "raw", label: "原样透传", hint: "整条记录原封不动发过去" },
  { value: "none", label: "不发送", hint: "DELETE / GET 通常用这个" },
];

export const ON_EMPTY: Array<{ value: OnEmpty; label: string; hint: string }> = [
  { value: "keep", label: "保持空值", hint: "空串就发空串（默认，与老脚本一致）" },
  { value: "keep_original", label: "回退原值", hint: "去后缀去空了就别去" },
  { value: "omit", label: "省略字段", hint: "报文里不出现这个键" },
  { value: "null", label: "写成 null", hint: "键在，值是 null" },
];

export const VERDICTS: Array<{
  value: Verdict;
  label: string;
  tone: "success" | "muted" | "danger" | "warn";
  http: number;
  note: string;
}> = [
  { value: "success", label: "成功", tone: "success", http: 200, note: "提交 offset" },
  { value: "skip", label: "跳过", tone: "muted", http: 200, note: "提交 offset，记日志" },
  { value: "fatal", label: "失败", tone: "danger", http: 400, note: "确定性失败，进死信" },
  { value: "retriable", label: "重试", tone: "warn", http: 503, note: "交还 sink 重试" },
];

export const verdictMeta = (v: Verdict) => VERDICTS.find((x) => x.value === v) ?? VERDICTS[0];

export const STAGE_LABELS: Record<string, string> = {
  match: "匹配",
  mapping: "映射",
  guard: "校验",
  action: "动作",
  transport: "传输",
  verdict: "判定",
};

/* --------------------------------- 模板 --------------------------------- */

export function emptyAssert(): Assert {
  return { field: "$.op", op: "in", value: ["c", "r", "u", "d"], scope: "record" };
}

export function emptyAction(op: Op = "c"): Action {
  return { op, method: "POST", path: "", body: "mapped", query: [], headers: [] };
}

/** 新建任务的最小骨架：能通过校验，但不含任何业务字段 */
export function newTask(topic = "dtw.region", code = "new_task"): TaskSpec {
  return {
    id: code,
    topic,
    priority: 100,
    enabled: false,
    exclusive: true,
    target: { service: "dtw-rs-svr", base: "/dtw/region" },
    match: [emptyAssert()],
    mapping: {
      omit_null: true,
      rows: [{ to: "id", from: "$.after.id" }],
    },
    actions: [emptyAction("c"), emptyAction("r")],
    guards: [],
    outcomes: [
      {
        scope: "status",
        assert: [{ op: "in", value: [200, 201, 204] }],
        verdict: "success",
        code: "ok",
      },
      {
        scope: "status",
        assert: [{ op: "eq", value: 404 }],
        verdict: "skip",
        code: "not_found",
      },
      {
        scope: "status",
        assert: [{ op: "in", value: [500, 502, 503, 504] }],
        verdict: "retriable",
        code: "upstream_unavailable",
      },
      {
        scope: "body",
        assert: [{ field: "$.result", op: "lt", value: 0 }],
        verdict: "fatal",
        code: "business_error",
      },
      // 没枚举到的状态码由执行器的 UNCLASSIFIED 兜底按 fatal 处理，不必再写一条

    ],
  };
}

/** 深拷贝：编辑器一律在副本上改，取消时才不会污染列表数据 */
export function cloneSpec(spec: TaskSpec): TaskSpec {
  return JSON.parse(JSON.stringify(spec)) as TaskSpec;
}
