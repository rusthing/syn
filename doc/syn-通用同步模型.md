# syn 通用同步模型

> 定位：**把任意来源的一条数据，按可配置规则，同步到任意下游。**
>
> 不是消息总线（不做广播语义），不是 ETL（不做跨表 join 与聚合），不是工作流引擎
> （不编排多步依赖）。

> **相关文档**
> - 落地写法与工程纪律：[`syn-开发规范.md`](./syn-开发规范.md)
> - 数据模型（LDM 是事实来源）：`model/syn.ldm` → `model/syn-pgsql.pdm` → `model/create-table-pgsql.sql`

---

## 1. 三段式

```
来源 ──▶ 取数（push / poll）──记录流──▶ 匹配 → 映射 → 校验 → 投递 → 动作 → 判定
```

- **取数**决定「记录从哪来、什么形态」；
- **匹配 / 映射 / 校验**是纯函数，不认识来源也不认识目标；
- **投递**（`target.kind`）只声明出口 —— http 服务，或 db 的数据源 + 表 + 冲突策略，是唯一有 IO 的地方；
- **动作**把出口具体成「一次调用长什么样」：http 是四态矩阵（`c` / `r` / `u` / `d` 各自的
  method / path / query / headers / body）；**db 直写没有这一段** —— `op` 由记录自带，
  写库形状由 `on_conflict` 决定；
- **判定**看投递的响应定结论。http 看得见 status / headers / body 与记录；db 直写看到的
  只有合成响应 `{ affected: n }`（status 恒 200、记录为空），所以规则只许读 `$.affected`。

所以：**http 六段、db 五段**。顺序上「投递」排在「动作」之前，理由只有一条 —— 依赖方向：
动作的 `path` 是相对 `target.base` 拼出来的，db 的写库形状由 `on_conflict` 决定，出口
不定，第 5 段无从谈起。先定出口，再定形状，最后定结论。保存期校验把这条落成硬约束：
`kind = db` 时 `actions` 必须为空（留着就是永远不会被读的配置），判定段也只许出现
`$.affected`（`syn-api::validate_actions` / `validate_db_verdict`，前端 `validateSpec` 同构）。

关键：`poll` 把一批数据写进数据抽取自己声明的**虚拟 topic**（形如 `source:dtw_region`，
`topic` 是 `syn_source` 必填且唯一的业务键）。任务通过 `topic` 关联，所以**匹配 / 映射 /
校验完全不需要知道这条记录是推来的还是拉来的**。这是整个设计里最省事的一刀。

---

## 2. 取数：三种方案，选 SQL 轮询

| 方案 | 做法 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| A 自建 CDC | 自己解析 binlog / WAL | 实时、无侵入 | offset、DDL 变更、类型映射、快照切换，等于重做 Debezium | **否决** |
| B 复用 Debezium + sink | 现状（push） | 已跑通，实时，删改都捕获得到 | 依赖源库开 binlog、依赖 Kafka 链路 | **保留** |
| C SQL 轮询 | `where (cursor, tie) > ? order by cursor, tie limit N` | 一条 SQL 就够；能补历史；能跨 MySQL/PG；不要求源库开 binlog | 非实时（秒~分钟）；捕获不到删除；要求可靠单调列 + 唯一决胜列 | **推荐** |
| D HTTP 分页 | 调上游接口按 page/token 翻页 | 第三方数据只能这样 | 对方接口质量决定一切；限流要自己扛 | 支持（次要） |

### 2.1 为什么 C 值得做

CDC 做不好的两件事，正好是轮询擅长的：

1. **历史数据初始化**：新接一个下游，要先把存量灌一遍。CDC 只能从「现在」开始；
2. **定期对账**：CDC 漏了（下游挂了超过保留期、DLQ 被清）没法自动补，轮询重扫一遍就补上了。

### 2.2 必须写死的四条约束（不写清楚一定踩）

1. **游标列必须单调且可比较**。`updated_at` 单独不够：并发事务的提交顺序与时间戳顺序
   不一致，会漏行。用 `(updated_at, id)` 复合游标，并且**回退 5 秒重叠重读**
   （`where (updated_at,id) > (cursor_ts, cursor_id) and updated_at <= now() - 5s`），
   重复由下游 upsert 吸收。
2. **删除捕获不到**。要么源表有软删标记（推荐），要么定期全量对账（P5）。
   这是轮询的固有缺陷，不能假装没有。
