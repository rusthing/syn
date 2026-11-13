/**
 * # 七站品牌配置与业务图形
 *
 * 唯一真源：七个前端各复制一份，禁止在单个项目里改这里的内容。
 * 业务特征只体现在三处：mark / 文案 / glyph；配色由 kit.css 的 data-brand 决定。
 * 图形统一 viewBox 520×236、统一线条粗细与字号，保证并排看是同一套插画语言。
 * SVG 片段保持纯静态（不含 JS 表达式），便于 showcase 直接抽取复用。
 */

import type { ReactNode } from "react";

export type BrandKey = "adm" | "jobx" | "msg" | "alarm" | "dbz" | "dtw" | "syn";

export interface LoginBrand {
  key: BrandKey;
  mark: string;
  name: string;
  en: string;
  /** 两行主标题，第二行用主题色强调 */
  headline: [string, string];
  description: string;
  features: [string, string, string];
  terms: string;
  glyph: ReactNode;
}

/* ------------------------------------------------------------------- adm */

const admGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="组织树到角色再到权限矩阵">
    <text x="20" y="26" className="g-txt-dim">ORG TREE</text>
    <text x="178" y="26" className="g-txt-dim">ROLE</text>
    <text x="310" y="26" className="g-txt-dim">PERMISSION MATRIX</text>
    <path d="M30 74 L30 100 L40 100" className="g-line" />
    <path d="M30 74 L30 140 L40 140" className="g-line" />
    <rect x="20" y="44" width="112" height="30" rx="7" className="g-box-accent" />
    <text x="32" y="64" className="g-txt-accent">ROOT / 组织</text>
    <rect x="40" y="88" width="92" height="26" rx="6" className="g-box" />
    <text x="52" y="106" className="g-txt">研发中心</text>
    <rect x="40" y="128" width="92" height="26" rx="6" className="g-box" />
    <text x="52" y="146" className="g-txt">运维中心</text>
    <rect x="178" y="84" width="96" height="62" rx="9" className="g-box-accent" />
    <text x="192" y="108" className="g-txt-accent">ROLE</text>
    <text x="192" y="128" className="g-txt-dim">role:admin</text>
    <path d="M132 59 C158 59 156 104 178 104" className="g-flow" />
    <path d="M132 101 C150 101 158 120 178 122" className="g-line" />
    <path d="M274 115 C292 115 294 92 310 92" className="g-flow" />
    <rect x="310" y="46" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="337" y="46" width="22" height="18" rx="3" className="g-box" />
    <rect x="364" y="46" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="391" y="46" width="22" height="18" rx="3" className="g-box" />
    <rect x="418" y="46" width="22" height="18" rx="3" className="g-box" />
    <rect x="445" y="46" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="472" y="46" width="22" height="18" rx="3" className="g-box" />
    <rect x="310" y="70" width="22" height="18" rx="3" className="g-box" />
    <rect x="337" y="70" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="364" y="70" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="391" y="70" width="22" height="18" rx="3" className="g-box" />
    <rect x="418" y="70" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="445" y="70" width="22" height="18" rx="3" className="g-box" />
    <rect x="472" y="70" width="22" height="18" rx="3" className="g-box" />
    <rect x="310" y="94" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="337" y="94" width="22" height="18" rx="3" className="g-box" />
    <rect x="364" y="94" width="22" height="18" rx="3" className="g-box" />
    <rect x="391" y="94" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="418" y="94" width="22" height="18" rx="3" className="g-box" />
    <rect x="445" y="94" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="472" y="94" width="22" height="18" rx="3" className="g-box" />
    <rect x="310" y="118" width="22" height="18" rx="3" className="g-box" />
    <rect x="337" y="118" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="364" y="118" width="22" height="18" rx="3" className="g-box" />
    <rect x="391" y="118" width="22" height="18" rx="3" className="g-box" />
    <rect x="418" y="118" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="445" y="118" width="22" height="18" rx="3" className="g-box" />
    <rect x="472" y="118" width="22" height="18" rx="3" className="g-box" />
    <rect x="310" y="142" width="22" height="18" rx="3" className="g-box" />
    <rect x="337" y="142" width="22" height="18" rx="3" className="g-box" />
    <rect x="364" y="142" width="22" height="18" rx="3" className="g-box-accent" />
    <rect x="391" y="142" width="22" height="18" rx="3" className="g-box" />
    <rect x="418" y="142" width="22" height="18" rx="3" className="g-box" />
    <rect x="445" y="142" width="22" height="18" rx="3" className="g-box" />
    <rect x="472" y="142" width="22" height="18" rx="3" className="g-box" />
    <text x="310" y="180" className="g-txt-dim">MENU · ACTION · DATA SCOPE</text>
    <path d="M20 202 L500 202" className="g-line" />
    <text x="20" y="224" className="g-txt-accent">RBAC → REALM / ORG / APP SCOPE → SERVER AUTHZ</text>
  </svg>
);

