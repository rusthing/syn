import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck, CircleX, FlaskConical, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Drawer";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import type { Action, SyncTask, TaskSpec } from "@/lib/api/types";
import { cloneSpec, dbRules, emptyAction, newTask } from "@/lib/spec/defaults";
import { issuesByPath, issuesUnder, validateSpec } from "@/lib/spec/validate";
import { AssertEditor } from "@/components/spec/AssertEditor";
import { MappingEditor } from "@/components/spec/MappingEditor";
import { ActionEditor } from "@/components/spec/ActionEditor";
import { GuardEditor } from "@/components/spec/GuardEditor";
import { rulesForEditing } from "@/lib/spec/rules";
import { useAllTasks, useTaskMutations } from "@/hooks/use-tasks";
import { useDatasources, useServices } from "@/hooks/use-sources";
import { TaskStageRail } from "./TaskStageRail";
import { VerdictEditor } from "./verdict/VerdictEditor";
import { STAGES, stageExists, tabOfPath, type TaskTab } from "./task-stages";

/** 控制面板按这个类型直达某一段，历史入口保留在本模块上 */
export type { TaskTab } from "./task-stages";

type Tab = TaskTab;

/**
 * 任务编辑窗体。
 *
 * 没有独立的基本页签：名称 / topic / 排序值常驻窗体顶部，
 * 任何段下都看得到；六段配置在左侧轨道上点选，右侧一次只编辑一段（见 TaskStageRail）。
 * 启用 / 独占不在表单里 —— 启用在卡片右上角、独占在连线落点（控制面板），
 * 它们是运行态开关，和配置内容混在一起反而藏得住误触。
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
  // 切到 db 时把 http 的动作暂存起来：动作在 db 下无效（保存期要求为空），
  // 但用户切回 http 时不该发现自己刚配的四态矩阵被抹掉了
  const httpActions = useRef<Action[]>([]);

  const { data: allTasks } = useAllTasks();
  // 用 ref 读最新列表：把 allTasks 放进依赖里，列表一到就会把正在填的草稿重置掉
  const siblings = useRef<SyncTask[]>([]);
  siblings.current = allTasks ?? [];

  useEffect(() => {
    if (!open) return;
    // 新建时排到同主题末尾：同一主题下 sort_order 才有意义，跨主题比大小没有语义
    const next = task
      ? cloneSpec(task.spec)
      : newTask(
          "dtw.region",
          siblings.current
            .filter((t) => t.topic === "dtw.region")
            .reduce((max, t) => Math.max(max, t.sort_order), 90) + 10,
        );
    setSpec(next);
    setName(task?.name ?? "");
    httpActions.current = next.target.kind === "db" ? [] : (next.actions ?? []);
    // 直达的段可能不存在（db 任务没有动作段）：退回投递段，别停在空白页
    const wanted = initialTab ?? "match";
    setTab(stageExists(next, wanted) ? wanted : "target");
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
        // 判定段两套形状都要收：未升级的任务问题挂在 outcomes，升级后挂在 rules
        return [...issuesUnder(byPath, "outcomes"), ...issuesUnder(byPath, "rules")];
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

  /**
   * 换投递方式。
   *
   * 动作依附于出口：db 直写没有动作段（执行器不读、保存期要求为空），所以切到 db
   * 时清空并把原动作暂存；切回 http 时原样恢复，没暂存过就给两态默认值。
   * 判定段**不动**：那是用户可能手调过的语句树，要换口径由他点「套用 db 模板」。
   */
  const switchTargetKind = (kind: "http" | "db") => {
    if (kind === "db") {
      httpActions.current = spec.actions ?? [];
      patch({ target: { ...spec.target, kind }, actions: [] });
      if (tab === "actions") setTab("outcomes");
      return;
    }
    patch({
      target: { ...spec.target, kind },
      actions:
        httpActions.current.length > 0
          ? httpActions.current
          : [emptyAction("c"), emptyAction("r")],
    });
  };

  /** 进入 JSON 段时从当前 spec 重新生成原文；已在 JSON 段则不要覆盖未应用的编辑 */
  const selectTab = (key: Tab) => {
    if (tab === "json" && key === "json") return;
    if (key === "json") setJsonText(JSON.stringify(spec, null, 2));
    setTab(key);
  };

  const submit = () => {
    if (issues.length > 0) {
      const first = issues[0];
      // db 任务的 actions 问题没有对应页签（动作段已隐藏），送到投递段看说明
      const wanted = tabOfPath(first.path);
      setTab(stageExists(spec, wanted) ? wanted : "target");
      toast.error(`还有 ${issues.length} 处配置问题`, first.message);
      return;
    }
    if (!name.trim()) {
      toast.error("缺少任务名称", "名称是任务唯一的可读标识，列表与日志都靠它");
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
      height={720}
      scroll={false}
      title={task ? `编辑 ${task.name}` : "新建同步任务"}
      subtitle={task ? `v${task.version} · ${task.topic}` : "流水线一次配完，保存后自动通知各副本刷新"}
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
      {/* 身份证区：任何页签下都可见。名称 / topic 的校验问题直接标在这里 */}
      <div className="mb-4 grid shrink-0 grid-cols-3 gap-3 rounded-lg border border-line bg-sunken/40 p-3">
        <Field
          label="名称"
          required
          hint={task ? "任务的唯一可读标识；重名只能靠 ID 区分" : "任务的可读标识，列表、投递记录、日志都按它指代"}
        >
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
        <Field label="排序值" hint="同一主题内升序，小的先命中；默认排到末尾 +10">
          <Input
            type="number"
            value={spec.sort_order}
            className="h-9 tnum"
            onChange={(e) => patch({ sort_order: Number(e.target.value) })}
          />
        </Field>
      </div>

      {/*
        六段轨道在左、当前段的设置在右。整块贴到窗体边缘（抵消滚动容器的内边距），
        左侧自己带底色和竖分隔，看起来才是「一条轨道 + 一张工作台」而不是两个卡片。
      */}
      <div className="-mx-5 -mb-4 grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)] border-t border-line">
        <div className="min-h-0 overflow-y-auto">
          <TaskStageRail
            tab={tab}
            spec={spec}
            issueCount={(key) => tabIssues(key).length}
            onSelect={selectTab}
          />
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto px-5 py-4">
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
              <p className="text-[11px] leading-snug text-muted">
                来源为 null（含路径不存在）怎么发，由每行的
                <span className="font-mono"> null </span>
                列决定：省略让下游保持原值，写 null 才是要清空字段。
              </p>
              <MappingEditor
                rows={spec.mapping.rows}
                onChange={(rows) => patch({ mapping: { ...spec.mapping, rows } })}
                pathPrefix="mapping.rows"
                issues={byPath}
              />
            </div>
          )}

          {stageExists(spec, "actions") && tab === "actions" && (
            <div className="space-y-3">
              <SectionIntro
                title="动作（第 5 步）"
                body="op → 一次 HTTP 调用。四种 op 各一个动作，路径相对投递段的 base —— 所以投递先配。db 直写没有这一段：op 由记录自带，写库形状看 on_conflict。"
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
                title="判定（第 6 步）"
                body="投递的响应 → 结论。语句从上往下执行、首个命中即停；if 多分支、switch 按字段分流，分支体里还能再放语句。分类码会进死信，也是判断「能否改报文重投」的依据。"
              />
              {spec.target.kind === "db" && (
                <div className="flex items-start gap-3 rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] leading-relaxed text-warn">
                  <div className="min-w-0 flex-1">
                    db 直写没有下游响应：判定看到的是写库结果的合成响应{" "}
                    <code className="font-mono">{"{ affected: n }"}</code>，status 恒为 200、
                    也看不到记录。所以这里只能看 <code className="font-mono">$.affected</code>
                    （写进去的行数）；按 status 或报文体别的字段写规则，保存时会被拒。
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => patch({ rules: dbRules(), outcomes: undefined })}
                  >
                    套用 db 模板
                  </Button>
                </div>
              )}
              {(spec.rules ?? []).length === 0 && (spec.outcomes ?? []).length > 0 && (
                <div className="rounded-lg bg-info-soft px-3 py-2 text-[11.5px] leading-relaxed text-info">
                  这个任务还是旧的扁平规则，已按语句树展示：每条规则 = 一个单分支的{" "}
                  <code className="font-mono">if</code>，末尾那条「失败 · UNCLASSIFIED」是执行器原来就有的隐式兜底
                  —— 现在显式写出来，判定结果不变。第一次修改会存成语句树（
                  <code className="font-mono">spec.rules</code>），旧字段不再写回。
                </div>
              )}
              <VerdictEditor
                spec={spec}
                rules={rulesForEditing(spec)}
                onChange={(rules) => patch({ rules, outcomes: undefined })}
                issues={byPath}
                onOpenJson={() => selectTab("json")}
              />
              <p className="text-[10.5px] leading-relaxed text-muted">
                每个块的最后一条语句必须「必然给出结论」（结论 / 带否则的 if / 带 default 的 switch）：
                没被任何语句命中的响应会按 <code className="font-mono">UNCLASSIFIED</code> 致命处理，不能静默成功。
                <span className="ml-1 text-ink-soft">用行尾的 ↑/↓ 调整优先级；chevron 只折叠显示，不改判定。</span>
              </p>
            </div>
          )}

          {tab === "target" && (
            <div className="space-y-3">
              <SectionIntro
                title="投递（第 4 步）"
                body="先定往哪儿投，再定动作的形状（第 5 步）。出口一换，后面的段跟着变：http 要四态动作、判下游真实响应；db 直写没有动作段、判定只看写进去的行数。候选清单只是辅助输入：服务可能还没注册、数据源也可能先配好，所以两处都保留手输。"
              />

              <div className="space-y-3 rounded-lg border border-line bg-sunken/30 p-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="投递方式" hint="前四段完全共用，只是出口配置不同">
                    <Select
                      className="w-full font-mono text-[12.5px]"
                      value={spec.target.kind ?? "http"}
                      onChange={(e) => switchTargetKind(e.target.value as "http" | "db")}
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
        </div>
      </div>
    </Modal>
  );
}

/**
 * 右侧工作台的抬头 + 一段说明。段名和「n / 6」在盒子外面，说明单独成盒：
 * 抬头要跟左侧选中的那一段对得上，说明只是配之前先读的一句话。
 */
function SectionIntro({ title, body }: { title: string; body: string }) {
  const index = STAGES.findIndex((s) => s.label === title);
  return (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        <span className="font-mono text-[11px] text-muted">
          {title === "JSON" ? "高级" : `${index + 1} / ${STAGES.length - 1}`}
        </span>
      </div>
      <div className="rounded-lg border border-line/80 bg-sunken/50 px-3 py-2">
        <p className="text-[11.5px] leading-relaxed text-muted">{body}</p>
      </div>
    </>
  );
}
