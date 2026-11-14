import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck, CircleX, FlaskConical, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import type { SyncTask, TaskSpec } from "@/lib/api/types";
import { cloneSpec, newTask } from "@/lib/spec/defaults";
import { issuesByPath, issuesUnder, validateSpec } from "@/lib/spec/validate";
import { AssertEditor } from "@/components/spec/AssertEditor";
import { MappingEditor } from "@/components/spec/MappingEditor";
import { ActionEditor } from "@/components/spec/ActionEditor";
import { GuardEditor } from "@/components/spec/GuardEditor";
import { OutcomeEditor } from "@/components/spec/OutcomeEditor";
import { useTaskMutations } from "@/hooks/use-tasks";
import { useDatasources, useServices } from "@/hooks/use-sources";

/** 页签键：控制面板点卡片上的某一段时，按这个值直接打开对应页签 */
export type TaskTab =
  | "match"
  | "mapping"
  | "actions"
  | "guards"
  | "outcomes"
  | "target"
  | "json";

type Tab = TaskTab;

const TABS: Array<{ key: Tab; label: string; stage: string }> = [
  { key: "match", label: "匹配", stage: "1" },
  { key: "mapping", label: "映射", stage: "2" },
  { key: "guards", label: "校验", stage: "3" },
  { key: "actions", label: "动作", stage: "4" },
  // 投递在判定之前：判定段看的就是投递的响应，先有投递才有结论
  { key: "target", label: "投递", stage: "5" },
  { key: "outcomes", label: "判定", stage: "6" },
  { key: "json", label: "JSON", stage: "—" },
];

/** 问题路径 → 归属的页签：保存失败时要能把人直接送到出错的那一段 */
function tabOfPath(path: string): Tab {
  if (path.startsWith("mapping")) return "mapping";
  if (path.startsWith("match")) return "match";
  if (path.startsWith("actions")) return "actions";
  if (path.startsWith("guards")) return "guards";
  if (path.startsWith("outcomes")) return "outcomes";
  if (path.startsWith("target")) return "target";
  // id / topic 在顶部身份证区直接标红，其余未知路径落到第一段
  return "match";
}

/**
 * 任务编辑窗体。
 *
 * 没有独立的基本页签：code / 名称 / topic / 优先级是任务的身份证，常驻窗体顶部，
 * 任何页签下都看得到；启用 / 独占不在表单里 —— 启用在卡片右上角、独占在连线落点
 * （控制面板），它们是运行态开关，和配置内容混在一起反而藏得住误触。
 */