3. **多副本必须选主**。两个实例同时拉 = 重复投递 + 游标互相覆盖。
4. **游标存 syn 库，不存源库**。不污染业务库，也不受源库权限限制。
5. **全量快照只用于初始化**。SQL 轮询除了「游标增量」，还支持「全量快照」：填表名即可，
   系统生成 `SELECT *`，拉完写 `{"snapshot":{"done":true,"rows":n}}` 后停止。
   它和 CDC 增量不能并行写同一张表，理由与 http 全量相同（见 `syn-开发规范.md` §11 第 14 条）。
6. **表名不够用时可手写 SQL**。`spec.sql` 填一条 `select` / `with` 就替代表名，执行器把它当
   子查询再套游标条件与 `LIMIT`；因此输出的列里必须带主游标字段与决胜字段（别名要对得上）。

### 2.3 调度归属

| 选项 | 做法 | 评价 |
|---|---|---|
| a | syn 进程内 `tokio::interval` + PG advisory lock 选主 | 简单，但「写库类周期任务归 jobx」的约定被破坏，多副本抢锁也不好观测 |
| b | jobx 定时打 `POST /syn/source/{id}/pull` | **推荐**：天然单点触发、有执行历史、失败可见；syn 不需要依赖 jobx 的 Rust 客户端，一个 HTTP 端点即可 |

b 的唯一代价是 jobx 要配一条计划任务，换来的是一整套现成的调度观测。

---

## 3. 1:N 拆分：拆记录，不编排调用

**不做**「先调主表、拿返回 id 再调明细」这种编排 —— 那需要状态机、需要补偿、需要
「依赖前一次响应」的表达式，复杂度会翻十倍。

做法：**在记录流上拆**。

```yaml
split:
  from: "$.after.items[*]"   # 子记录来源
  alias: item                 # 子记录挂到 $.item
  keep_parent: true           # 父记录挂到 $.parent
```

一条父记录 → N 条子记录 → **每条独立走匹配 / 映射 / 投递**。

好处：

- 子记录可以命中**另一个任务**（复用「一 topic 多任务」），主表一次 + 明细 N 次天然成立；
- 失败粒度是一行明细，死信能定位到具体哪条；
- 不需要任何编排能力。

限制（明确写出来，避免被误用）：

- 子记录之间不能互相依赖；
- 需要父 id 时用 `$.parent.after.id`；
- 拆出来是 0 条时，父记录本身仍然走一遍（避免「主表没同步」）。

---

## 4. N:1 合并：只在 poll 批次内

push 入口**不做窗口合并**。原因很硬：sink 是单条提交 offset，你在内存里等 500ms 攒批，
进程挂了这批就丢了或重了，offset 语义直接坏掉。

合并只在 poll 批次内成立，因为批次本来就是一个整体：

```yaml
dispatch:
  mode: batch          # 默认 single
```

语义：一批 N 行 → 每行跑一遍 mapping → 装信封 `{"items":[...]}` → **一次**投递。
判定按整批算：成功推进游标，失败整批重投（幂等键 = 批次游标）。

---

## 5. 投递：http / db

### 5.1 http（现状）

```yaml
target: { kind: http, service: dtw-rs-svr, base: /dtw/region }
```

### 5.2 db 直写

```yaml
target:
  kind: db
  datasource: dtw          # 取 [syn.datasources.dtw]，每个下游一个账号
  table: public.dtw_person
  key: [id]                # 冲突键
  on_conflict: update      # update / nothing / error
```

- mapping 的 `to` 就是**列名**，值直接绑参数；
- 表名、列名走**白名单**（启动时从 `information_schema` 读一次 + 配置显式声明），
  绝不拼接 SQL 片段；
- 批量时按 key 分块生成 `insert ... on conflict do update set ...`；
- 一个批次一个事务。

db 与 http 有两处**不是同一份语义**，照抄会写出恒真/恒假的死配置：

- **没有动作段**。`op` 由记录自带，写库形状由 `on_conflict` 决定，`method` / `path` /
  `query` / `headers` / `body_mode` 在这里一个消费者都没有。留着只是让人以为它能改直写行为，
  所以 `actions` 必须为空。
- **判定只看 `$.affected`**。写库成功后执行器合成 `200 + { affected: n }` 再交给判定段：
  status 恒 200、记录为空、报文只有 affected。`on_conflict: nothing` 撞键时 `affected = 0`，
  这就是 db 唯一的「没写进去」信号。

