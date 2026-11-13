# syn-web · 同步控制台

`syn` 的前端工程：任务规则（五段）、取数来源、试跑、投递记录、幂等台账。

技术栈跟 `jobx-web` 保持一致，不另起一套：React 19 + Vite 7 + Tailwind 4 +
React Router 7 + TanStack Query + lucide-react。没有引组件库 —— 一个控制台需要的
表格、抽屉、开关、提示，自己写比配主题便宜。

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

- 守卫的断言默认对**记录**求值，看请求体要显式 `scope: body`；
- 映射的 `omit_null` 是全局语义，`on_empty` 只处理「变换之后变空」；
- 判定首命中即停，末条不带 `field`，没命中任何规则时按 `UNCLASSIFIED` 失败；
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

## 后端还缺什么

界面按 `doc/syn-开发规范.md` §7 的路径调用下面这些接口。目前 `syn-svr` 只有
`POST /syn/sync/{topic}` 与 `POST /syn/task/reload`，其余返回 404 时页面会明确提示
「syn-svr 尚未提供该能力」，不会白屏：

| 页面 | 接口 |
|---|---|
| 任务 | `GET/POST/PUT/DELETE /syn/task[/{id}]`、`PUT /syn/task/{id}/enabled` |
| 来源 | `GET /syn/source/list`、`POST /syn/source/{id}/pull`、`PUT /syn/source/{id}/enabled` |
| 投递 | `GET /syn/delivery/page` |
| 幂等 | `GET /syn/idem/page` |
| 总览 | `GET /syn/overview?window=24h` |

补齐它们属于 `syn-api` 的 `mo/dto/vo/dic` + `dao/svc/ctrl/router/api_doc` 五件套，
是规范 §13 里还没打勾的那部分。
