# syn-web · 同步控制台

`syn` 的前端工程：任务规则（五段）、取数来源、试跑、投递记录、幂等台账。

技术栈跟 `jobx-web` 保持一致，不另起一套：React 19 + Vite 7 + Tailwind 4 +
React Router 7 + TanStack Query + lucide-react。没有引组件库 —— 一个控制台需要的
表格、居中弹出窗体、开关、提示，自己写比配主题便宜。

```bash
pnpm install
pnpm dev        # http://localhost:5181，/api 反代到 127.0.0.1:9007（syn-svr）
pnpm build      # tsc --noEmit && vite build
pnpm typecheck
```

## 数据从哪来

侧栏底部可以切换两种模式，选择存在 localStorage：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| 演示数据 | `VITE_API_BASE` 为空（默认） | 全站在内存里跑，写操作不落库，刷新还原 |
| 实时接口 | 配了 `VITE_API_BASE` | 请求打到 syn-svr |

演示数据不是随便编的：5 个任务、3 个来源、160 条投递、24 条幂等记录，失败码、耗时、
命中分布都按真实形状造，用来确认「界面读起来对不对」。样例报文里那条 `POINT/POLYGON`
的 WKB 是 Debezium 真实输出，能完整走到 `wkb_to_wkt`。

## 试跑为什么在浏览器里跑

`src/lib/spec/` 是 `syn-core` 的 TS 同构实现：JSONPath 子集、断言求值、映射与变换
（含 WKB→WKT）、判定规则、五段编排。理由很直接 —— **图形化配置最怕点了保存才发现规则写错**，
试跑必须能在改库之前给出答案。

两边语义有几处必须逐字对齐，改动时别「优化」：

- 守卫的条件默认对**记录**求值，看请求体要显式 `scope: body`；同一作用域在判定段
  指的是下游**响应体**；
- 条件数组即 AND，元素可以是 `all` / `any` / `not` 分组（可嵌套）；旧的一层断言数组
  不用迁移；`gt` / `gte` / `lt` / `lte` 只对数字生效；
- 映射的 `omit_null` 是全局语义，`on_empty` 只处理「变换之后变空」；
- 判定首命中即停，末条必须是不带 `field` 的纯状态码兜底（不能含 any / not 分组），
  没命中任何规则时按 `UNCLASSIFIED` 失败；
- 变换链遇到非字符串原样返回，解析不了就报错走该行的 `on_error`。

「真实投递」调 `POST /syn/sync/{topic}`，返回的就是 sink 会收到的结论（含 HTTP 状态码
语义），只在实时接口模式下可用。

## 部署

生产按子路径挂：页面 `/syn-web/`、接口 `/syn-svr`，同源由 nginx 分流。

- `PUBLIC_BASE`（`.env.production`）决定 Vite `base`，同时决定资源前缀与路由 basename，
  必须和 nginx 的 `location` 一字不差，否则 `/assets/*.js` 全 404；
- `VITE_API_BASE=/syn-svr`：框架的 `WebServerConfig` 没有 context-path，nginx
  `proxy_pass` 末尾斜杠必须带上，否则 `/syn/*` 前缀被透传、全站 404；
- 静态服务器配不了 SPA 回退时用 `VITE_ROUTER=hash`；hash 模式 basename 必须留空，
  否则 react-router 拿 basename 去匹配 hash 路径，整页空白。

## 接口清单

界面按 `doc/syn-开发规范.md` §7 调这些路径，**全部已在 `syn-svr/src/web/router/` 注册**。
遇到 404 / 405 基本只有两种原因：网关前缀没配对，或部署的 syn-svr 是旧版本 ——
`ApiError.isMissing` 会给出明确提示，不会白屏。

| 页面 | 接口 |
|---|---|
| 任务 | `GET /syn/task/list`、`GET /syn/task/page`、`GET/POST/PUT/DELETE /syn/task[/{id}]`、`PUT /syn/task/{id}/enabled` |
| 来源 | `GET /syn/source/list|page`、`POST/PUT/DELETE /syn/source[/{id}]`、`POST /syn/source/{id}/pull`、`PUT /syn/source/{id}/enabled` |
| 数据源 | `GET /syn/datasource/list|page`、`POST/PUT/DELETE /syn/datasource[/{id}]`、`PUT /syn/datasource/{id}/enabled` |
| 控制面板 | `GET/PUT /syn/canvas/layout`、`GET /syn/registry/services` |
| 投递 / 幂等 / 总览 | `GET /syn/delivery/page`、`GET /syn/idem/page`、`GET /syn/overview?window=24h` |
| 投递入口 / 手动重载 | `POST /syn/sync/{topic}`、`POST /syn/task/reload` |

`PUT /syn/task/{id}/enabled` 只回一个 `Ro<SynTaskVo>`，前端只取 `enabled` 这个权威布尔值，
不把 `extra` 当完整任务解析：包装差异（`extra` 为 null、字段缺失）不该让一次成功的启停
在转换函数里抛错、进而被当成失败回滚。所有写库接口都会发 `refresh.syn.task`，
各副本下一拍自动重载快照；顶栏「重载快照」是手动兜底，不是生效的必要条件。

启停的前端契约见 `src/hooks/task-cache.ts`：乐观补丁同时写 `enabled` 与 `spec.enabled`
（后端保存任务时用 `spec` 反推列，漏一个就会被随后的编辑悄悄改回去），连点用序号保证
最后一次生效，`onSuccess` 只标脏不立刻 refetch。请求期间开关**保持可点**，
`busy` 只加 `aria-busy` 和描边 —— 原生 `disabled` 会连 `click` 一起吞掉。