**必须承认的边界**：HTTP 与 DB 不在同一个事务里，跨协议同步只能做到 at-least-once，
去重靠下游（DB 靠 `on conflict`，HTTP 靠幂等键）。这不是设计缺陷，是物理限制。

---

## 6. 为什么加了这么多还叫「简单」

三条「不引入」：

1. **不引入表达式语言**。取值是 JSONPath 子集，变换是封闭注册表，条件是一棵布尔树：
   数组即 AND，元素可以是 `all` / `any` / `not` 分组，分组可嵌套，但仍然是数据、不是脚本
   —— 保存期能逐节点校验，界面能逐行编辑，前后端能各写一份同构求值。
2. **不引入编排**。拆分在记录流上做，合并只在批次内做，没有「第 N 步依赖第 N-1 步」。
3. **不引入脚本**。现有三条链路 710 行 magic-api 脚本，全部落在配置里；
   真要脚本时（跨记录聚合）再开逃生门，默认关闭。

规则段仍然只占 `syn_task.spec` 一个 JSONB 列，不拆从表。新增的 `split` /
`dispatch` / `target.kind` 都是**声明式开关**，
不是流程控制。

---

## 7. 数据模型

| 表 | 用途 |
|---|---|
| `syn_task` | 整份任务规则（`target` / `match` / `mapping` / `guards` / `actions` / `rules`）+ topic/sort_order/enabled |
| `syn_task_version` | 不可变版本快照，回滚只是指回去 |
| `syn_source` | 数据抽取定义（kind/mode/topic/interval/batch/spec，spec 内可含手写 sql） |
| `syn_cursor` | 每个数据抽取的水位 + 最近一次错误 |
| `syn_idem` | 幂等记账（task_id + idem_key） |

`syn_source.topic` 由配置人填写（形如 `source:dtw_region`），既作任务关联键，也作
数据抽取在控制面板上的节点标识；任务照常按 topic 关联，规则段不用改。

---

## 8. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0 | push → http，3 条链路与 magic-api 影子比对 | 请求体逐字节一致（除已知的两处修正） |
| P1 | **db 直写** | 本地起 PG，一条 upsert 链路跑通，列名白名单生效 |
| P2 | poll-sql + 游标 + jobx 触发 | 复合游标不漏行（含回退重叠）；多副本只有一个在拉 |
| P3 | split | 主子表 1:N，子记录命中另一个任务 |
| P4 | batch | 500 行合一次，失败整批重投且不重复写 |
| P5 | poll-http + 全量对账 | 第三方接口接入；对账能补回 CDC 漏掉的行 |

P1 先做，因为它是纯本地的、当天能验收的，而且「不经下游服务直接写表」这个能力
一旦有了，很多临时同步需求就不必再写 Java 脚本。

---

## 9. 已拍板的取舍

1. **调度用 jobx 打端点** —— 已按 §2.3 的 b 落地：`POST /syn/source/{id}/pull` 由 jobx
   计划任务按 5s 打一拍，进程内没有调度器，也没有打开它的开关。
2. **DB 直写的账号粒度**：一个下游一个数据源（权限最小）。`[syn.datasources.<name>]`
   是唯一入口，控制台只存名字不存连接串。
3. **`syn_idem` 的键由谁生成**：sink 侧传 `X-Idempotency-Key`（`topic:partition:offset`），
   syn 不自己拼；不带键就不记账，不猜。
4. **判定段是语句树，不是扁平规则表** —— 语句只有 `if` / `switch` / 结论三种，
   分支体里放语句列表，所以嵌套不需要额外语法。落地方式：`spec.rules` 是新形状，
   `spec.outcomes` 保留为只读兼容（加载时映射成一串单分支 `if`，保存只写 `rules`）。
   语义与旧实现逐位一致：首个命中即返回，全都没命中仍然是 `UNCLASSIFIED` 致命；
   差别只有一条——**每个分支体必须以「必然给出结论」的语句收尾**，否则校验就拦，
   因为「命中了一半却没有结论」在配置里没有合法解释。

下游地址不在配置里：`target.service` 只是服务名，运行时由框架的共享选址层解析
（`robotech::micro_svc::instance_resolver`，Feign 客户端也用同一份实例快照）；
`syn-svr/src/registry.rs` 只做服务名校验与「0 实例 → fatal」的适配。