/* ------------------------------------------------------------------ jobx */

const jobxGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="cron 时间轴上的任务条与执行器">
    <text x="20" y="24" className="g-txt-dim">SCHEDULE TIMELINE</text>
    <path d="M60 44 L496 44" className="g-line" />
    <path d="M60 38 L60 50 M133 38 L133 50 M206 38 L206 50 M279 38 L279 50 M352 38 L352 50 M425 38 L425 50 M496 38 L496 50" className="g-line" />
    <text x="54" y="34" className="g-txt-dim">00</text>
    <text x="127" y="34" className="g-txt-dim">04</text>
    <text x="200" y="34" className="g-txt-dim">08</text>
    <text x="273" y="34" className="g-txt-dim">12</text>
    <text x="346" y="34" className="g-txt-dim">16</text>
    <text x="419" y="34" className="g-txt-dim">20</text>
    <text x="484" y="34" className="g-txt-dim">24</text>
    <text x="20" y="80" className="g-txt">JOB-01</text>
    <text x="20" y="114" className="g-txt">JOB-02</text>
    <text x="20" y="148" className="g-txt">JOB-03</text>
    <rect x="98" y="64" width="152" height="22" rx="6" className="g-box-accent" />
    <rect x="190" y="98" width="212" height="22" rx="6" className="g-box-accent" />
    <rect x="306" y="132" width="96" height="22" rx="6" className="g-box" />
    <circle cx="250" cy="75" r="3" className="g-pulse" />
    <circle cx="402" cy="109" r="3" className="g-pulse" />
    <path d="M60 58 L60 166" className="g-dash" />
    <path d="M352 58 L352 166" className="g-dash" />
    <text x="98" y="79" className="g-txt-dim">sync-order</text>
    <text x="200" y="113" className="g-txt-dim">cleanup / sharding</text>
    <text x="314" y="147" className="g-txt-dim">report</text>
    <path d="M20 180 L500 180" className="g-line" />
    <text x="20" y="204" className="g-txt-dim">CRON</text>
    <text x="20" y="224" className="g-txt-accent">0 0/5 * * * ?</text>
    <rect x="250" y="192" width="70" height="28" rx="6" className="g-box" />
    <text x="262" y="211" className="g-txt">EX-01</text>
    <rect x="330" y="192" width="70" height="28" rx="6" className="g-box-accent" />
    <text x="342" y="211" className="g-txt-accent">EX-02</text>
    <rect x="410" y="192" width="70" height="28" rx="6" className="g-box" />
    <text x="422" y="211" className="g-txt">EX-03</text>
  </svg>
);

/* ------------------------------------------------------------------- msg */

const msgGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="消息经模板与渠道扇出到多个接收端">
    <text x="20" y="24" className="g-txt-dim">MESSAGE FAN-OUT</text>
    <rect x="20" y="86" width="116" height="66" rx="9" className="g-box-accent" />
    <path d="M38 104 L78 104 L78 132 L38 132 Z" className="g-line-accent" />
    <path d="M38 104 L58 120 L78 104" className="g-line-accent" />
    <text x="94" y="112" className="g-txt-accent">EVENT</text>
    <text x="94" y="130" className="g-txt-dim">payload</text>
    <rect x="190" y="46" width="112" height="46" rx="8" className="g-box" />
    <text x="204" y="66" className="g-txt">TEMPLATE</text>
    <text x="204" y="82" className="g-txt-dim">title / body</text>
    <rect x="190" y="146" width="112" height="46" rx="8" className="g-box" />
    <text x="204" y="166" className="g-txt">CHANNEL</text>
    <text x="204" y="182" className="g-txt-dim">route / retry</text>
    <rect x="370" y="28" width="130" height="40" rx="8" className="g-box" />
    <text x="384" y="53" className="g-txt">SMS</text>
    <rect x="370" y="98" width="130" height="40" rx="8" className="g-box-accent" />
    <text x="384" y="123" className="g-txt-accent">MAIL</text>
    <rect x="370" y="168" width="130" height="40" rx="8" className="g-box" />
    <text x="384" y="193" className="g-txt">WEBHOOK</text>
    <path d="M136 112 C164 112 162 69 190 69" className="g-flow" />
    <path d="M136 126 C164 126 162 169 190 169" className="g-line" />
    <path d="M302 69 C336 69 338 48 370 48" className="g-flow" />
    <path d="M302 169 C336 169 338 118 370 118" className="g-flow" />
    <path d="M302 169 C336 169 338 188 370 188" className="g-line" />
    <circle cx="370" cy="48" r="3" className="g-pulse" />
    <circle cx="370" cy="118" r="3" className="g-pulse" />
    <path d="M20 220 L500 220" className="g-line" />
    <text x="330" y="216" className="g-txt-dim">SEND LOG · RECEIPT · RETRY</text>
  </svg>
);

