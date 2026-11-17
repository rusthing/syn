/**
 * 实时试跑：复用 lib 的纯函数 judge()，不在界面里重算判定。
 *
 * judge 返回的 index 是命中的**顶层语句序号**（嵌套命中也算顶层序号），
 * 正好对应决策表第 0 层的行；上层 VerdictEditor 据此高亮命中行及其子树。
 */
import { useState } from "react";
import type { Rule, TaskSpec, Verdict } from "@/lib/api/types";
import { judge } from "@/lib/spec/evaluate";
import { VerdictBadge } from "./VerdictBadge";

export interface TrialResult {
  index: number;
  verdict: Verdict;
  code: string;
  fallback: boolean;
}

export function TrialPanel({
  spec,
  rules,
  onResult,
}: {
  spec: TaskSpec;
  rules: Rule[];
  onResult: (result: TrialResult | null) => void;
}) {
  const [status, setStatus] = useState("200");
  const [code, setCode] = useState("1001");
  const [retryable, setRetryable] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [bodyText, setBodyText] = useState('{"code": 1001, "retryable": true}');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TrialResult | null>(null);

  const fill = (s: number, c: number, r: boolean) => {
    setStatus(String(s));
    setCode(String(c));
    setRetryable(r);
    setBodyText(JSON.stringify({ code: c, retryable: r }));
    setAdvanced(false);
  };

  const run = () => {
    const s = Number(status);
    if (!Number.isFinite(s)) {
      setError("状态码必须是数字");
      return;
    }
    let body: unknown;
    if (advanced) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch (e) {
        setError(`响应体不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else {
      body = {
        ...(code.trim() === "" ? {} : { code: Number(code) }),
        retryable,
      };
    }
    setError(null);
    // 试的是当前编辑中的语句树：旧任务尚未写入 spec.rules 时用界面里的 rules
    const next = judge({ ...spec, rules, outcomes: undefined }, s, body);
    const r: TrialResult = { index: next.index, verdict: next.verdict, code: next.code, fallback: next.fallback };
    setResult(r);
    onResult(r);
  };

  return (
    <div id="verdict-trial" className="rounded-lg border border-line bg-sunken px-2.5 py-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] font-medium text-ink">实时试跑</span>
        <span className="text-[10.5px] text-muted">输入下游响应 → 高亮管住它的那条路径</span>
        <span className="ml-auto flex items-center gap-1">
          {[
            { label: "403", args: [403, 0, false] as const },
            { label: "503", args: [503, 0, false] as const },
            { label: "1001 / 可恢复", args: [200, 1001, true] as const },
          ].map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => fill(q.args[0], q.args[1], q.args[2])}
              className="h-6 rounded border border-line bg-surface px-1.5 text-[10.5px] text-ink-soft transition-colors hover:border-accent/40 hover:text-accent"
            >
              {q.label}
            </button>
          ))}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-muted">状态码</span>
          <input
            value={status}
            inputMode="numeric"
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 w-[84px] rounded-md border border-line bg-surface px-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
          />
        </label>
        {!advanced && (
          <>
            <label className="block">
              <span className="mb-0.5 block text-[10px] text-muted">body.code</span>
              <input
                value={code}
                inputMode="numeric"
                onChange={(e) => setCode(e.target.value)}
                className="h-8 w-[96px] rounded-md border border-line bg-surface px-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[10px] text-muted">body.retryable</span>
              <select
                value={retryable ? "true" : "false"}
                onChange={(e) => setRetryable(e.target.value === "true")}
                className="h-8 rounded-md border border-line bg-surface px-2 text-[11px] text-ink-soft outline-none focus:border-accent"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          </>
        )}
        {advanced && (
          <label className="block min-w-[240px] flex-1">
            <span className="mb-0.5 block text-[10px] text-muted">响应体 JSON（任意字段）</span>
            <input
              value={bodyText}
              spellCheck={false}
              onChange={(e) => setBodyText(e.target.value)}
              className="h-8 w-full rounded-md border border-line bg-surface px-2 font-mono text-[11.5px] text-ink outline-none focus:border-accent"
            />
          </label>
        )}
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="h-8 rounded-md border border-line bg-surface px-2 text-[10.5px] text-ink-soft hover:border-accent/40 hover:text-accent"
        >
          {advanced ? "用简版输入" : "完整 JSON"}
        </button>
        <button
          type="button"
          onClick={run}
          className="h-8 rounded-md border border-accent bg-accent px-3 text-[11px] font-medium text-white transition-colors hover:bg-accent-strong"
        >
          试跑
        </button>
      </div>

      <div className="mt-2 flex min-h-[24px] flex-wrap items-center gap-2 border-t border-dashed border-line pt-1.5 text-[11px] text-muted">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : result ? (
          <>
            {result.fallback ? (
              <span className="text-danger">UNCLASSIFIED · 没有语句给出结论</span>
            ) : (
              <>
                <VerdictBadge verdict={result.verdict} />
                <code className="text-ink-soft">{result.code}</code>
                <span>命中第 {result.index} 条顶层语句 · 已展开并高亮</span>
              </>
            )}
          </>
        ) : (
          <span>尚未试跑</span>
        )}
      </div>
    </div>
  );
}