export function TaskEditorDrawer({
  open,
  task,
  initialTab,
  onClose,
  onSaved,
}: {
  open: boolean;
  task: SyncTask | null;
  /** 打开时落在哪个页签；控制面板点「3 校验」这段时用它直达 */
  initialTab?: TaskTab;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const { save } = useTaskMutations();
  // 两个候选清单都只是编辑期的辅助：取不到时输入框仍可自由手输，
  // 因为配置要能先于下游上线、也要能在注册中心不可达时保存。
  const { data: datasourceOptions = [] } = useDatasources();
  const { data: serviceOptions = [] } = useServices();

  const [tab, setTab] = useState<Tab>("match");
  const [name, setName] = useState("");
  const [spec, setSpec] = useState<TaskSpec>(() => newTask());
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = task ? cloneSpec(task.spec) : newTask();
    setSpec(next);
    setName(task?.name ?? "");
    setTab(initialTab ?? "match");
    setJsonText(JSON.stringify(next, null, 2));
    setJsonError(null);
  }, [open, task, initialTab]);

  const issues = useMemo(() => validateSpec(spec), [spec]);
  const byPath = useMemo(() => issuesByPath(issues), [issues]);
  const tabIssues = (key: Tab) => {
    switch (key) {
      case "target":
        return issues.filter((i) => i.path.startsWith("target"));
      case "match":
        return issuesUnder(byPath, "match");
      case "mapping":
        return issuesUnder(byPath, "mapping");
      case "actions":
        return issuesUnder(byPath, "actions");
      case "guards":
        return issuesUnder(byPath, "guards");
      case "outcomes":
        return issuesUnder(byPath, "outcomes");
      default:
        return [];
    }
  };

  const patch = (next: Partial<TaskSpec>) => {
    setSpec((current) => {
      const merged = { ...current, ...next };
      if (tab === "json") setJsonText(JSON.stringify(merged, null, 2));
      return merged;
    });
  };

  const submit = () => {
    if (issues.length > 0) {
      const first = issues[0];
      setTab(tabOfPath(first.path));
      toast.error(`还有 ${issues.length} 处配置问题`, first.message);
      return;
    }
    if (!name.trim()) {
      toast.error("缺少任务名称", "名称是列表里唯一的可读标识，别只留 code");
      return;
    }
    save.mutate(
      { id: task?.id, name: name.trim(), spec },
      {
        onSuccess: () => {
          toast.success(
            task ? "已保存，版本 +1" : "已创建（默认停用）",
            task
              ? "已通知各副本刷新执行器快照"
              : "启用开关在列表或控制面板卡片的右上角，确认配置后再打开",
          );
          onSaved?.();
          onClose();
        },
        onError: (error: Error) => toast.error("保存失败", error.message),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={980}
      title={task ? `编辑 ${task.code}` : "新建同步任务"}
      subtitle={task ? `v${task.version} · ${task.topic}` : "六段流水线一次配完，保存后自动通知各副本刷新"}
      badge={
        issues.length > 0 ? (
          <Badge tone="danger" dot>
            {issues.length} 处待修
          </Badge>
        ) : (
          <Badge tone="success" dot>
            校验通过
          </Badge>
        )
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-[11px] text-muted">
            {issues.length > 0 ? (
              <span className="flex items-center gap-1 text-danger">
                <TriangleAlert className="size-3.5" />
                {issues[0].path}：{issues[0].message}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success">
                <CircleCheck className="size-3.5" />
                结构校验通过；语义对不对要靠试跑
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<FlaskConical className="size-3.5" />}
              onClick={() => navigate(`/playground?topic=${encodeURIComponent(spec.topic)}`)}
            >
              去试跑
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      {/* 身份证区：任何页签下都可见。id / topic 的校验问题直接标在这里 */}
      <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-line bg-sunken/40 p-3">
        <Field
          label="任务标识 code"
          required
          hint="与 spec.id 同值；同一 topic 下唯一。库里的列说了算"
          error={byPath.get("id")?.[0]?.message}
        >
          <Input
            value={spec.id ?? ""}
            spellCheck={false}
            className="h-9 font-mono text-[12.5px]"
            onChange={(e) => patch({ id: e.target.value })}
          />
        </Field>
        <Field label="名称" required hint="列表里给人看的那一行">
          <Input value={name} className="h-9" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="topic"
          required
          hint="sink 的 topics 里配的名字；自拉数据用 source:{code}"
          error={byPath.get("topic")?.[0]?.message}
        >
          <Input
            value={spec.topic}
            spellCheck={false}
            className="h-9 font-mono text-[12.5px]"
            onChange={(e) => patch({ topic: e.target.value })}
          />
        </Field>
        <Field label="优先级" hint="升序匹配，小的先命中">
          <Input
            type="number"
            value={spec.priority}
            className="h-9 tnum"
            onChange={(e) => patch({ priority: Number(e.target.value) })}
          />
        </Field>
      </div>

      <nav className="sticky -top-4 z-10 -mx-5 mb-4 flex items-center gap-1 border-b border-line bg-surface px-5 pb-2 pt-1">
        {TABS.map((item) => {
          const count = tabIssues(item.key).length;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                if (tab === "json" && item.key === "json") return;
                if (item.key === "json") setJsonText(JSON.stringify(spec, null, 2));
                setTab(item.key);
              }}
              className={cn(
                "relative inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors",
                active
                  ? "bg-accent-soft font-medium text-accent-strong"
                  : "text-ink-soft hover:bg-ink/[0.05] hover:text-ink",
              )}
            >
              {item.stage !== "—" && (
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded font-mono text-[9.5px]",
                    active ? "bg-accent/15 text-accent-strong" : "bg-ink/[0.06] text-muted",
                  )}
                >
                  {item.stage}
                </span>
              )}
              {item.label}
              {count > 0 && (
                <span className="flex size-4 items-center justify-center rounded-full bg-danger text-[9.5px] font-semibold text-white">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "match" && (
        <div className="space-y-3">
          <SectionIntro
            title="匹配"
            body="回答「这条记录归不归我管」。全部条件满足才算命中；要表达「或」，加一个「任意满足」分组，分组还能嵌套。空条件表示该 topic 全收。"
          />
          <AssertEditor
            conditions={spec.match ?? []}
            onChange={(match) => patch({ match })}
            pathPrefix="match"
            issues={byPath}
            defaultScope="record"
            emptyHint="没有条件：这个 topic 的所有记录都归本任务"
          />
        </div>
      )}

      {tab === "mapping" && (
        <div className="space-y-3">
          <SectionIntro
            title="映射"
            body="记录 → 请求体，逐行取字段。没有分支：按来源分变体的逻辑应上移到匹配段拆成任务。"
          />
          <div className="flex items-center justify-between rounded-lg border border-line bg-sunken/40 px-3 py-2">
            <div>
              <p className="text-[12.5px] font-medium text-ink">来源为 null 时省略整行</p>
              <p className="text-[11px] text-muted">关掉则写成 null 保留键；这是全局语义，不逐行配</p>
            </div>
            <Switch
              checked={spec.mapping.omit_null ?? true}
              label="omit_null"
              onChange={(omit_null) => patch({ mapping: { ...spec.mapping, omit_null } })}
            />
          </div>
          <MappingEditor
            rows={spec.mapping.rows}
            omitNull={spec.mapping.omit_null ?? true}
            onChange={(rows) => patch({ mapping: { ...spec.mapping, rows } })}
            pathPrefix="mapping.rows"
            issues={byPath}
          />
        </div>
      )}

      {tab === "actions" && (
        <div className="space-y-3">
          <SectionIntro
            title="动作"
            body="op → 一次 HTTP 调用。四种 op 各一个动作，路径相对 target.base。"
          />
          <ActionEditor
            actions={spec.actions ?? []}
            onChange={(actions) => patch({ actions })}
            pathPrefix="actions"
            issues={byPath}
          />
        </div>
      )}

      {tab === "guards" && (
        <div className="space-y-3">
          <SectionIntro
            title="校验"
            body="发送前的最后一道闸：只回答「能不能发」。要看清洗后的报文，断言的 scope 选 body。"
          />
          <GuardEditor
            guards={spec.guards ?? []}
            onChange={(guards) => patch({ guards })}
            pathPrefix="guards"
            issues={byPath}
          />
        </div>
      )}

      {tab === "outcomes" && (
        <div className="space-y-3">
          <SectionIntro
            title="判定"
            body="投递的响应 → 结论（第 6 步）。有序、首命中即停；分类码会进死信，也是判断「能否改报文重投」的依据。"
          />
          <OutcomeEditor
            outcomes={spec.outcomes ?? []}
            onChange={(outcomes) => patch({ outcomes })}
            pathPrefix="outcomes"
            issues={byPath}
          />
        </div>
      )}

      {tab === "target" && (
        <div className="space-y-3">
          <SectionIntro
            title="投递（第 5 步）"
            body="前四段决定发什么，这里决定往哪儿投；投完由判定段（第 6 步）看响应定结论。候选清单只是辅助输入：服务可能还没注册、数据源也可能先配好，所以两处都保留手输。"
          />

          <div className="space-y-3 rounded-lg border border-line bg-sunken/30 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="投递方式" hint="前四段完全共用，只是出口配置不同">
                <Select
                  className="w-full font-mono text-[12.5px]"
                  value={spec.target.kind ?? "http"}
                  onChange={(e) =>
                    patch({ target: { ...spec.target, kind: e.target.value as "http" | "db" } })
                  }
                >
                  <option value="http">http — 调下游接口</option>
                  <option value="db">db — 直写下游库表</option>
                </Select>
              </Field>
              <div className="flex items-end pb-1 text-[11px] leading-relaxed text-muted">
                {spec.target.kind === "db"
                  ? "映射的 to 就是列名，值绑参数写进目标表；没有 HTTP 请求，判定段看 { affected: n }。"
                  : "服务名只作服务发现的键，host 由执行器按环境解析，不拼进 URL。"}
              </div>
            </div>

            {spec.target.kind === "db" ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="数据源"
                    required
                    hint="从数据源清单里选，或手输 code；连接串在数据源页维护"
                    error={byPath.get("target.datasource")?.[0]?.message}
                  >
                    <SuggestInput
                      value={spec.target.datasource ?? ""}
                      placeholder={datasourceOptions[0]?.code ?? "dtw"}
                      options={datasourceOptions.map((d) => ({ value: d.code, hint: d.name }))}
                      unit="数据源"
                      footNote="，点一条即填入；也可手输 code"
                      emptyText="还没有维护数据源。到「数据源」页登记后这里会自动出现，也可以直接手输 code。"
                      onChange={(v) => patch({ target: { ...spec.target, datasource: v } })}
                    />
                  </Field>
                  <Field
                    label="目标表"
                    required
                    hint="table 或 schema.table，只允许小写字母/数字/下划线"
                    error={byPath.get("target.table")?.[0]?.message}
                  >
                    <Input
                      value={spec.target.table ?? ""}
                      spellCheck={false}
                      className="h-9 font-mono text-[12.5px]"
                      onChange={(e) => patch({ target: { ...spec.target, table: e.target.value } })}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="冲突键"
                    required
                    hint="逗号分隔；c/r/u 走 on conflict，d 按它删除"
                    error={byPath.get("target.key")?.[0]?.message}
                  >
                    <Input
                      value={(spec.target.key ?? []).join(",")}
                      spellCheck={false}
                      className="h-9 font-mono text-[12.5px]"
                      placeholder="id"
                      onChange={(e) =>
                        patch({
                          target: {
                            ...spec.target,
                            key: e.target.value
                              .split(",")
                              .map((k) => k.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="冲突处理" hint="update = upsert；nothing = 保留已有行">
                    <Select
                      className="w-full font-mono text-[12.5px]"
                      value={spec.target.on_conflict ?? "update"}
                      onChange={(e) =>
                        patch({
                          target: {
                            ...spec.target,
                            on_conflict: e.target.value as "update" | "nothing" | "error",
                          },
                        })
                      }
                    >
                      <option value="update">update — 覆盖其余列</option>
                      <option value="nothing">nothing — 什么也不做</option>
                      <option value="error">error — 报错交给判定段</option>
                    </Select>
                  </Field>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="目标服务"
                  required
                  hint="可从注册中心已登记的服务里选，也可直接手输服务名"
                  error={byPath.get("target.service")?.[0]?.message}
                >
                  <SuggestInput
                    value={spec.target.service ?? ""}
                    placeholder={serviceOptions[0]?.name ?? "dtw-rs-svr"}
                    options={serviceOptions.map((s) => ({
                      value: s.name,
                      hint: s.healthy ? `${s.healthy} 个健康实例` : undefined,
                    }))}
                    footNote="，点一条即填入；也可手输未登记的服务名"
                    emptyText="没拉到注册中心的服务清单（未配置或暂时不可达）。直接手输服务名即可，配置不依赖「编辑时注册中心里有什么」。"
                    onChange={(v) => patch({ target: { ...spec.target, service: v } })}
                  />
                </Field>
                <Field
                  label="路径前缀"
                  required
                  hint="必须以 / 开头"
                  error={byPath.get("target.base")?.[0]?.message}
                >
                  <Input
                    value={spec.target.base ?? ""}
                    spellCheck={false}
                    className="h-9 font-mono text-[12.5px]"
                    onChange={(e) => patch({ target: { ...spec.target, base: e.target.value } })}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* 候选为空/有候选的说明都由 SuggestInput 自己给出：空时一行提示，
              有候选时写在下拉面板底部，避免页面上再重复一段同样的字。 */}
        </div>
      )}

      {tab === "json" && (
        <div className="space-y-2">
          <SectionIntro title="JSON" body="整份 spec 的原文。批量改或从别处粘贴时用它，改完点「应用到表单」。" />
          <Textarea
            rows={26}
            value={jsonText}
            spellCheck={false}
            onChange={(e) => setJsonText(e.target.value)}
            className="font-mono text-[11.5px] leading-relaxed"
          />
          {jsonError && (
            <p className="flex items-center gap-1 text-[11.5px] text-danger">
              <CircleX className="size-3.5" />
              {jsonError}
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              try {
                const parsed = JSON.parse(jsonText) as TaskSpec;
                setSpec(parsed);
                setJsonError(null);
                toast.success("已应用到表单");
              } catch (error) {
                setJsonError(error instanceof Error ? error.message : "JSON 解析失败");
              }
            }}
          >
            应用到表单
          </Button>
        </div>
      )}
    </Modal>
  );
}

function SectionIntro({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-line/80 bg-sunken/50 px-3 py-2">
      <p className="text-[12.5px] font-medium text-ink">{title}</p>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}