/* ----------------------------------------------------------------- alarm */

const alarmGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="报警波形越过阈值并按等级分流">
    <text x="20" y="24" className="g-txt-dim">ALERT STREAM</text>
    <path d="M20 66 L360 66" className="g-dash" />
    <text x="20" y="59" className="g-txt-accent">THRESHOLD</text>
    <path d="M20 158 L60 158 L78 150 L96 154 L114 132 L132 156 L150 152 L168 118 L186 150 L204 146 L222 96 L240 144 L258 150 L276 46 L294 138 L312 152 L330 148 L348 154 L360 150" className="g-line" />
    <path d="M258 150 L276 46 L294 138" className="g-line-accent" />
    <circle cx="276" cy="46" r="5" className="g-pulse" />
    <text x="286" y="40" className="g-txt-accent">EVENT</text>
    <path d="M20 172 L360 172" className="g-line" />
    <text x="20" y="190" className="g-txt-dim">00:00</text>
    <text x="160" y="190" className="g-txt-dim">00:30</text>
    <text x="316" y="190" className="g-txt-dim">01:00</text>
    <path d="M382 172 L500 172" className="g-line" />
    <rect x="392" y="132" width="20" height="40" rx="3" className="g-box" />
    <rect x="420" y="112" width="20" height="60" rx="3" className="g-box" />
    <rect x="448" y="92" width="20" height="80" rx="3" className="g-box" />
    <rect x="476" y="64" width="20" height="108" rx="3" className="g-box-accent" />
    <text x="394" y="190" className="g-txt-dim">P1</text>
    <text x="422" y="190" className="g-txt-dim">P2</text>
    <text x="450" y="190" className="g-txt-dim">P3</text>
    <text x="478" y="190" className="g-txt-accent">P4</text>
    <path d="M20 210 L500 210" className="g-line" />
    <text x="20" y="230" className="g-txt-accent">EVENT → POLICY → NOTIFY → MANUAL RECOVER</text>
    <text x="392" y="230" className="g-txt-dim">LEVEL</text>
  </svg>
);

/* ------------------------------------------------------------------- dbz */

const dbzGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="CDC 数据从源库经连接器与 topic 投递到 sink">
    <text x="20" y="24" className="g-txt-dim">CHANGE DATA CAPTURE</text>
    <path d="M24 82 C24 72 92 72 92 82 L92 158 C92 168 24 168 24 158 Z" className="g-box" />
    <path d="M24 82 C24 92 92 92 92 82" className="g-line" />
    <path d="M24 100 C24 110 92 110 92 100" className="g-line" />
    <path d="M24 140 C24 150 92 150 92 140" className="g-line" />
    <text x="36" y="132" className="g-txt">DB</text>
    <rect x="150" y="96" width="94" height="48" rx="8" className="g-box-accent" />
    <text x="160" y="116" className="g-txt-accent">CONNECTOR</text>
    <text x="160" y="132" className="g-txt-dim">source</text>
    <rect x="278" y="52" width="120" height="24" rx="5" className="g-box" />
    <rect x="278" y="96" width="120" height="24" rx="5" className="g-box" />
    <rect x="278" y="140" width="120" height="24" rx="5" className="g-box" />
    <rect x="348" y="56" width="16" height="16" rx="3" className="g-box-accent" />
    <rect x="328" y="100" width="16" height="16" rx="3" className="g-box-accent" />
    <rect x="368" y="144" width="16" height="16" rx="3" className="g-box-accent" />
    <text x="284" y="45" className="g-txt-dim">TOPIC / PARTITION</text>
    <text x="284" y="89" className="g-txt-dim">offset 1082</text>
    <text x="284" y="133" className="g-txt-dim">offset 1083</text>
    <path d="M92 120 C120 120 124 120 150 120" className="g-flow" />
    <path d="M244 120 C260 120 262 64 278 64" className="g-flow" />
    <path d="M244 120 L278 108" className="g-line" />
    <path d="M244 120 C260 120 262 152 278 152" className="g-line" />
    <path d="M398 64 C416 64 418 120 438 120" className="g-flow" />
    <path d="M438 82 C438 72 500 72 500 82 L500 158 C500 168 438 168 438 158 Z" className="g-box" />
    <path d="M438 82 C438 92 500 92 500 82" className="g-line" />
    <text x="452" y="132" className="g-txt">SINK</text>
    <text x="20" y="196" className="g-txt-dim">SOURCE</text>
    <text x="150" y="196" className="g-txt-dim">CONNECTOR</text>
    <text x="278" y="196" className="g-txt-dim">KAFKA / OFFSET</text>
    <text x="438" y="196" className="g-txt-dim">SINK</text>
    <path d="M20 210 L500 210" className="g-line" />
    <text x="20" y="230" className="g-txt-accent">BINLOG → CONNECTOR → TOPIC → SINK · DEAD LETTER</text>
  </svg>
);

