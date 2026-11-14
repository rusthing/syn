# syn 开发规范

> 这份规范是 `robotech-rs` 框架约定 + `rusthing` 下各微服务（`adm-rs` / `alarm` / `dbz` / `dtw-rs` / `jobx` / `msg` / `oss-rs`）的既有做法里提炼出来的**一套**写法。
> 兄弟服务之间本来存在差异的地方（例如备用键是否再建索引），本文明确选一个并写清理由。
> 与本规范冲突的代码，改代码不改规范；规范本身要改，先在本文里改，再改代码。

目录

1. [工程结构](#1-工程结构)
2. [从模型开始的开发顺序](#2-从模型开始的开发顺序)
3. [命名规约](#3-命名规约)
4. [数据模型规范](#4-数据模型规范)
5. [配置规范](#5-配置规范)
6. [分层职责](#6-分层职责)
7. [接口规约](#7-接口规约)
8. [迁移规范](#8-迁移规范)
9. [质量门](#9-质量门)
10. [仓库与提交](#10-仓库与提交)
11. [syn 的取舍](#11-syn-的取舍)
12. [检查清单](#12-检查清单)
13. [当前落地进度](#13-当前落地进度)
14. [前端规范（`syn-web`）](#14-前端规范syn-web)
15. [真库端到端联调（`tests/e2e`）](#15-真库端到端联调testse2e)

---

## 1. 工程结构

一个服务是一个**独立 workspace**（仓库根没有统一 Cargo 工作区），内部按 crate 拆：

| crate | 职责 | 依赖约束 |
|---|---|---|
| `xxx-api` | 契约层：`mo`（SeaORM 实体）、`dto`、`vo`、`dic`（字典枚举）、`cst`（常量） | 只依赖 `robotech`（`macros` + `openapi`）；`mo` / 校验由 `server` feature 开启 |
| `xxx-api-client` | Rust 侧调用封装（`#[feign]` + `#[api_client]`） | 依赖 `xxx-api` |
| `xxx-svr` | 服务本体：`config` / `dao` / `svc` / `web` / `utils` | 依赖 `xxx-api`（`server`）、`robotech`（`db` + `macros` + `web`） |
| `xxx-web` | 前端工程（可选）：Vite + React，见 §14 | 不依赖 Rust crate，只按 §7 的 HTTP 契约调 svr |
| `model` | PowerDesigner 模型 + 建表脚本 | — |
| `doc` | 设计文档 | — |

`xxx-svr/build.rs` 是**必需文件**，不是可选项（见 §1.1）。

**什么时候建 `api-client`**：只有当**别的 Rust 服务**要调你时才建。`jobx` / `msg` / `alarm` / `dbz` / `dtw-rs` / `oss-rs` 都有；`capturer` / `gatex` / `iot` 没有。syn 现在的调用方是 Java 的 Kafka Connect sink 和 jobx 的 HTTP 任务，**没有 Rust 调用方，所以不建**；将来 `syn-web` 或别的 Rust 服务要写配置时再加。

`xxx-api/src/lib.rs` 固定这个形状：

```rust
pub mod dic;
pub mod dto;
pub mod vo;

#[cfg(feature = "server")]
pub mod mo;
```

`xxx-svr/src/lib.rs` 固定把契约层再导出一次，业务代码只 `use crate::dto::...`，不写 `use xxx_api::dto::...`：

```rust
pub mod config;
pub mod dao;
pub mod svc;
pub mod web;

pub use xxx_api::*;
```

`xxx-svr/src/web/mod.rs` 只导出 `api_doc` 与 `ctrl`（`router` 是靠 `linkme` 自注册的，不需要外部引用）：

```rust
mod api_doc;
mod ctrl;
mod router;

pub use api_doc::*;
pub use ctrl::*;
```

### 1.1 `build.rs`：运行期资源必须在二进制旁边

每个 `xxx-svr` 都有一份 `build.rs`，职责只有一件：把**运行期才读**的文件从 crate
根目录搬到 `target/<profile>/`（也就是可执行文件所在目录）。

| 来源 | 目标 | 谁在读 |
|---|---|---|
| `{pkg}.toml`、`{pkg}-dev/-test/-prod.toml` | 同名文件 | `bootstrap!` 按 `profile` 叠配置 |
| `log.toml` | `log.toml` | 日志过滤，靠主配置的 `[config] common-configs = ["log.toml"]` 挂载 |
| `migrations/` | 整目录 | `db_migrate!` 按库类型执行 |
| `cert/`（有才拷） | 整目录 | TLS |

为什么不能靠相对路径：`cargo run` 的工作目录是 crate 根，容器里的工作目录是镜像里
二进制所在目录。少了 `build.rs`，同一份代码两种行为 —— 本地起得来、容器里读不到
`migrations` 直接建不了表，而且报错发生在启动阶段，最费时间。

位置算法是固定的，抄现成的：

```rust
let out_dir = std::env::var("OUT_DIR").unwrap();      // target/<profile>/build/<pkg>-<hash>/out
let dest = Path::new(&out_dir).ancestors().nth(3).unwrap();  // → target/<profile>
```

三条约定：

1. 配置只用 `repo` 里的 `{pkg}.toml` 打底，生产由配置中心 KV 覆盖；两处键名必须一致。
   `log.toml` 不是自动生效的：主配置里写 `common-configs = ["log.toml"]` 才会被合并，
   不写就只是躺在二进制旁边。
2. 复制失败**不要** `unwrap`：`cert/` 可能整目录不存在，`migrations/*/.gitkeep` 也可能
   没权限；编译不该因为运行期资源挂掉。真正缺文件的问题交给启动时的报错。
3. **目录复制必须发 `cargo:rerun-if-changed=<目录>`**。build.rs 只要给任何一个文件发过
   `rerun-if-changed`（上面配置文件那一行），cargo 的「整包变化就重跑」默认行为就关了：
   此后改 `migrations/` 里的 SQL、`cargo build` 也只重编译不重拷贝，二进制旁边一直是
   旧脚本，联调建出来的表永远少一张、还不报错。2026-11-14 加 `syn_canvas_layout` 时
   实际踩中，e2e 断言「建表数」才暴露。
4. 新增一类运行期资源（如 `i18n/`）时改这里，不要在代码里拼 `../` 相对路径。

这不是假想问题：`syn-svr` 起初就没有 `build.rs`，`migrations` 只躺在源码目录里，
`cargo run` 一切正常，打进镜像后建表脚本就找不到了 —— 而报错发生在 `setup` 阶段，
看上去像「数据库连不上」。补文件的同时把这条写进 §12 的检查清单。

---

## 2. 从模型开始的开发顺序

**模型是事实来源，代码跟着模型走。** 顺序不能倒：

```
需求
 └─ model/xxx.ldm            逻辑模型：实体、属性、标识符、关系（与 DBMS 无关）
     └─ model/xxx-pgsql.pdm  物理模型：表、列、键、索引、外键（由 LDM 生成）
         └─ model/create-table-pgsql.sql   建表脚本（由 PDM 生成）
             └─ xxx-svr/migrations/pgsql/<时间戳>_create-table.sql   （拷贝，随版本冻结）
                 └─ xxx-api/src/mo/...     实体（与 PDM 逐列对齐）
                     └─ dto / vo / dao / svc / ctrl / router / api_doc
```

`model/` 下应有这些文件：

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `xxx.ldm` | ✅ | 逻辑模型，改设计的入口 |
| `xxx-pgsql.pdm` | ✅ | 物理模型，PG 目标 |
| `xxx.prj` | ✅ | PD 工程文件，`%[PRJ_ROOT_DIR]%` 靠它解析 |
| `create-table-pgsql.sql` | ✅ | 由 PDM 生成，**不要手改**（改了下次生成就丢） |
| `create-index-pgsql.sql` | 按需 | PD 表达不了的索引（部分索引、函数索引） |
| `*.ldb` / `*.pdb` / `*.pjb` | ❌ | PD 自动备份，已进 `.gitignore` |

**为什么先有 LDM 再有 PDM**：LDM 里没有 `INT8` / `VARCHAR(64)` 这些具体类型，只有 `LI` / `VA64` 这类逻辑类型。改「这个字段该不该存在」在 LDM 里做，改「这个字段多长」在 PDM 里做，两件事不该混在一次改动里。多 DBMS 目标时（`oss-rs` 有 mysql + pgsql 两份 PDM）也是同一个 LDM 派生。

**LDM 与 PDM 的类型对应**（本项目在用的全部）：

| LDM | PDM / PG | Rust（mo） | 用途 |
|---|---|---|---|
| `LI` | `INT8` | `i64` / `u64`（VO 侧） | 主键、时间戳、外键、计数 |
| `I` | `INT4` | `i32` | 优先级、版本号、批大小 |
| `SI` | `INT2` | `i16` | **字典枚举**（配 `@enum`） |
| `BL` | `BOOL` | `bool` | 开关 |
| `VA<n>` | `VARCHAR(n)` | `String` | 编码、名称、备注、Duration 文本 |
| `TXT` | `TEXT` | `String`（`column_type = "Text"`） | 长文本 |
| `JSONB` | `JSONB` | `Json`（`column_type = "JsonBinary"`） | 结构化配置 |

---

## 3. 命名规约

### 3.1 代码

框架的几个宏**从结构体名推导出模块名、路径、表名**，所以名字不是随便起的：

| 结构体 | 推导结果 | 例子 |
|---|---|---|
| `XxxYyySvc` | 调用 `XxxYyyDao` / `XxxYyyDto` / `XxxYyyVo` / `XxxYyy`（mo 实体） | `JobxGroupSvc` → `jobx_group_dao` / `jobx_group` |
| `XxxYyyCtrl` | 文件 `xxx_yyy_ctrl.rs`，同目录 `mod.rs` 里 `mod` | — |
| `XxxYyyRouter` | CRUD 路由前缀 `/{xxx}/{yyy}` | `JobxGroupRouter` → `/jobx/group` |
| `XxxYyyApiDoc` | OpenAPI 文档路径 `/{xxx}/{yyy}/openapi.json` | — |
| `XxxApiClient` | 配置中心 key `/{xxx}` | `MsgApiClient` → `msg` |

一个实体三个文件三行代码就够，**不要手写 CRUD**：

```rust
// dao/jobx_group_dao.rs
use robotech::macros::dao;
#[dao(unique_keys: [("name", "名称")], like_columns: [Column::Name, Column::Remark])]
pub struct JobxGroupDao;

// svc/jobx_group_svc.rs
use robotech::macros::svc;
#[svc]
pub struct JobxGroupSvc;

// web/ctrl/jobx_group_ctrl.rs
use robotech::macros::ctrl;
#[ctrl]
struct JobxGroupCtrl;

// web/router/jobx_group_router.rs
use robotech::macros::router;
#[router(crud)]
struct JobxGroupRouter;
```

文件名 = 结构体名的 snake_case，放在 `xxx-svr/src/{dao,svc,web/{ctrl,router,api_doc}}/`，每个目录一个 `mod.rs` 逐行 `mod xxx_yyy_dao; pub use xxx_yyy_dao::*;`。

### 3.2 数据库

| 对象 | 规则 | 例子 |
|---|---|---|
| 表 | `{模块}_{实体}`，snake_case | `syn_task` / `syn_task_version` |
| 列 | snake_case，**不加表名前缀** | `syn_task.code` 不是 `syn_task_code` |
| 主键 | 恒为 `id`，`INT8` | — |
| 主键约束 | `PK_{TABLE}` | `PK_SYN_TASK` |
| 唯一约束 | `AK_{COL1}[_AND_COL2]_{TABLE}` | `AK_CODE_SYN_TASK`、`AK_TASK_ID_AND_VERSION_SYN_TASK_VERSION` |
| 普通索引 | `idx_{table}_{列或用途}` | `idx_syn_idem_create_ms` |
| 外键 | `fk_{子表列}__from__{父表}` | `fk_task_id__from__syn_task` |

两点要知道：

1. **唯一约束名必须能被框架算出来**。`#[dao(unique_keys: [("name", "名称")])]` 生成的冲突判定按 `ak_{列名}_{表名}` 拼（PG 把未加引号的标识符统一成小写，所以 `AK_CODE_SYN_TASK` 与 `ak_code_syn_task` 是同一个）。多列用 `_and_` 连接。模型里 Key/Identifier 的 `Code` 就按这个拼（`task_id_and_version`），别写成中文或者 `Identifier_2`。
2. **外键名会重复**。PD 的外键模板只用到「子表列 + 父表」，所以 `syn_task_version` 和 `syn_idem` 的 `task_id` 外键同名。PG 的约束名只需在表内唯一，这是合法的，兄弟服务里 `fk_region_id__from__dtw_region` 重复了 8 次。**不要为了唯一去改名**，改了下次 PD 生成又变回来。

---

## 4. 数据模型规范

### 4.1 主键一律 `INT8`，业务标识用 `code` + 唯一键

所有表的主键都是 `INT8`、由 `idworker` 生成（`#[crud_dto]` 的 `id: Option<U64>`、`#[dao]` 的按 id 查询都假定这一点）。

人读的标识另立一列：

```sql
id    INT8  not null,     -- idworker，接口内部用
code  VARCHAR(64) not null,  -- 如 dtw_region，日志/配置/排障用
constraint AK_CODE_SYN_TASK unique (code)
```

不要用 `VARCHAR` 当主键——框架的 CRUD 宏、`Ro<PageRx<..>>`、Bean Searcher 兼容检索全都按 `U64` 的 `id` 走，字符串主键等于放弃这一整套。

### 4.2 审计四列：每张表都有，没有例外

```sql
creater_id INT8 not null,
create_ms  INT8 not null,
updater_id INT8 not null,
update_ms  INT8 not null,
```

原因不是「习惯」而是**硬约束**：`#[crud_dto]` 生成的 DTO 带 `_current_user_id` / `_current_ms`，`#[owned_into(ActiveModel)]` 会把它们映射到 `creater_id` / `updater_id` / `create_ms` / `update_ms`。少一列就编译不过。

- 业务 DTO **不带**这四列；控制器从请求头取 `X-User-Id` / `X-Current-Ms` 填进 `_current_user_id` / `_current_ms`。
- 无登录态的系统写入写 `0`（审计列里 `0` 表示「系统」）。
- 已经有了 `create_ms` 的表**不要再加**「记录时间」列（`syn_idem` 只保留审计四列，记账时间就是 `create_ms`）。

### 4.3 列注释即校验契约

`dto` 的 `@len` / `@range` 校验、`dic` 的枚举取值、文档里的单位，全部从**列注释**派生。改列宽必须同步改注释，否则校验和库对不上。

```sql
comment on column syn_task.code is
'任务编码
人写可读的稳定标识，配置、日志、排障都用它指代一条任务；接口按它查询
@len 1..=64';
```

| 注解 | 语义 | 对应实现 |
|---|---|---|
| `@len 1..=64` | 字符串长度区间（**字符数**，不是字节） | DTO 的 `#[validate(length(...))]` |
| `@range 0..=9999` | 数值区间 | DTO 的 `#[validate(range(...))]` |
| `@unit ms` | 单位 | 仅文档；时间戳一律毫秒，Duration 一律字符串 |
| `@enum Xxx default=Yyy` | 字典枚举名 + 默认变体 | `#[dic(default = Yyy)]` |
| `@check is_xxx` | 语义校验（URL、手机号等） | `robotech::api::validators` |

枚举的写法（`0=变体名  中文说明`，对齐成两列，方便和大驼峰变体名对照）：

```sql
comment on column syn_idem.verdict is
'该键上次的结论
@enum SyncVerdict default=Success
  0=Success    成功
  1=Skip       跳过（条件不满足，不是错误）
  2=Fatal      业务失败（不可重试）
  3=Retriable  暂时失败（可重试）';
```

注释第一行是**中文名**，与 `a:Name` 一致；第二行起是真正的说明；注解放最后。说明里写「为什么」和「什么时候会踩坑」，不要复述列名。

### 4.4 字典列用 `INT2`，不用 `VARCHAR`

字典（状态、类型、结论）在库里是 `INT2`，配 `#[dic]` 枚举：

```rust
#[dic(default = Manual)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, AsRefStr, Display, EnumString)]
#[strum(serialize_all = "kebab-case")]
pub enum JobType { Manual = 0, Cron = 1, FixedDelay = 2, FixedRate = 3 }
```

`#[dic]` 把 HTTP 层的表示统一成**整数**（不是变体名字符串），非法值反序列化直接报错、不静默回落。三条约定：

- **被 VO 使用的字典枚举必须写 `default`**：`#[vo]` 生成的是 `i16 → 枚举` 的 `From`，越界要有兜底变体。
- **列可空 ⇒ VO 字段必须写 `Option<枚举>`**。`#[dic]` 故意不生成 `From<Option<i16>>`，就是为了让「NULL 被当成某个状态」编译不过。
- 派生列表里**不要**再写 `Serialize` / `Deserialize` / `ToSchema` / `Default`，宏会摘掉。

### 4.5 什么时候用 `JSONB`，什么时候拆表

一列 `JSONB` 只在**同时满足**这三条时用：

1. 结构嵌套，拆成关系表会出现一堆只有一两行的从表；
2. 永远整体消费，**没有任何一层要参与检索/排序/分组**；
3. 变更频率与宿主行一致（改一个字节就整行重写，可以接受）。

`syn_task.spec`（五段规则）三条都满足。反过来，`topic` / `priority` / `enabled` / `exclusive` 要建索引、要排序，所以**提成关系列**，并且规定「以列为准，spec 里的同名字段只是导入来源」——两份数据不一致时行为不能取决于读取顺序。

`JSONB` 列在 mo 里是 `Json` + `#[sea_orm(column_type = "JsonBinary")]`，在 VO 里是 `serde_json::Value` + `#[schema(value_type = Object)]`。

### 4.6 外键与删除策略

- 默认 `on delete restrict on update restrict`：**父行还有子行就不许删**，让数据库当唯一的事实来源，服务层不写一遍「先查有没有子项」。
- 只有当子行**没有独立存在意义**时才用 `on delete cascade`：`syn_task_version`（没有任务，回滚无从谈起）、`syn_idem`（记账是运行附属物）、`syn_cursor`（一源一游标）。
- `on update` 恒为 `restrict`：主键不改，别给「级联改主键」留口子。

### 4.7 索引

- 主键、唯一键的索引由**约束本身**提供，`create-table` 脚本里只保留 PD 生成的 `{table}_PK` 一条（兄弟服务都是这个形状）。**不要再手写 `_AK` 的 `create unique index`**：`oss-rs` 的模型里有、`jobx` / `msg` 没有，选后者——重复索引在热表上是纯写放大。
- PD 表达不了的索引（部分索引、表达式索引）单独放 `model/create-index-pgsql.sql` 并拷进 migrations 的 `_create-index.sql`。
- 建索引的判断标准：这条 SQL **在不在请求路径上**。`syn_idem` 的 `create_ms` 索引是为了保留期清理，属于后台任务，可以接受。

---

## 5. 配置规范

`AppConfig` 一个结构体，字段名 kebab-case，每块能力一个子结构，全部给默认值：

```rust
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub struct AppConfig {
    #[serde(default = "WebServerConfig::default")]
    pub web: WebServerConfig,
    pub db: DbConnConfig,          // 必填：连不上就没法启动
    #[serde(default = "IdWorkerConfig::default")]
    pub id_worker: IdWorkerConfig,
}
```

- 配置文件放 `xxx-svr/xxx-svr.toml`，与 crate 同名；日志配置单独 `log.toml`。
- `bootstrap!(AppConfig)` 生成 `main()` 和 CLI 参数（`--profile`、`--port`、`--pid`、配置中心地址等），**同文件必须有一个 `setup` 函数**，签名固定：

```rust
#[log_call]
async fn setup(
    app_config: &Arc<AppConfig>,
    changed: &Option<HashMap<String, Value>>,
    port: Option<u16>,
    old_pid: Option<u32>,
) -> Result<(), anyhow::Error> { ... }
```

- `changed` 是热更新时变更的 key 集合：`None` 表示首次启动，`Some` 表示只重建受影响的部分。每个 `setup_xxx` 都要能幂等重入。
- 初始化顺序：`db_migrate!` → `setup_id_worker` → 外部依赖（redis / mq）→ `setup_db_conn` → 业务后台任务 → `setup_web_server`（放最后，端口一起来就会被调用）。
- 敏感项（密码、token）不留默认值，只从配置文件/环境变量/配置中心来。

### 5.1 配置里不许出现的东西

上线时反复踩到的一类问题：**配置项写着「这个环境长什么样」**，换环境就得改配置，忘了改就是
「代码没错、环境不对、查半天」。判断标准只有一条 ——

> 换一个部署环境（开发 → 测试 → 生产），这一行需要改吗？需要改，就不属于配置文件。

| 不许配 | 由谁负责 | 配了会怎样 |
|---|---|---|
| `[web] port` | 框架：端口随机，真实端口登记注册中心 | 端口被写死，多副本抢同一个端口；或与容器端口映射不一致 |
| `[id-worker] node` | 框架：按实例自动分配，结果记注册中心 `id-node` | 多副本共用同一个 node，雪花 ID 撞主键 |
| `[syn.targets]`（服务名 → URL） | 注册中心：`target.service` 是服务名，运行时发现 | 换环境要改任务配置；地址变了要重启 |
| `[syn] token`（共享令牌） | 不用鉴权：边界是 overlay 内网 + 网关 | 多一份要轮换的密钥，挡不住内网调用方，还得同步给所有 sink |
| `[syn] reload-duration`（轮询快照） | 刷新信号：写库后发 `refresh.syn.task`，各副本收到就重建 | 配置生效有最长一个轮询周期的延迟；白查库 |
| `[syn] self-schedule`（进程内调度） | jobx 计划任务 | 多副本各自调度，同一批数据被拉多次 |

对应的落地位置：`robotech::micro_svc::instance_resolver`（共享选址）+ `syn-svr/src/registry.rs`
（薄适配）、`syn-svr/src/store.rs`（刷新信号）、`syn-svr/src/wkr/pull_wkr.rs`（默认自注册的取数计划）。

配置里**该有**的是业务策略：投递语义、超时、下游库账号（一个下游一个账号，权限最小）。

同一份机制在业务服务里出现第二遍，就说明它该下沉到框架。服务发现、缓存、轮转属于框架；
业务侧只留自己的策略（这里只有 5s TTL 与「解析不到即 fatal」）。下沉的边界是**能力**不是
**契约**：`FeignApiClient` 的 `Ro<E>` 响应、非 2xx 即错误、失败自动换实例重试，与 syn 要把
原始 status/body 交给 `outcomes` 判定、一次投递只许一个结论相冲突，所以共用的是选址层，
不是整个 HTTP 客户端。

---

## 6. 分层职责

```
ctrl  ── 只做 HTTP 适配：解析请求头 → 取 DTO → 调 svc → 包 Ro
  ↓
svc   ── 编排与事务边界：业务规则、跨表一致性、领域校验
  ↓
dao   ── 数据访问：单表/单实体的 SQL，事务由参数传入
  ↓
mo    ── 表结构映射（SeaORM 实体，由 sea-orm-codegen 生成后手工补注释）
```

| 层 | 可以做 | **不许**做 |
|---|---|---|
| `mo` | 列映射、关系标注 | 业务逻辑；改列名却不改 PDM |
| `dto` | 入参校验（`@len`/`@range` 派生）、分页/排序参数 | 返回值；带审计列 |
| `vo` | 出参整形、`camelCase`、`u64 → String`（防 JS 精度丢失）、`Option` 跳过 | 入参校验 |
| `dao` | 单实体 CRUD、条件拼装 | 跨实体的业务判断；开事务（事务由 svc 传 `DatabaseTransaction`） |
| `svc` | 多 dao 编排、状态机、事务 | 碰 `HeaderMap` / `axum` 类型 |
| `ctrl` | 取 `X-User-Id` / `X-Current-Ms`、调 svc、`Json<Ro<..>>` | 写 SQL；写业务分支 |
| `router` | 路由表（`crud` + 手写 `routes`） | 任何逻辑 |
| `api_doc` | OpenAPI path 清单 | 逻辑 |

### 6.1 宏清单

| 宏 | 用在哪 | 作用 | 注意 |
|---|---|---|---|
| `bootstrap!` | `main.rs` | 生成 `main()` + CLI + 优雅退出 | 同文件要有 `setup` |
| `db_migrate!` | `main.rs::setup` | 按库类型跑 `migrations/{mysql,pgsql,sqlite}` | 已执行的迁移不能改 |
| `log_call` | `setup` 与手写 handler | 进出日志（含参数） | 默认 `debug`，可按 `level = info` |
| `crud_dto` | `dto/` | 从「业务字段」生成 Add/Modify/Save/Query 四个 DTO | 业务 DTO 不写审计列 |
| `vo` | `vo/` | `camelCase` + `o2o` + `ToSchema` + `u64` 转字符串 | 需要 `Model → Vo` 的字段同名 |
| `dao` | `dao/` | 生成 insert/update/delete/get_by_id 等方法 | `unique_keys` 的列名就是约束名 |
| `svc` | `svc/` | 生成 23 个标准 CRUD 方法 | 名字必须是 `XxxSvc` |
| `ctrl` | `web/ctrl/` | 生成 23 个 handler（带 `utoipa::path`） | 名字必须是 `XxxCtrl` |
| `router` | `web/router/` | 生成 `build_router` 并注册到 `ROUTER_SLICE` | 静态路径要排在 `{id}` 前 |
| `api_doc` | `web/api_doc/` | 聚合 OpenAPI | **必须列全**，漏了不报错但 swagger 里没有 |
| `dic` | `dic/` | 字典枚举的整套 impl | 见 §4.4 |
| `api_client` / `feign` | `-api-client` | 客户端聚合与请求头构造 | 有 Rust 调用方才用 |
| `sortable` | `svc/` | 排序值由服务端维护（`flat` / `tree`） | 只有需要「人排的顺序」时才用 |

### 6.2 什么时候**不**用 CRUD 宏

不是所有实体都是 CRUD。判断标准：**接口的入参/出参形状是否就是表的形状**。

- 是 → 用宏。
- 不是 → 手写 `dto` / `vo` / `svc` / `ctrl` / `api_doc`，但 `mo` / `dao` / `router` 照旧（`dbz_dead_letter` 就是这样：写入来自 DLQ，读侧按连接器/状态/时间筛，动作是重投与废弃）。
- 完全不是实体（如 `POST /syn/sync/{topic}` 的记录转发、`POST /syn/task/reload`）→ 手写 handler，`ctrl` 目录里和 CRUD 控制器并列。

**syn 的五个资源最后全部走了「手写」这条路**，这不是偷懒，是三个具体原因，别「统一」回宏：

| 资源 | 不能用宏的原因 |
|---|---|
| `syn_task` | `code` / `topic` / `priority` / `enabled` / `exclusive` 是 `spec`（JSONB）的投影，接口只收 `{ name, spec, remark }`。`#[crud_dto]` 按表形状生成会逼调用方把同一件事填两遍，两边不一致时行为取决于读取顺序。 |
| `syn_source` | 表形状，但 `spec` 是 JSONB，`#[crud_dto]` 会把它塞进 `QueryDto` 当等值条件 —— 没人按「取数定义」查数据源。 |
| `syn_delivery` / `syn_idem` / `syn_overview` | 不是一张表的镜像：投递记录是 `syn_idem` 的投影，台账要关联任务带出 `code`，总览是聚合结果。`#[vo]` 的 `From<Model>` 只能搬同名字段，拿不到这些。 |

照旧用宏的部分：`#[dao]`（五个实体，含 `unique_keys` / `like_columns`）、`#[dic]`（两个字典枚举）、`#[router]`（routes 清单）、`#[log_call]`。`api_doc` 是手写清单，**每个方法逐个列全**；漏一个不报错，只是 swagger 里查不到。

手写 handler 的形状（照 `syn_sync_ctrl`）：

```rust
#[utoipa::path(post, path = "/syn/sync/{topic}", responses((status = OK, body = SyncReply)))]
#[debug_handler]
#[log_call]
pub async fn sync(Path(topic): Path<String>, headers: HeaderMap, body: Bytes) -> Response { ... }
```

注意 `sync` 返回的是 `Response`（见 §7.2 的例外），它用 HTTP 状态码表达结论，不能套 `Ro`。

---

## 7. 接口规约

### 7.1 路径

由 `#[router(crud)]` 自动生成（`{p}` = 第一段小写，`{m}` = 其余部分用 `-` 连接）：

| 方法 | 路径 | handler |
|---|---|---|
| POST / PUT | `/{p}/{m}` | `add` / `modify` |
| POST | `/{p}/{m}/save` `/upsert` `/sync` | 保存 / 存在即改 / 带版本门槛的条件更新 |
| DELETE | `/{p}/{m}` `/{p}/{m}/{id}` | `del_by_query_dto` / `del_by_id` |
| GET | `/{p}/{m}` `/ex` `/list` `/list-ex` `/page` `/page-ex` `/{id}` `/ex/{id}` | 查询族 |
| GET | `/{p}/{m}/search` `/search/ex` `/search/list` `/search/list-ex` `/search/page` `/search/page-ex` `/search/{id}` `/search/ex/{id}` | Bean Searcher 兼容检索 |

手写路由同样挂在 `/{p}/{m}/...` 下，一段话描述清楚「这个接口是给谁的」。

### 7.2 响应

- 统一 `Ro<T>`：`{ result: 1|-1|-2|-3, msg, timestamp, extra, detail?, code? }`，业务数据在 **`extra`** 里，不在 `data` / `message`。`result !== 1` 一律当失败，即使 HTTP 是 200。
- 分页是 `Ro<PageRx<T>>`，`extra` 形状为 `{ pageNum, total, list }`；三个值里 `pageNum` / `total` 是 `U64`，**序列化成字符串**。
- VO 一律 `camelCase`（`create_ms` → `createMs`），`U64` 一律字符串，`#[dic]` 字典枚举一律整数。唯一的例外是 `spec` 这类 JSONB 列：原样透传，键名以配置文件为准，不要替它改名。
- 错误统一 `CtrlError`：`Runtime` → 500、`Validation(s)` → 400、`Io` → 500、`Svc` → 按 `SvcError` 分类。
- **例外**：需要让调用方按状态码决策的接口（`POST /syn/sync/{topic}`，2xx 提交 offset / 4xx 进 DLQ / 503 交还重试），直接返回 `(StatusCode, Json<..>)`，不要套 `Ro` 把语义压成 200。`POST /syn/task/reload` 不属于这一类：它是控制台动作，走 `Ro<u64>`，`extra` 是生效任务数。

### 7.3 请求头

| 头 | 必需 | 用途 |
|---|---|---|
| `X-User-Id` | 写操作必需 | 审计列的 `creater_id` / `updater_id` |
| `X-Current-Ms` | 可选 | 一次请求内多次写共用同一个时间戳；不传由服务端取当前时间 |
| `X-Idempotency-Key` | 可选 | 同步入口的幂等键，形如 `topic:partition:offset`。**不带就不记账**，行为与老版本一致（不是丢数据） |

`get_current_user_id` / `get_current_ms`（`robotech::web::ctrl_utils`）已经把「缺头」「格式错」都做成带期望值与实际值的 `ValidationError`，不要再自己解析。

`syn-svr` 的查询 DTO 全部带 `#[serde(rename_all = "camelCase")]`：`pageNum` / `pageSize` / `taskCode` / `stalledSources` 这类参数别写成 snake_case，serde_urlencoded 认不出来会静默忽略条件（查成全表，且不报错）。

---

## 8. 迁移规范

```
xxx-svr/migrations/
├── mysql/     .gitkeep（不用就留空）
├── pgsql/
│   ├── 20261112000000_create-table.sql
│   ├── 20261112000001_create-index.sql
│   └── 20261112000002_init-data.sql
└── sqlite/    .gitkeep
```

- 文件名 `{YYYYMMDDHHMMSS}_{动作}.sql`，**时间戳必须单调递增**，框架按文件名顺序执行。
- 三类脚本分开：建表（含注释、外键）、索引（PD 表达不了的那些）、初始化数据。
- **已在环境上执行过的迁移文件不能再改**：改就等于「同一个版本号两种库结构」。加列写新的迁移。
  `sqlx::migrate!` 按「版本 + 校验和」记录，改了已应用的文件会在启动时报 checksum 不一致，**服务直接起不来**。
- **未上线的项目**（`syn` / `alarm` / `dtw` 这类还没往生产发过的）例外：直接改 `model/` 里的建表脚本和对应的迁移文件，不写增量；代价是跑过的库必须重建。这条要写在脚本头部，避免别人误以为可以增量升级。
  `migrations/pgsql/20261112000000_create-table.sql` 是 `model/create-table-pgsql.sql` 的拷贝，
  只多头部这一段「未上线」说明；改完 `model/` 后 `cp` 过去、再把头部说明补回来。

---

## 9. 质量门

提交前必须全绿：

```bash
cargo check  --workspace --all-targets --offline
cargo clippy --workspace --all-targets --offline -- -D warnings
cargo test   --workspace --offline
cargo fmt --all -- --check

cd syn-web && pnpm typecheck && pnpm test && pnpm build
```

纪律：

- **同一个 `target` 目录同时只能跑一个 cargo**，并行构建要分开 `CARGO_TARGET_DIR`。
- `cargo fmt` 会把仓库里既有的偏差一并改掉，跑完只提交自己动过的文件，保持 diff 聚焦。
- 单测放在被测模块的 `#[cfg(test)] mod tests` 里（`syn-core` 是纯函数，50 个用例都在原地）；跨服务的联调放 `tests/`。前端的 wire 契约测试放 `lib/api/live.test.ts`（§14.6）。
- 纯逻辑不要塞进 handler 里测：五段、映射、判定、WKB 转换都在 `syn-core`，`syn-svr` 只做装配。
- 改了 poll / DB sink / 幂等 / 总览的行为，提交前按 §15 跑一次真库联调；这四处都有「编译全绿但行为错」的历史。

---

## 10. 仓库与提交

`.gitignore`：

```
/target
.idea
storage
*.ldb
*.pjb
*.pdb
Cargo.lock
.DS_Store
```

提交信息跟仓库现有风格：`type(scope): 标题`，正文按主题分组，写「为什么」而不是「改了什么文件」。

```
feat(syn): 五段规则与记录转发

- 新增 syn-api 的五段契约与校验（match/mapping/action/guard/outcome）
- syn-core 实现纯函数执行器，46 个单测
- syn-svr 提供 POST /syn/sync/{topic}，状态码对齐 sink 的语义
```

---

## 11. syn 的取舍

这几处和兄弟服务**不一样**，理由记在这里，避免后来者「统一」回去：

1. **任务标识用 `code` 不用 `id`**。`id` 是 idworker 的雪花 ID，不该出现在日志、Kafka topic 名、排障对话里。`TaskSpec.id` 装的是 `code`。
2. **`spec` 用 `JSONB` 一列装五段规则**。五段是嵌套的（段 → 行 → 断言），拆表会得到 6 张从表 + 一堆枚举，配置一次要写二十几行，而且没有一层参与检索（见 §4.5）。
3. **不做 `syn-api-client`**。没有 Rust 调用方（见 §1）。
4. **运行时表（`syn_idem` / `syn_cursor`）也带审计四列**。不是为了让它们「像配置表」，而是 `#[crud_dto]` / `#[dao]` 假定存在；少列编译不过。
5. **游标独立成 `syn_cursor`**。它每轮都在写，`syn_source` 是低频配置；混在一张表里会让「读配置」和「推水位」争同一行。
6. **`syn` 的迁移只有 `pgsql`**。`mysql` / `sqlite` 目录留着占位，真的要多库时再补 PDM 与迁移，不提前造。
7. **自拉调度不放在进程里**。`POST /syn/source/{id}/pull` 是 jobx 计划任务与运维按钮**同一个**入口：定时跑的和手动跑的不存在两套实现，单写者、执行历史、失败可见都由 jobx 给。进程内不再有调度器，也没有开它的开关（曾经有 `self-schedule`，开了又部署多副本会互相把游标推乱，已于 §5.1 一并删除）；进程内只留每副本的任务快照缓存与一把防连点的锁（`store.rs` / `poll.rs`）。
8. **一轮拉取不因一条坏数据整体失败**。`SynSourcePullVo` 同时给 `rows` / `success` / `skip` / `fatal` / `retriable` / `position` / `stalled`：游标只推进到第一条非 success/skip 之前，`stalled` 说明卡在哪。界面必须把 `stalled` 显示出来，否则「没数据」和「被卡住」看起来一样。
9. **`target.kind: db` 只换最后一步**。匹配 / 映射 / 校验 / 判定四段与 HTTP 目标完全共用，直写发生在动作段之后；`insert ... on conflict` 的 `c` / `r` / `u` 与按冲突键删除的 `d` 由 `db_sink.rs` 负责。表名与列名**不信任配置**：启动时从 `information_schema.columns` 读列白名单，拼 SQL 前再校验一次标识符合法，值一律绑参数。
10. **`syn_idem` 只记终态，不记逐次投递**。一个 `(task_id, idem_key)` 只有一行，重投命中直接返回上次结论并刷新 `update_ms`；没有「命中次数」「耗时」「中间轨迹」这几列。控制台的「投递记录」是这张表的投影，`op` / `detail` 恒为 `null`、`latency_ms` / `p95_ms` 恒为 `0`。要看逐次轨迹得先改 LDM 建明细表，**不要凭空编一列**。
11. **总览的口径是「记账行数」**。没带 `X-Idempotency-Key` 的投递不记账，因此 `total` / 各结论计数 / 失败 Top 恒为 0 —— 这是事实，不是「没命中」。任务数、来源数是配置表的实时值，与窗口无关，两者别混在一个图例里。
12. **总览小时桶必须含当前小时**。`from = now - N 小时`，两端整点化后正好相差 N 个桶，所以曲线要 **N+1** 个点；只给 N 个点时刚发生的记账会落在数组之外，尾部恒为 0（真库联调才看得见，单测锁在 `syn_overview_svc::hour_buckets`）。窗口合计与曲线各桶之和必须相等，§15 的脚本把这条写成了断言。
13. **连接串进 `syn_datasource` 表，控制台可维护**（本条 2026-11 修订，推翻了早期「连接串只留 consul / toml」的做法）。任务与来源只存 `datasource` 这个名字，名字对应表里的 `code`；连接串、连接池上限、中文名、备注、启停都在控制台「数据源」页维护。改这条是因为「改个密码要动 consul KV」在实践中更容易出错 —— KV 里的值没有变更审计、没有引用反查，改错一处要重启才发现。

    用三条约束把风险兜住：

    - **明文只写不回显**：`url` 列只在写入时收，任何读接口都经 `mask_url` 输出 `host:port/db`，`SynDatasourceVo` 里没有 `url` 字段（也绝不留能还原连接串的派生字段）。编辑时连接串留空 = 不修改，新建必填。**明文确实落在业务库里**（含账号密码），靠库的访问权限与 overlay 网络边界保护，不要再往接口或日志里带。
    - **审计与权限有边界**：改连接串是一次正常业务写库，走审计四列（谁、何时），不再有「谁在 consul 上顺手改了个值」这种查不出来的操作。
    - **改完必须让各副本失效**：连接池是进程内缓存，写完发 `refresh.syn.datasource`，各副本收到清空连接池与列白名单（`db_sink::setup_datasource_refresh`）。不发这条信号，3 个副本会各连各的旧库，现象是「改了连接串，有的副本写新库、有的还写旧库」。

    `[syn.datasources.*]` 配置**降级为兜底**：表里没有这个名字时才回退配置（给联调与「表还没初始化」的环境留路）；表里有但 `enabled = false` 直接判 `DATASOURCE_DISABLED`，**不回退** —— 停用是运维的显式动作，不能悄悄变成「继续用配置里的旧连接串」。**升级注意**：`GET /syn/datasource/list` 现在读表，原先只配在 KV/toml 的数据源不会自动出现，要在控制台登记一遍；运行时不登记也能跑（走兜底），只是下拉里选不到。
14. **`kind=http` 全量分页只能用于「首次同步」，不能和 dbz 并行写同一张表**。SQL 增量安全是因为游标只取「比水位新」的行，天然不会把旧值写回去；全量重扫没有这个性质，与 dbz 增量叠加会出四类问题：
    - **旧快照覆盖新值**（最致命）：扫描进行到第 3 页时，dbz 已把某行从 v1 更新到 v2；第 5 页读到的若仍是扫描开始前的 v1，后到的 upsert 就把 v2 顶掉，且没有任何字段能判出「这是回退」。
    - **删除语义打架**：全量里「没扫到这行」推不出「该删」—— 可能是分页期间新增/删除，也可能是快照隔离。`where not exists` 式的对账删除会误删 dbz 刚写入的行。
    - **幂等键空间重叠**：两边若用同一个 `(task_id, idem_key)`，全量 upsert 会命中 dbz 写下的终态被判 `skip`；若各用各的键，同一行就有两条写入路径，出问题无法归因。
    - **口径失真**：全量轮没有「水位」概念，`rows_synced` 会按整表翻倍累计，总览的「卡住」判断与累计行数都失去意义。

    代码这边能保证的（`poll_http` / `SourceSpec`）：

    - **只 upsert，从不按「缺失」删行**：全量轮不做 `where not exists` 的对账删除，删除语义整体留给 dbz 或源端软删标记。
    - **一轮一页、翻到底停下**：`cursor_value` 是这个源自己的 JSON 状态（`{"http":{"next":"3","rows":600}}` → `{"http":{"done":true,"rows":1200}}`），做完永久跳过；要重跑必须显式 `pull?reset=true`。
    - **`rows_synced` 只增不减地记本次全量投递数**，不参与增量口径的比较（sql 源的水位是另一个形态，两者不会混）。
    - **http 源不能带 sql 字段**：`datasource` / `select` / `cursor_column` 出现在 http 源的 spec 里直接报 `Conflict`，避免「复制 sql 配置改成 http」这种半成品被静默接受。

    靠部署纪律保证的两条（代码不拦，也没法拦）：① **同一张表只允许一个写者** —— 要么 dbz 直写、要么 syn 落地；② **全量期间 dbz 不写这张表**，等 `full_done` 之后再放增量。想并行，就得先给下游加版本列并在 upsert 上带
    `where excluded.<ver> >= <目标>.<ver>` 守卫，而 syn 现在**没有**这个能力，别假设它有。

---

## 12. 检查清单

### 新增一张表

1. `model/xxx.ldm` 加实体：属性（含审计四列）、主键标识、唯一标识（`Code` 按 §3.2 拼）。
2. 有关系就加关系（父 → 子，删除策略按 §4.6 选）。
3. 在 PD 里 `Generate Physical Data Model` → 生成 `xxx-pgsql.pdm`。
4. 从 PDM `Generate Database` → 覆盖 `model/create-table-pgsql.sql`。
5. 脚本在真库上跑一遍（`psql -v ON_ERROR_STOP=1 -f`），确认约束名与框架期望一致。
6. 拷进 `migrations/pgsql/<时间戳>_create-table.sql`。
7. `xxx-api/src/mo/xxx.rs`：列 ← 列对齐，补 `///` 注释；JSONB/TEXT 加 `column_type`。
8. `mo/mod.rs` 加 `pub mod`，`mo/prelude.rs` 加 `pub use`。
9. `dto/vo/dic`：字典列先建 `#[dic]` 枚举。
10. `dao` / `svc` / `ctrl` / `router` / `api_doc` 五件套。
11. `cargo check && clippy && fmt`。
12. 更新本文件的「syn 的取舍」如果这次又做了新的取舍。

### 新增一个服务（`xxx-svr`）

1. `Cargo.toml` 的 `[package]` 名字、`build.rs`、`{pkg}.toml`、`log.toml`、`migrations/{mysql,pgsql,sqlite}` 一起建。
2. `main.rs` 用 `bootstrap!` + `setup`，`setup` 顺序固定：**`db_migrate!` → 装配置 → `setup_id_worker` → 连库 → 预加载缓存 → 起 web → 挂后台任务**。迁移脚本自己连库，必须在连接池之前；`#[dao]::insert` 依赖 ID 生成器，它必须在任何写库之前。
3. `[id-worker] node` **不要配**：框架按实例自动分配并把结果记进注册中心的 `id-node`，多副本各自不同。只有「不注册注册中心、又要跑两个进程」这种测试场景才显式钉住（见 `tests/env/syn-svr-{a,b}.toml`）。真要配时取值 **0..=63**（`node-bits=6`），写 77 会在启动期直接报 `ID worker node error`。
4. 启动阶段能失败的就让它失败（连不上库、端口占用），只有「数据还没准备好」才降级并告警。
5. 跑一次 `cargo run`，确认 `target/<profile>/` 下真的出现了配置、`log.toml` 与 `migrations`；再按 §15 接一次真库，光看编译通过不算验完。

### 改一列

1. 改 LDM 逻辑属性 → 重建 PDM → 重新生成 DDL。
2. 同步列注释里的 `@len` / `@range`（校验唯一来源）。
3. 同步 `mo` 的类型与 `dto` 的校验注解。
4. 已上线 → 新写一条迁移；未上线 → 改建表脚本（脚本头部有说明）。

### 新增一个接口

1. 判断是不是 CRUD 形状（§6.2）。
2. 是 → 只需 `router` 里加一行；不是 → 手写 `dto` / `vo` / `svc` / `ctrl` / `router` / `api_doc`。
3. `api_doc` 里补名字——**漏了不报错，但 swagger 里没有**。
4. 写操作记得取 `X-User-Id`。
5. 需要非 200 语义的，直接返回 `(StatusCode, Json)`（§7.2）。
6. 出参 VO 一改，同步 `syn-web/src/lib/api/live.ts` 的 wire 类型与转换函数，并在 `live.test.ts` 补一条用例（§14.6）。前端实体形状不动，转换只在适配层。

---

## 13. 当前落地进度

以 2026-11-13 为准。**没打勾的项就是差距**，改动时按本规范补齐，不要新增第二套写法。

| 项 | 状态 | 说明 |
|---|---|---|
| `model/syn.ldm` / `syn-pgsql.pdm` / `syn.prj` | ✅ | 七张表：`syn_task` / `syn_task_version` / `syn_idem` / `syn_source` / `syn_cursor` / `syn_datasource` / `syn_canvas_layout` |
| `model/create-table-pgsql.sql` | ✅ | 在 PG 18 上 `psql -v ON_ERROR_STOP=1` 跑通，约束名与框架拼名一致 |
| `syn-svr/migrations/pgsql/*_create-table.sql` | ✅ | 与 model 脚本逐字一致 |
| `syn-core`（五段纯函数 + WKB） | ✅ | 50 个单测，`clippy -D warnings` 干净 |
| `POST /syn/sync/{topic}`、`POST /syn/task/reload` | ✅ | 手写 handler；`sync` 用 `(StatusCode, Json)` 对齐 sink 语义，`reload` 走 `Ro<u64>` |
| `AppConfig` + `bootstrap!` + `db_migrate!` + **`build.rs`** | ✅ | 运行期资源（配置 / `log.toml` / `migrations`）由 `build.rs` 拷到二进制旁，见 §1.1 |
| `syn-api/src/mo`（七个实体） | ✅ | 与 PDM 逐列对齐，`store.rs` 已改走 `dao` |
| `dto` / `vo` / `dic`（`SyncVerdict`、`SourceKind`） | ✅ | 全部手写，理由见 §6.2；字典列是 `INT2` + `@enum` |
| `dao` / `svc` / `ctrl` / `router` / `api_doc` 五件套 | ✅ | 五个资源共 7+8+1+1+1 个手写接口，`api_doc` 逐个列全 |
| `POST /syn/source/{id}/pull`（poll 入口，`kind=sql`） | ✅ | 复合游标 + 5 秒重叠窗口 + 批量 + `wrap`；jobx 与运维按钮共用一条实现，进程内无调度器，见 §11.7 |
| poll 的 `kind=http` 全量分页取数 | ✅ | 一轮推一页，空页/无 next 即收尾，翻到底写 `{"http":{"done":true}}`、此后调度跳过；`pull?reset=true` 重跑。页模式与 token 模式都验过，见 §15.8 |
| `syn_idem` 记账 / `target.kind: db` 直写 | ✅ | `X-Idempotency-Key` 只记终态；DB sink 有 `information_schema` 列白名单，见 §11.9 / §11.10 |
| `syn-web`（控制台） | ✅ | 总览 / 任务（五段编辑器，含 `http`↔`db` 目标切换）/ 来源 / 试跑 / 投递 / 幂等；演示数据可独立运行 |
| `syn-web` 的 `lib/spec`（五段本地预演） | ✅ | `syn-core` 的 TS 同构实现，含 JSONPath / 变换 / WKB→WKT / 判定 |
| `syn-web` 的实时模式适配层 | ✅ | `live.ts` 统一处理 `Ro.extra` / `PageRx` / camelCase VO / `U64` 字符串 / 字典整数；`live.test.ts` 16 个 wire 契约用例 + `validate-source.test.ts` 7 个校验用例 |
| 来源的新增 / 编辑 / 删除入口 | ✅ | 后端五件套齐全（`code` 不可改）；前端 `SourceEditorDrawer` + `lib/spec/validate-source.ts` 本地预校验，错误定位到字段 |
| 数据源管理（`syn_datasource` 表 + 七个接口） | ✅ | 控制台可增删改（连接串 / 池上限 / 启停 / 备注）；明文只写不回显，读接口一律脱敏；改完发 `refresh.syn.datasource` 让各副本重建连接池；`[syn.datasources.*]` 降级为兜底，见 §11 第 13 条 |
| `GET /syn/registry/services`（http 目标服务名候选） | ✅ | 走 `robotech::micro_svc::list_services`（Consul 取 `/v1/catalog/services`，etcd/nacos 默认返回空）；**失败降级为空数组不报错**，表单手输照常能存，见 §14.2 |
| 控制面板（原「同步拓扑」，`GET/PUT /syn/canvas/layout` + `syn_canvas_layout`） | ✅ | 图不落库：节点来自三张业务表、连线来自引用，坐标独存一张表；保存是按 `(node_type, node_key)` 的 upsert（多人摆位不互抹）；投递是任务卡第六段画在卡内，不单独建节点；右侧属性栏单击即显，新增/编辑用居中窗体，见 §14.7 |
| 真库端到端联调（migration → 源库查数 → db sink → 幂等命中 → pull 返回） | ✅ | `tests/e2e/run.sh` 一键跑 30+ 断言，覆盖三库、控制台五接口与前端 wire 契约；见 §15.1–§15.4。联调中还修掉了总览小时桶的 off-by-one（§11 第 12 条） |
| 部署形态联调（consul 配置中心 + 业务库隔离表） | ✅ | `tests/env/run.sh` 一次跑 50 条断言，验的是「不加 `-c`、走默认 `syn-svr.toml` + consul KV 覆盖」这条路；见 §15.5 |
| jobx 计划任务自动注册（取数心跳） | ✅ | 首次启动注册 `executor-code=syn.pull`，撞唯一键只确认分组；实测 6 个批次共 297 拍、0 失败，见 §15.7 |
| 多副本游标乐观锁（CAS） | ✅ | `tests/env/concurrent-pull.sh` 起两副本抢同一批 300 行：水位只涨一轮、败方 `position` 为空且有 warn、重复投递由下游 upsert 吸收；见 §15.6 |
| 下游地址走服务发现（`target.service`） | ✅ | `robotech::micro_svc::instance_resolver`：按服务名共享实例快照，TTL / 空结果负缓存 / 每服务轮转 / 失败保留旧实例，Feign 与 syn 共用同一份；`syn-svr/src/registry.rs` 只留服务名校验与「0 实例 → fatal」。生产 3 副本实测 HTTP 投递到 `dtw-rs-svr` 得 200，配置里没有一处地址 |
| 任务快照跨副本刷新（`refresh.syn.task`） | ✅ | 写库提交后 publish，各副本 subscribe 后重建；生产 3 副本同一毫秒（15:27:23.783）都从 0 变 1、删除后又都回落 0。框架另有 60s 兜底重建（`[refresh] rebuild-interval`），不是本服务的轮询 |
| 雪花 node 与端口的自动分配 | ✅ | 生产 3 副本分别拿到 node 13/26/28（注册中心 `id-node`），端口 44552/42417/36829 由框架随机分配并登记，配置里两者都没有 |

## 14. 前端规范（`syn-web`）

### 14.1 技术栈与工程

跟 `jobx-web` 一致，不另起一套：React 19 + Vite 7 + Tailwind 4 + React Router 7 +
TanStack Query + lucide-react。**不引组件库**：一个控制台要用的表格、弹出窗体、开关、提示
自己写比配主题便宜，也避免 antd 主题色与本仓设计令牌打架。

```
syn-web/
  src/
    components/{ui,layout,spec,table}   # 通用控件、布局、五段编辑器
    features/{overview,tasks,sources,topology,playground,deliveries,idem}
    hooks/                              # 一资源一 hook，query key 集中在 hook 里
    lib/api/{http,types,mock,live,index} # types 是 syn-api 的 TS 镜像
    lib/spec/{jsonpath,transforms,evaluate,validate,defaults}
```

- `lib/api/types.ts` 与 `syn-api/src/spec.rs` **逐字段对应**（serde 的 key 原样抄，
  `assert` 不写成 `asserts`）。字段名两边不一致，是这套配置最容易腐化的地方。
  注意这只约束 **JSONB 里的 `spec`**：VO 的字段名是 camelCase，两边本来就不一样，
  由 §14.6 的适配层处理，不要为了「统一」去改 VO 或改实体。
- 页面只 import `lib/api` 的 `tasks/sources/…`，不直接碰 `fetch`；mock 与 live 的切换
  集中在一处。
- 演示数据必须能通过 §13 的同一套校验 —— 否则「界面能点、保存报错」会变成常态。
- 单包工程放了 `pnpm-workspace.yaml`（为了 `allowBuilds: esbuild`）时，**必须写
  `packages: [.]`**。pnpm 9 见到这个文件就当 workspace 根，缺 `packages` 会报
  `packages field missing or empty` 并拒绝执行任何 `pnpm <script>`；`pnpm xxx | tail`
  还会把非零退出码吞掉，看起来像「构建过了」。

### 14.2 五段编辑器

新增 / 编辑用**居中弹出窗体**（`components/ui/Drawer.tsx` 的 `Modal`，与右侧抽屉共用
同一套遮罩、焦点圈定、ESC、body 滚动锁，只是 `placement="center"`），按段分页签：
基本 / 匹配 / 映射 / 校验 / 动作 / 判定 / 投递 / JSON。三条硬约定：

1. **保存前先跑 `validateSpec`**，把问题按 `path` 定位到页签与行；有错不许保存。
   `tabOfPath` 必须跟着页签改动同步：`target.*` 现在映射到「投递」（第 6 步），
   不跟着改的话，保存报错的提示点不动、跳不回出错字段。**这是拆页签最容易漏的一处。**
2. **每段只有一种输入形态**：条件是三段共用的一张表（`AssertEditor`），动作是四行矩阵，
   不要为某一段另做一个「更好用」的控件 —— 两套控件必然长出两套语义。条件数组本身是
   AND 根节点，元素可以是叶子断言或 `all` / `any` / `not` 分组，分组内递归用同一张表；
   旧配置（一层断言数组）零迁移。校验要跟着递归，并对深度（8 层）与节点数（200）设上限。
3. `scope` 缺省是**继承**：继承成 `status` 时「取值路径」整列禁用。允许在这里「聪明」
   地默认看请求体，就会和 `syn-core` 给出不同结论。另外 `body` 在守卫段是映射后的请求体、
   在判定段是下游**响应体**，界面标签统一写「报文体」并注明两段差异，别写成「请求体」。

「投递」是第 6 步而不是基本页的一部分：它是判定之后唯一的出口，与前五段是「同一批记录
的不同出口」，与基本页的元信息（编码、topic、优先级、启停）不是一类东西。
两个下拉都必须是**可手输的候选**（原生 `<input list>`）：注册中心 / 数据源表拿不到清单时
自动退化成纯输入框，配置要能先于下游上线写好的。

来源的编辑窗体（`SourceEditorDrawer`）是同一套做法的小号版本：`kind`、`code` / `name` /
`interval` / `batch` 加上 `spec` 的公共字段，保存前跑 `lib/spec/validate-source.ts`。
那份校验是后端 `SourceSpec::validate` 的镜像，**两边改必须同时改**：空编码、编码字符集、
`interval_duration >= 1s`、`kind=sql` 必须有 `datasource` / `cursor_column`，这几条
在前后端各有一份，缺一份就会出现「前端放过去、后端 400」或者反过来的假通过。
编辑态下 `code` 只读（后端也拒绝改），别做成可编辑再靠报错兜。
`datasource` 用 `GET /syn/datasource/list` 的下拉（候选取自 `syn_datasource` 表），
**不填连接串**（§11 第 13 条）。

### 14.3 试跑

`lib/spec/evaluate.ts` 是 `syn-core` 的 TS 同构实现，**语义逐字对齐**：守卫默认对记录
求值、`omit_null` 是全局语义、条件树按 all/any/not 递归（含 `gte` / `lte` 边界）、
判定首命中即停、末条兜底只认纯状态码叶子、未知响应按 `UNCLASSIFIED` 失败。
`lib/spec/condition.test.ts` 固定住这些语义，改一侧必须同时改另一侧。
预演不发请求，界面标「待投递」；真实投递走 `POST /syn/sync/{topic}`，只在实时模式可用。

预演结果与线上不一致时，改的是 TS 这一侧 —— Rust 那边有 50 个单测锁着。

### 14.4 视觉与交互

- 设计令牌在 `styles.css` 的 `@theme`（暖灰底 / 白面板 / 深青强调），与 `jobx-web` 同源；
- 数据列一律等宽 + `tnum`，时间用 `formatCompact` 这类短格式；
- 全屏遮罩**不要** `backdrop-blur`（整页模糊每帧重算，实测滚动 60fps → 15~30fps）；
- 弹层必须锁 body 滚动、圈住 Tab、Esc 关闭（`Drawer` / `ConfirmDialog` 已封装）。

### 14.5 部署

页面 `/syn-web/`、接口 `/syn-svr` 同源由 nginx 分流：`PUBLIC_BASE` 决定资源前缀与路由
basename，必须与 `location` 一字不差；`proxy_pass` 末尾斜杠要带（框架无 context-path）；
静态服务器配不了 SPA 回退时用 `VITE_ROUTER=hash`（此模式 basename 必须留空）。

### 14.6 实时模式：wire 与实体分离

`lib/api/types.ts` 是**控制台的实体形状**（snake_case、数字用 `number`、枚举用小写
字符串），不是后端 VO 的镜像。两者之间隔一层 `live.ts`，页面代码不感知后端：

```
Ro<T>.extra        http.ts 的 request 拆封
  ↓
PageRx / VO        live.ts 里的 WireXxx 接口（私有，camelCase + U64 字符串 + INT2 枚举）
  ↓  toTask / toSource / toDelivery / toIdem / toOverview
Page<T> / 实体     types.ts，页面与 mock 共用
```

三条纪律：

1. **不编数据**。后端没有的字段就填 `0` / `null`：`stats` 全 0（无逐任务统计）、
   `hits = 1`（`syn_idem` 一行就是一个键）、`p95_ms` / `latency_ms` = 0（台账不落耗时）、
   `op` / `detail` = `null`。界面显示「暂无数据」比显示一个好看的假数有用。`last_rows`
   例外：后端游标只存累计行数，手动 `pull` 返回的本轮行数按数据源 ID 记在内存里，
   列表刷新时回填；不知道就留 0。
2. **U64 不转 `number`**。雪花 ID 有 19 位，只有用来算数/画图的值（`total` / `hour_ms` /
   各类计数）才 `Number(...)`。
3. **写请求按 DTO 的 camelCase 发**。尤其 `DeliveryQuery.task_code` → query 里的
   `taskCode`；写成 snake_case 会被 serde_urlencoded 静默忽略，查成全表且不报错。

`live.test.ts` 用 stub `fetch` 锁住每个转换点。改 VO 时**先让这里红**，再改 `live.ts`：
这类形状漂移不会白屏、不会报错，只会安静地显示错数据，是最难在联调里发现的一类。

质量门（后端见 §9，前端另跑）：

```bash
cd syn-web && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` 没测试文件会以退出码 1 结束，别把它当「没有测试所以跳过」。

### 14.7 控制面板（`features/topology`，原「同步拓扑」）

页面名 / 侧栏名统一叫「控制面板」，**路由 path 仍是 `/topology`**（书签与 `Topbar`
从 `NAV` 取标题都依赖它，改名不改路径）。布局是「左侧组件栏 88px → 画布 → 右侧属性栏
292px」，一张图看清「数据从哪来、投到哪去」：数据源 → 取数来源 → 主题 → 任务四列，
方向即数据流。五条设计决策，改这块之前先读一遍：

1. **图不落库**。节点来自三张业务表、连线来自它们之间的引用（`spec.datasource` /
   `source.topic` / `task.topic`），库里只存节点坐标（`syn_canvas_layout`）。
   所以图永远和配置一致 —— 反过来，**画布上不能改引用关系**：改「来源用哪个数据源」
   要回表单。单击卡片在右侧属性栏看属性，双击打开居中窗体改配置。
2. **属性栏只读图节点**（`graph.nodes.find(n => n.id === selectedId)`），不另发请求、
   不另存一份选中实体。点卡片**始终选中**（不是 toggle），点空白才取消 —— 否则连点
   同一张卡会把属性栏抵消掉。任务节点额外给一个原尺寸启用开关（画布缩到 45% 时
   卡上那个只有 8px 出头）和六段直达入口；主题是虚拟节点，不给编辑按钮。
3. **投递是任务卡的第六段，不单独建节点**。画到卡外会连出「一个任务分支到一个服务」
   的假关系；多个任务投同一个服务时还会交叉连线，还把投递目标误当成共享实体。
   任务卡只有一种形态 600×140 恒展开：六段并排（段名 + 概要），点某段直达窗体对应页签。
4. **开关请求期间不禁用按钮**。原生 `disabled` 的 button 连 `click` 都不派发，
   请求稍慢就会被当成「点了没用」；`busy` 只加 `aria-busy` 与描边。在途状态按
   `${node.id}:${action}` 分键（`enabled` / `exclusive`），两个开关互不置灰。
   启停的乐观更新必须同时改 `task.enabled` **和 `task.spec.enabled`**：后端保存任务时
   是用 `spec` 反推列的，只改前者会让用户随后编辑一次就把刚打开的开关关回去；
   `onSuccess` 只标脏不立刻 refetch，连点用序号保证最后一次生效。见 `hooks/task-cache.ts`。
5. **保存是 upsert，不是全量替换**。前端只提交这次拖动过的节点；两个人在不同分支上
   摆位时全量替换会互相抹掉对方的坐标。拖动用 window 级 `pointermove/up`（指针移出
   卡片拖拽不粘），松手才写库；按下不动抬手才算点击，移动过就是拖拽。
   滚轮缩放必须用原生非被动监听（React 的 `onWheel` 是 passive 的，`preventDefault()`
   不生效，整页会跟着滚）；`services: []`（注册中心没拿到）不判「未登记」。

后端只有两个接口：`GET /syn/canvas/layout`（全量）、`PUT /syn/canvas/layout`
（按 `(node_type, node_key)` upsert，校验契约在列注释：`@len 128`、`@range 0..20000`）。
不做删除接口：节点删了残行由画布忽略，`mergePositions` 会丢掉孤儿坐标。

---

## 15. 真库端到端联调（`tests/e2e` / `tests/env`）

编译、clippy、单测只能证明「代码自洽」。游标推进、`on conflict`、幂等台账这些行为
只有接真库才看得见 —— 2026-11-13 首次联调就抓到了总览小时桶的 off-by-one
（§11 第 12 条），而它在纯单测里是绿的。

四个脚本分工固定，别混用：`tests/e2e`（§15.1–§15.4）自己造三个隔离库、用 `-c` 绕开
配置中心，验**代码行为**，CI 友好；`tests/env/run.sh`（§15.5）用本机现成环境、不加 `-c`，
验**部署形态**（consul 覆盖、业务库落表）；`tests/env/concurrent-pull.sh`（§15.6）起两个
副本抢同一批，验**跨副本的 CAS**——这条只有多进程才撞得上，前两个脚本无论如何都覆盖不到；
`tests/env/http-full.sh`（§15.8）配一个分页假接口，验**全量分页**的状态机（翻页、收尾、
done 后不再拉、reset 重跑）。

### 15.1 跑法

```bash
cargo build -p syn-svr          # 脚本只跑已编译好的二进制
tests/e2e/run.sh --reset        # 从头建库、跑完全部断言（推荐）
tests/e2e/run.sh                # 库已存在时直接退出，避免误删
tests/e2e/run.sh --cleanup      # 停服务 + 删掉三个联调库
```

依赖本机 `pgsql` 容器（PostGIS 18，端口 5432）与 `docker` / `curl` / `jq` / `nc`；
`PG_CONTAINER` / `PG_USER` 可覆盖容器名与账号。脚本只 drop 名字精确等于下面三个的库，
跑完默认**保留**，方便对着库排查。

| 库 | 用途 |
|---|---|
| `syn_it` | 服务库，启动时由 `db_migrate!` 自动建 `syn_*` 五张表 |
| `syn_it_src` | 源库，`demo_person(id, name, updated_at)`，poll 按 `(updated_at, id)` 拉增量 |
| `syn_it_dst` | 下游库，同名表；预置 `alice-stale` 验证 upsert 真的覆盖了旧值 |

配置是 `tests/e2e/syn-svr-it.toml`，用 `syn-svr -c <绝对路径>` 加载，**不改
`syn-svr.toml`**：`bootstrap!` 的 `-c` 优先于默认配置文件，配置中心没初始化只会打一条
warn。端口 19007（单进程联调，显式写死好让脚本连），jobx 不参与。

### 15.2 断言清单

1. 迁移建出 7 张表；任务/数据源创建后虚拟 topic 是 `source:it_person`。
2. 首轮 pull 3 行全 success，目标表 3 行且 `id=1` 被覆盖，游标 `rows_synced=3`、水位非空。
3. 空轮 `rows=0` 且不重复写；源库加一行后下一轮 `rows=1`，游标涨到 4。
4. `X-Idempotency-Key`：首次写下游并记账；手工改下游值后同键重投**不再写**；缺冲突键
   返回 400 `DB_KEY_MISSING` 且**不记账**；同一键随后重投正常记录仍能成功。
5. 控制台五类接口：`task/page` / `source/page`（`cursor.rowsSynced`）/ `delivery/page`
   （含 `verdict` 与 `taskCode` 筛选）/ `idem/page` / `overview`（小时桶 success 之和
   等于 `total`）/ `reload` 的 `extra`。这一组同时是 `live.ts` 适配层的 wire 契约。
6. 数据源 CRUD：连接串只写不回显、改其它字段时留空连接串保持原值、停用 / 删除生效、
   `GET /syn/registry/services` 无注册中心降级为空数组。
7. 画布布局：初始为空；一次存两个节点、读回一致；**只提交一个节点不抹掉另一个**
   （upsert 而非全量替换）；同键重复保存不新增行；空 `nodeKey` / 越界坐标返回 400
   且不落行。

### 15.3 联调暴露过的坑

- **总览小时桶少一个点（已修）**：见 §11 第 12 条，`hour_buckets()` 现在给 N+1 个点，
  新增两个单测锁住端点。
- **`[id-worker] node` 只能 0..=63**：`node-bits=6`，写 77 直接在 `setup_id_worker`
  阶段启动失败，不会等到第一次插入才暴露。
- **VO 字段名别靠猜**：`SynSourceVo` 的水位是嵌套的 `cursor.position` /
  `cursor.rowsSynced`，不是平铺的 `cursorValue`；查 wire 前先看 `vo/*.rs`，否则会把
  「查错字段」误判成缺陷。
- **一个请求里两种命名风格**：外层 `SynSourceSaveDto` 是 camelCase
  （`intervalDuration` / `batchSize`），`spec` JSONB 里的 `SourceSpec` 是 snake_case
  （`cursor_column` / `cursor_type`）。写用例时别顺手统一。
- **改配置的响应也要补水印（已修）**：`update` / `set_enabled` 走的是「写配置」，
  一开始没带 `with_cursor(...)`，库里水位是 4、`PUT` 却回 `cursor: null`。凡是返回
  `SynSourceVo` 的写接口都要补，否则界面改完一次名字就把水位显示成「还没跑过」。
- **来源的 `code` 是地址，不是标签**：虚拟 topic `source:{code}` 与游标都按它指代，
  改名会让水位与投递记录找不到主人。所以 `update` 里 `code` 变了直接 400，改
  `name` / `interval` / `batch` 不动水位 —— 这两条 §15 的脚本都断言了。

### 15.4 仍未覆盖

只剩一项 —— 「没验」不等于「没写」，也不等于「不能用」，说清楚才好判断风险。
2026-11-13 补掉了原先列在这里的三项：多副本游标竞态（§15.6）、真实 jobx 触发（§15.7）、
`kind=http` 全量分页（§15.8）。

| 项 | 代码状态 | 为什么不在这些脚本里验 |
|---|---|---|
| 跨库事务失败后的重投窗口 | **按设计接受重复**。DB sink 先写下游、再推游标，两步不在一个事务里；下游成功而游标失败时下一轮重拉同批，靠下游 upsert 与幂等键吸收 | 要稳定复现得在两步之间注入故障（`kill -9`、中途断库），脚本里制造这种时序不可靠，容易变成「偶发绿」。语义上的兜底已经有断言：失败不推进水位、重投不重复写 |

这是**设计取舍**（重复可接受，靠下游吸收），不是缺口。

http 全量本身还有两处**已知边界**（验过，但能力就到这）：源接口翻页中途插入/删除会让结果
「看起来重复或缺行」，靠下游 upsert 吸收；接口忽略 `{cursor}` 时页码模式会一直「有数据」，
代码用 100000 页上限兜住并报错，不会跑飞。

### 15.5 部署形态联调（`tests/env`）

`tests/e2e` 是自己造三个库、用 `-c` 绕开配置中心，验的是**代码行为**；
`tests/env` 反过来，用你手上真实的环境验**部署形态**：不传 `-c`，让它读默认
`syn-svr.toml`，再看 consul KV 有没有真的把配置覆盖掉；服务库用已建好的 `syn`，
源/目标落在现有业务库 `admrs` / `dtwrs_ui`。

```bash
cargo build -p syn-svr
tests/env/run.sh            # 全链路跑完自动停服务
tests/env/run.sh --keep     # 保留服务在 9007，方便开界面点
tests/env/run.sh --cleanup  # 只清联调数据，不启动服务
```

它是**破坏性但边界极窄**的脚本，写死只碰三处，越界即 `exit 1`：

1. consul KV `dev/syn-svr.toml`（内容在 `tests/env/consul-dev.toml`）；
2. `admrs.public.syn_it_person` / `dtwrs_ui.public.syn_it_person`，建表前先查存在性；
3. `syn` 库里 `code` 精确等于 `adm_person` / `adm_person_to_dtw` / `tmp_delete_me` 的配置行。

**不改任何已有业务表**，也不动 consul 的其它键。断言分 10 组、共 50 条：
数据源清单接口可达（§11 第 13 条改成读 `syn_datasource` 表之后，表为空时返回空数组，
断言只认 200；`adm` / `dtw` 在 KV 里只用于验证运行时兜底）→ 来源 CRUD 与编码保护
→ 任务与 reload 快照 → poll 三轮（含 `on conflict` 覆盖脏行）→ 幂等台账四条 →
控制台六类接口 → 小时桶末桶。

跑之前先确认没有残留进程占着 9007，脚本的前置检查只查端口不查进程名，
`pgrep -x syn-svr` 有输出就先 `kill -TERM`。

#### 这一轮暴露的坑

- **`[micro-svc.consul]` 段缺了，KV 就永远读不到**：`bootstrap!` 只在配置里声明了
  consul 段时才去拉 KV，缺段不报错、不告警，只是「配置中心好像没生效」。判断依据放两个：
  启动日志里**没有**「任务快照刷新订阅已建立」，或者 `GET /syn/datasource/list` 是空的
  （数据源只存在于 KV 里）—— 不要靠改一个值再猜。
- **`[config] common-configs = ["log.toml"]`** 才挂日志配置，否则日志级别与输出目标
  都走默认，`grep` 断言会静默落空。
- **`node=77` 起不来**（同 §15.3）：真要在配置里写 node，toml 与 consul KV 两处都要落在
  `0..=63`，改一处忘另一处就是启动失败。正常情况根本不用写 —— 框架自动分配。
- **业务库里的隔离表要自己建**：真实环境不会替你跑 `create-table`，`syn_it_person`
  由脚本 `drop table if exists` + `create table` 重建，避免上一次的残留行让断言假绿。

### 15.6 多副本并发（`tests/env/concurrent-pull.sh`）

`advance_cursor` 那条 `update … where id = $6 and update_ms = $7` 是**跨副本**的唯一闸门：
进程内的 `IN_FLIGHT` 只防同一副本连点，单实例跑一万次也撞不上 CAS。所以专门起两个副本
抢同一批数据：

```bash
tests/env/concurrent-pull.sh            # 默认 300 行
ROWS=500 tests/env/concurrent-pull.sh   # batch_size=500，一轮取完才能测「同一批」
```

两个副本的配置是对称的（`syn-svr-a.toml` / `syn-svr-b.toml`，只差端口与 `node`）：

| 副本 | 端口 | `[id-worker] node` | 配置文件 |
|---|---|---|---|
| A | 9007 | 3 | `tests/env/syn-svr-a.toml` |
| B | 9008 | 4 | `tests/env/syn-svr-b.toml` |

这里的 `node` 是**测试专用的权宜之计**，不代表生产要配：两个进程不接注册中心，框架
拿不到「同服务已占用」列表，自动分配会双双回退 0，雪花 ID 撞不撞就全看运气。生产三副本
实测自动分配为 13/26/28（见 §13 表），配置里一个字都没有。

**两边都不带 `[micro-svc.consul]`、都不配 `[api.jobx]` / `[redis]`**，这是刻意的：有了
jobx 就有默认的取数心跳（5 秒一次），jobx 会在测试窗口里把新行先拉走，「两副本抢同一批」
就退化成「一先一后」，竞态测不出来。

断言 8 条（实测两轮全绿）：

| 断言 | 说明 |
|---|---|
| 两副本均返回 200 | 撞车不是错误，是预期路径 |
| 两副本都取到 N 行 | 重复投递是设计语义，不靠「只有一方取到」取胜 |
| 恰好一方带回 `position` | CAS 只有一方成功 |
| 水位只涨 N（不是 2N） | 败方的 `update` 影响 0 行，不重复累计 |
| 下游行数 = 前值 + N | 两方各 upsert 一遍，最终仍是 N 行 |
| 下游无重复主键 | upsert 不是 insert |
| 游标停在本批最后一行 | 胜方的 `position` 与库中 `cursor_value` 一致 |
| 败方日志有「游标被并发更新」 | 区分「真撞上 CAS」与「对方先跑完、这边读到 0 行」 |

#### 这一轮暴露的坑

- **pid 文件按二进制路径生成**（`target/debug/syn-svr.pid`），同名二进制起第二份直接被
  `Program is running: <pid>` 挡住。脚本把 A 的二进制 `cp` 成 `syn-svr-b` 再起 —— 这是
  绕开单实例保护最省事的办法，不必改框架。
- **5 秒重叠窗口会挡住刚插入的行**（`updated_at <= now() - 5s`）。插完立刻 pull 会读成 0 行，
  脚本固定 `sleep 7`。这一步漏了，测出来的是「没数据」，不是「没竞态」。
- **id 段必须每次换新的**：第一次写成固定的 `2001..2300`，第二遍跑时下游已有这批 id，
  `on conflict` 只更新不新增，「下游行数 = 前值 + N」必然失败。现在从
  `select coalesce(max(id), 0)` 往后取，脚本可反复跑。

### 15.7 jobx 计划任务自动注册

取数心跳不靠人手工建计划：`[syn.pull-job]` 配了就**启动时自动注册**（与 dtw 的报警判定、
alarm 的补发同一套），重复启动撞唯一键时只确认分组、不重复插入。三处配置缺一不可：

```toml
[syn.pull-job]          # 计划本身：executor-code=syn.pull，interval 5s，task-expire 1h
[api.jobx]              # 怎么找到 jobx（MicroSvc 走发现，Simple 直连）
[redis]                 # 执行器从 Redis Stream 收任务
```

**配置错误**（缺 `[api.jobx]` / 缺 `[redis]` / 间隔写错）在启动时直接失败；但 **jobx 不可达**
只 `error!` 一条然后继续跑 —— sink 推送是主链路，不该因为调度器没起就整体不可用。这种情况
日志里会明确写「本次启动不启用自动取数」，`POST /syn/source/{id}/pull` 仍可手工触发。

实测：注册成功后 jobx 持续分派 `syn.pull` 并正常执行 —— **6 个任务批次、累计 297 拍、
0 失败**，单拍 2–200ms。注意 `jobx_task` 是**批次**不是「一拍一行」：5s 间隔下 jobx 每
5 分钟建一条任务，任务内部跑 60 拍，`exec_detail` 记成「共60次 成功60 失败0」，
所以一天约 288 行、不是 1.7 万行。`status` / `exec_start_ms` / `exec_end_ms` 三列齐全，
排障时能直接看出「这一拍扫了几个源、拉了几个」。

每拍都会扫一遍启用的源、按各自 `interval-duration` 判断到没到点，所以实际精度 =
`max(心跳间隔, 源的间隔)`。

#### 这一轮暴露的坑

- **服务发现带 `?passing=true`，而这套开发环境的 consul 里每个 rs 服务都挂了一个
  `service:alias-*` 检查且状态 critical**，于是 `MicroSvc` 永远返回「发现 0 个实例」。
  不是 jobx 没起，是它在过滤后不可见。本机改用 `type = "Simple"` + `base-url` 直连；
  生产 alias 正常时应改回 `MicroSvc`，`svc-name` 写注册名原样。
- **`svc-name` 不拼 profile**（与直觉相反）：jobx 自己注册成 `dev-dev-jobx-svr`（它的
  svc-name 已带 `dev-`，框架又按 group 拼了一层）。写 `dev-jobx-svr` 得到 0 个实例。
- **consul 里的过期实例会骗人**：jobx 进程早就没了，catalog 里还留着注册 + alias 检查，
  `curl` 健康接口看着像「在跑」。判断依据是 `lsof -iTCP:9001` 有没有监听，不是 consul。
- **`jobx_task` 是批次不是「一拍一行」**：5s 间隔下每 5 分钟建一条、内部跑 60 拍。
  `task-expire-duration` 仍要配（不配就永久保留），但别按「5s 一行」估算容量 ——
  实际一天约 288 行，不是 1.7 万。

### 15.8 http 全量分页联调（`tests/env/http-full.sh`）

`kind=http` 的语义和 sql 完全不同：没有 `(updated_at, id)` 这种稳定水位，只能全量翻页。
所以它按「**一轮一页**」实现，进度存在 `syn_cursor.cursor_value` 里：

```json
{"http":{"next":"2","rows":300}}     // 下一页游标 + 已投递行数
{"http":{"done":true,"rows":1200}}   // 翻到底，此后调度跳过
```

```bash
tests/env/http-full.sh      # 起 mock 假接口 + syn，跑完自动停
```

假接口是 `tests/env/mock-paging.py`（3 页 7 行的页码模式 + 2 页 4 行的 token 模式），
另外暴露 `/stats` 记「被打了几次」——**只对数据库断言看不出它有没有白跑**，所以「done 之后
不再打源接口」这条必须靠计数器验。

25 条断言（两轮全绿）：

| 分组 | 断言 |
|---|---|
| 页码模式 | 3 页分别 3/3/1 行、`fullDone=false`；第 4 页空 → 0 行且 `fullDone=true`；下游 7 行、`rows_synced=7`、游标含 `done` |
| 已完成后 | 再拉一轮 0 行 + `fullDone=true`；`/stats` 计数不变（证明没打接口）；下游行数不变 |
| reset 重跑 | `pull?reset=true` 后第 1 页 3 行、`fullDone=false`；下游仍是 7 行（upsert 不是 insert）；`rows_synced` 从 0 重计 |
| token 模式 | `next_path` 翻页 3 + 1 行；`next` 为空即收尾；完成后不再打接口 |

#### 这一轮定下的几个取舍

- **一轮一页，不是一轮拉完**。10 万行走一次 HTTP 全程，中途挂了得从头再来；一轮一页每页都
  推进水位，断点天然可续。代价是全量完成时间 = 页数 × 调度间隔，所以未完成的 http 源在
  `poll_due_sources` 里**不看 `interval`**，每拍都推。
- **空页才是结束**，不是「本页不足 `page_size`」。很多接口会自己封顶（要 500 给 200），
  按「不足即末页」会提前收尾、静默漏数据。
- **固定地址只拉一页**：`url` 里没有 `{cursor}` 占位，说明接口本身就是「全量一个响应」，
  再翻页只会拿到同一批。
- **页码模式有上限**：接口若忽略 `{cursor}`，页码会一直「有数据」，`MAX_PAGES=100000`
  处直接报错，不跑到天亮。
- **两种取数不能混字段**：http 源的 spec 里出现 `datasource` / `select` / `cursor_column`
  直接报 `Conflict` —— 多半是从 sql 配置复制过来的半成品，按 http 跑会静默忽略这些字段。

#### 这一轮暴露的坑

- **`{{cursor}}` 与 `{cursor}` 两种写法在前端和后端不一致**：控制台提示一直写的是
  `{cursor}`，Rust 侧注释原来写 `{{cursor}}`。现在两个都认（先替换双花括号，再替换单花括号），
  免得用户按任一写法填都「看起来对、实际没生效」。
- **`is_some_and(is_http_done)` 编译不过**：`Option<&str>::is_some_and` 要 `Fn(&str)`，
  而 `is_http_done` 收 `Option<&str>`，得包一层闭包 —— 类型对不上时先看函数签名，别改语义。