/* ------------------------------------------------------------------- dtw */

const dtwGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="WKT 区域多边形、围栏与定位点">
    <text x="20" y="24" className="g-txt-dim">SPATIAL REGION / WKT</text>
    <path d="M20 60 L320 60 M20 110 L320 110 M20 160 L320 160 M70 34 L70 200 M160 34 L160 200 M250 34 L250 200" className="g-grid" />
    <path d="M40 62 L196 42 L300 82 L272 186 L112 200 L30 148 Z" className="g-area" />
    <path d="M146 88 L238 80 L256 138 L208 170 L140 156 Z" className="g-box" />
    <circle cx="190" cy="120" r="32" className="g-ring" strokeDasharray="4 5" />
    <circle cx="190" cy="120" r="5" className="g-pulse" />
    <circle cx="92" cy="128" r="4" className="g-dot" />
    <circle cx="255" cy="102" r="4" className="g-dot-dim" />
    <text x="204" y="116" className="g-txt-accent">R = 50m</text>
    <text x="34" y="218" className="g-txt-dim">POLYGON ((x y, ...)) · 2D GEOM</text>
    <rect x="340" y="44" width="160" height="146" rx="9" className="g-box" />
    <text x="356" y="68" className="g-txt-accent">REGION TREE</text>
    <path d="M356 78 L484 78" className="g-line" />
    <text x="356" y="98" className="g-txt">园区 / 楼栋 / 楼层</text>
    <text x="356" y="120" className="g-txt">GEOFENCE RULE</text>
    <text x="356" y="142" className="g-txt">LOCATOR × 3</text>
    <text x="356" y="164" className="g-txt-dim">禁入 · 滞留 · 聚集</text>
    <circle cx="478" cy="60" r="3" className="g-pulse" />
    <text x="340" y="218" className="g-txt-dim">围栏内外 · 实时判定</text>
  </svg>
);

/* ------------------------------------------------------------------- syn */

const synGlyph = (
  <svg viewBox="0 0 520 236" className="sl-glyph" role="img" aria-label="取数、映射、投递与幂等回流">
    <text x="20" y="24" className="g-txt-dim">SYNC PIPELINE / IDEMPOTENCY</text>
    <rect x="20" y="52" width="116" height="56" rx="9" className="g-box" />
    <text x="34" y="76" className="g-txt">SOURCE</text>
    <text x="34" y="94" className="g-txt-dim">取数来源</text>
    <rect x="202" y="52" width="116" height="56" rx="9" className="g-box-accent" />
    <text x="216" y="76" className="g-txt-accent">MAPPING</text>
    <text x="216" y="94" className="g-txt-dim">规则 / 断言</text>
    <rect x="384" y="52" width="116" height="56" rx="9" className="g-box" />
    <text x="398" y="76" className="g-txt">DELIVERY</text>
    <text x="398" y="94" className="g-txt-dim">投递目标</text>
    <path d="M136 80 L202 80" className="g-flow" />
    <path d="M196 76 L202 80 L196 84" className="g-line-accent" />
    <path d="M318 80 L384 80" className="g-flow" />
    <path d="M378 76 L384 80 L378 84" className="g-line-accent" />
    <rect x="20" y="140" width="116" height="40" rx="8" className="g-box" />
    <text x="34" y="165" className="g-txt">PLAYGROUND</text>
    <rect x="202" y="140" width="116" height="40" rx="8" className="g-box-accent" />
    <text x="216" y="165" className="g-txt-accent">IDEM KEY</text>
    <rect x="384" y="140" width="116" height="40" rx="8" className="g-box" />
    <text x="398" y="165" className="g-txt">SEND LOG</text>
    <path d="M78 108 L78 140" className="g-dash" />
    <path d="M260 108 L260 140" className="g-dash" />
    <path d="M442 108 L442 140" className="g-dash" />
    <path d="M442 180 C442 206 78 206 78 180" className="g-dash" />
    <circle cx="78" cy="180" r="3" className="g-pulse" />
    <text x="228" y="202" className="g-txt-dim">RETRY / REPLAY</text>
    <path d="M20 218 L500 218" className="g-line" />
    <text x="20" y="232" className="g-txt-accent">SOURCE → SPEC → PLAYGROUND → DELIVERY</text>
  </svg>
);

export const BRANDS: Record<BrandKey, LoginBrand> = {
  adm: {
    key: "adm",
    mark: "AD",
    name: "Adm Console",
    en: "IDENTITY & ACCESS",
    headline: ["身份、角色与授权，", "收拢到一张桌面。"],
    description:
      "用户、组织、菜单与权限在这里集中维护；登录后可见的页面由当前账号的角色与可见范围实时下发，功能权限最终以服务端鉴权为准。",
    features: ["用户与组织域", "角色 · 菜单 · 权限", "三轴可见范围"],
    terms: "RBAC · URN · DATA SCOPE",
    glyph: admGlyph,
  },
  jobx: {
    key: "jobx",
    mark: "JX",
    name: "JobX 调度台",
    en: "JOB ORCHESTRATION",
    headline: ["让每一个任务，", "都踩在准确的时间点上。"],
    description:
      "作业、分组、执行器与任务实例同屏对照；cron 计划、分片与失败重投在一个控制台里闭环，调度状态一眼可查。",
    features: ["作业与分组", "执行器健康", "任务实例追踪"],
    terms: "CRON · SHARD · EXECUTOR",
    glyph: jobxGlyph,
  },
  msg: {
    key: "msg",
    mark: "MG",
    name: "消息中心",
    en: "MESSAGE DELIVERY",
    headline: ["从模板到送达，", "把投递链路看清楚。"],
    description:
      "维护消息定义、渠道与模板，追踪每一次发送与回执；模板编辑、通道配置与投递记录集中在同一处，链路不再靠猜。",
    features: ["消息定义", "渠道与模板", "发送与回执"],
    terms: "TEMPLATE · CHANNEL · SEND LOG",
    glyph: msgGlyph,
  },
  alarm: {
    key: "alarm",
    mark: "AL",
    name: "报警中心",
    en: "ALERT RESPONSE",
    headline: ["事件进来的那一刻，", "等级与去向已经确定。"],
    description:
      "按事件策略判定等级、匹配通知链路；支持人工消警、恢复事件与队列回溯，让每一次告警都有始有终。",
    features: ["事件策略", "等级与通知", "人工消警"],
    terms: "POLICY · LEVEL · RECOVER",
    glyph: alarmGlyph,
  },
  dbz: {
    key: "dbz",
    mark: "DZ",
    name: "Debezium 控制台",
    en: "CHANGE DATA CAPTURE",
    headline: ["捕获每一次变更，", "不丢任何一条偏移。"],
    description:
      "管理 source / sink 连接器、Kafka topic 与死信；从 binlog 到投递，链路状态与偏移量一目了然，高风险操作另有二次确认。",
    features: ["连接器管理", "Topic 与分区", "死信与偏移量"],
    terms: "CDC · OFFSET · DEAD LETTER",
    glyph: dbzGlyph,
  },
  dtw: {
    key: "dtw",
    mark: "DT",
    name: "DTW 数字孪生",
    en: "SPATIAL CONSOLE",
    headline: ["把空间画成区域，", "把区域变成规则。"],
    description:
      "以区域树组织空间、按 WKT 维护 2D 几何；报警规则、定位卡与人员在同屏对照，围栏内外一眼可辨。",
    features: ["区域树与 WKT", "围栏规则", "定位卡绑定"],
    terms: "WKT · GEOFENCE · LOCATOR",
    glyph: dtwGlyph,
  },
  syn: {
    key: "syn",
    mark: "SY",
    name: "Syn 同步台",
    en: "DATA SYNC",
    headline: ["取数、映射、投递，", "每一步都可以试跑。"],
    description:
      "定义取数来源与任务规则，先试跑再投递；幂等键、断言与投递记录让同步链路可回放、可核对。",
    features: ["取数来源", "规则与试跑", "幂等与投递记录"],
    terms: "SOURCE · PLAYGROUND · IDEM KEY",
    glyph: synGlyph,
  },
};
