#!/usr/bin/env bash
# syn 真实测试环境联调。
#
# 与 tests/e2e/run.sh（三个隔离库 + `-c` 绕开配置中心）分工不同，这里验的是
# **部署形态**：默认 syn-svr.toml + consul KV `dev/syn-svr.toml` 覆盖，
# 服务库用已建好的 `syn`，源/目标落在现有业务库 `admrs` / `dtwrs_ui`。
#
# 用法：
#   tests/env/run.sh            # 跑完全链路，结束时停掉自己启动的服务
#   tests/env/run.sh --keep     # 同上，但保留服务在 9007 供界面查看
#   tests/env/run.sh --cleanup  # 只清理联调数据与隔离表，不启动服务
#
# 跨副本的游标 CAS 不在这个脚本里（单实例撞不上），见 `tests/env/concurrent-pull.sh`。
# http 全量分页也不在这里（要一个分页假接口），见 `tests/env/http-full.sh`。
#
# 安全边界：只碰这三处，绝不改任何已有业务表、任何其它 consul 键：
#   1. consul KV `dev/syn-svr.toml`
#   2. `admrs.public.syn_it_person` / `dtwrs_ui.public.syn_it_person`（本脚本建的隔离表）
#   3. `syn` 库里 code 精确等于 adm_person / adm_person_to_dtw / tmp_delete_me 的配置行

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="$ROOT/tests/env"
BIN="$ROOT/target/debug/syn-svr"
CONSUL="${CONSUL_URL:-http://127.0.0.1:8500}"
API="http://127.0.0.1:9007"
PG_CONTAINER="${PG_CONTAINER:-pgsql}"
PG_USER="${PG_USER:-postgres}"
LOG="${TMPDIR:-/tmp}/syn-env-svr.log"
RESP="${TMPDIR:-/tmp}/syn-env-resp.json"
SVR_PID=""
STARTED=0
KEEP=0

pg() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
q() { pg "$1" -Atc "$2"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '\n\033[31mFAIL: %s\033[0m\n' "$1" >&2
  printf '\n--- syn-svr 日志尾部 ---\n' >&2
  tail -40 "$LOG" >&2 || true
  exit 1
}
assert_eq() { [ "$2" = "$3" ] || fail "${1}：期望 [${2}]，实际 [${3}]"; ok "$1 = ${3}"; }
req() { # method path [data-file]；响应写 $RESP，回显 HTTP 状态码
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -o "$RESP" -w '%{http_code}' -X "$method" "${API}${path}" \
      -H 'Content-Type: application/json' -H 'X-User-Id: 1' --data-binary @"$data"
  else
    curl -sS -o "$RESP" -w '%{http_code}' -X "$method" "${API}${path}" -H 'X-User-Id: 1'
  fi
}
resp() { jq -r "$1" "$RESP"; }

stop_server() {
  if [ "$STARTED" = "1" ] && [ "$KEEP" = "0" ] && [ -n "$SVR_PID" ] && kill -0 "$SVR_PID" 2>/dev/null; then
    kill -TERM "$SVR_PID" 2>/dev/null || true
    wait "$SVR_PID" 2>/dev/null || true
  fi
  SVR_PID=""
}
trap stop_server EXIT

# 只清联调自己写的行；按 code 精确匹配，级联表先删
clean_config() {
  pg syn -c "
    delete from syn_idem where task_id in (select id from syn_task where code = 'adm_person_to_dtw');
    delete from syn_task_version where task_id in (select id from syn_task where code = 'adm_person_to_dtw');
    delete from syn_cursor where source_id in (select id from syn_source where code in ('adm_person','tmp_delete_me'));
    delete from syn_task where code = 'adm_person_to_dtw';
    delete from syn_source where code in ('adm_person','tmp_delete_me');
  " >/dev/null
}

# 隔离表重建：只在表名精确等于 syn_it_person 时操作
reset_tables() {
  pg admrs -c "drop table if exists public.syn_it_person" >/dev/null
  pg dtwrs_ui -c "drop table if exists public.syn_it_person" >/dev/null
  pg admrs -c "
    create table public.syn_it_person (id int8 primary key, name text not null, updated_at timestamptz not null);
    insert into public.syn_it_person (id,name,updated_at) values
      (1,'alice-adm', now() - interval '60 minutes'),
      (2,'bob-adm',   now() - interval '50 minutes'),
      (3,'carol-adm', now() - interval '40 minutes');
  " >/dev/null
  pg dtwrs_ui -c "
    create table public.syn_it_person (id int8 primary key, name text not null, updated_at timestamptz not null);
    insert into public.syn_it_person (id,name,updated_at) values (1,'alice-stale', now() - interval '2 days');
  " >/dev/null
}

for cmd in docker curl jq nc; do
  command -v "$cmd" >/dev/null || fail "缺少命令 ${cmd}"
done
q postgres 'select 1' >/dev/null || fail "连不上 ${PG_CONTAINER} 里的 PostgreSQL"
curl -sS -m 3 "${CONSUL}/v1/status/leader" >/dev/null || fail "连不上 consul：${CONSUL}"

if [ "${1:-}" = "--cleanup" ]; then
  clean_config
  pg admrs -c "drop table if exists public.syn_it_person" >/dev/null
  pg dtwrs_ui -c "drop table if exists public.syn_it_person" >/dev/null
  say "联调配置与隔离表已清理（consul KV 保留）"
  exit 0
fi
[ "${1:-}" = "--keep" ] && KEEP=1
[ -x "$BIN" ] || fail "找不到 ${BIN}，先跑 cargo build -p syn-svr"
if nc -z -G 1 127.0.0.1 9007 2>/dev/null; then
  fail "9007 已被占用；先停掉占用进程，本脚本要自己起服务验证配置中心链路"
fi

say "写入 consul KV dev/syn-svr.toml"
[ "$(curl -sS -X PUT --data-binary @"${ENV_DIR}/consul-dev.toml" "${CONSUL}/v1/kv/dev/syn-svr.toml")" = "true" ] \
  || fail "写 consul 失败"
ok "配置中心已就绪"

say "重建隔离表与初始数据"
reset_tables
clean_config
assert_eq "源表初始行数" "3" "$(q admrs 'select count(*) from public.syn_it_person')"
assert_eq "目标表预置脏行" "1" "$(q dtwrs_ui 'select count(*) from public.syn_it_person')"

say "启动 syn-svr（默认配置 + consul 覆盖，不加 -c）"
(cd "$(dirname "$BIN")" && "$BIN" --signal start >"$LOG" 2>&1) &
SVR_PID=$!
STARTED=1
for _ in $(seq 1 30); do
  if nc -z -G 1 127.0.0.1 9007 2>/dev/null; then break; fi
  sleep 1
done
if ! nc -z -G 1 127.0.0.1 9007 2>/dev/null; then fail "syn-svr 没在 9007 起来"; fi
ok "服务已就绪"
# consul 覆盖是否生效，看下面「可选数据源」：adm / dtw 只在 KV 里有，
# 仓库自带的 syn-svr.toml 一个数据源都没有，能列出来就说明 KV 真的合进来了。
if grep -q "settings not found" "$LOG"; then fail "启动日志里有配置缺失告警"; fi

say "数据源连接清单（只读，连接串不外泄）"
assert_eq "清单接口" "200" "$(req GET /syn/datasource/list)"
assert_eq "可选数据源" '["adm","dtw"]' "$(jq -c '[.extra[].name]|sort' "$RESP")"
assert_eq "不含连接串字段" "0" "$(jq -c '[.extra[]|has("url")]|map(select(.))|length' "$RESP")"

say "取数来源：新增 / 编辑 / 编码保护 / 删除"
assert_eq "新增来源" "200" "$(req POST /syn/source "${ENV_DIR}/source.json")"
assert_eq "虚拟 topic 自动生成" "source:adm_person" "$(resp '.extra.topic')"
assert_eq "kind 是 #[dic] 整数" "0" "$(resp '.extra.kind')"
SRC="$(resp '.extra.id')"
jq '.name="人员主数据增量（已改名）" | .intervalDuration="120s"' "${ENV_DIR}/source.json" > "${TMPDIR:-/tmp}/syn-env-source-update.json"
assert_eq "修改来源" "200" "$(req PUT "/syn/source/${SRC}" "${TMPDIR:-/tmp}/syn-env-source-update.json")"
assert_eq "还没跑过时水位诚实为 null" "null" "$(resp '.extra.cursor')"
jq '.code="renamed"' "${ENV_DIR}/source.json" > "${TMPDIR:-/tmp}/syn-env-source-bad.json"
assert_eq "编码不可改" "400" "$(req PUT "/syn/source/${SRC}" "${TMPDIR:-/tmp}/syn-env-source-bad.json")"
jq '.code="tmp_delete_me" | .name="临时来源"' "${ENV_DIR}/source.json" > "${TMPDIR:-/tmp}/syn-env-source-tmp.json"
assert_eq "新建临时来源" "200" "$(req POST /syn/source "${TMPDIR:-/tmp}/syn-env-source-tmp.json")"
TMP="$(resp '.extra.id')"
assert_eq "删除临时来源" "200" "$(req DELETE "/syn/source/${TMP}")"
req GET /syn/source/list >/dev/null
assert_eq "剩余来源数" "1" "$(jq -r '.extra|length' "$RESP")"

say "任务与快照"
assert_eq "创建 DB 直写任务" "200" "$(req POST /syn/task "${ENV_DIR}/task.json")"
assert_eq "目标表" "public.syn_it_person" "$(resp '.extra.spec.target.table')"
req POST /syn/task/reload >/dev/null
assert_eq "重载快照任务数" "1" "$(resp '.extra')"

say "poll → DB sink"
assert_eq "首轮拉取" "200" "$(req POST "/syn/source/${SRC}/pull")"
assert_eq "首轮 3 行" "3" "$(resp '.extra.rows')"
assert_eq "3 行全 success" "3" "$(resp '.extra.success')"
assert_eq "目标表 3 行" "3" "$(q dtwrs_ui 'select count(*) from public.syn_it_person')"
assert_eq "脏行被 on conflict 覆盖" "alice-adm" "$(q dtwrs_ui "select name from public.syn_it_person where id=1")"
assert_eq "游标累计 3 行" "3" "$(q syn 'select rows_synced from syn_cursor')"
req POST "/syn/source/${SRC}/pull" >/dev/null
assert_eq "空轮不重复写" "0" "$(resp '.extra.rows')"
pg admrs -c "insert into public.syn_it_person (id,name,updated_at) values (4,'dave-adm', now() - interval '10 minutes')" >/dev/null
req POST "/syn/source/${SRC}/pull" >/dev/null
assert_eq "增量轮 1 行" "1" "$(resp '.extra.rows')"
assert_eq "游标累计 4 行" "4" "$(q syn 'select rows_synced from syn_cursor')"
assert_eq "目标表 4 行" "4" "$(q dtwrs_ui 'select count(*) from public.syn_it_person')"
assert_eq "跑过后改配置" "200" "$(req PUT "/syn/source/${SRC}" "${TMPDIR:-/tmp}/syn-env-source-update.json")"
assert_eq "PUT 响应带水位" "4" "$(resp '.extra.cursor.rowsSynced')"
assert_eq "库里水位不变" "4" "$(q syn 'select rows_synced from syn_cursor')"

say "幂等台账"
idem() { # key json
  curl -sS -o "$RESP" -w '%{http_code}' -X POST "${API}/syn/sync/source:adm_person" \
    -H 'Content-Type: application/json' -H "X-Idempotency-Key: $1" --data-binary "$2"
}
assert_eq "首次投递" "200" "$(idem env-key-1 '{"op":"r","after":{"id":999,"name":"idem-first","updated_at":"2026-11-13T00:00:00Z"}}')"
assert_eq "台账 1 行" "1" "$(q syn 'select count(*) from syn_idem')"
pg dtwrs_ui -c "update public.syn_it_person set name='manual-edit' where id=999" >/dev/null
assert_eq "同键重投" "200" "$(idem env-key-1 '{"op":"r","after":{"id":999,"name":"idem-first","updated_at":"2026-11-13T00:00:00Z"}}')"
assert_eq "命中台账不改下游" "manual-edit" "$(q dtwrs_ui "select name from public.syn_it_person where id=999")"
assert_eq "台账仍 1 行" "1" "$(q syn 'select count(*) from syn_idem')"
assert_eq "缺冲突键应 400" "400" "$(idem env-key-2 '{"op":"r","after":{"name":"no-id","updated_at":"2026-11-13T00:00:00Z"}}')"
assert_eq "失败不记账" "1" "$(q syn 'select count(*) from syn_idem')"
assert_eq "同键重投正常记录" "200" "$(idem env-key-2 '{"op":"r","after":{"id":1000,"name":"retry-ok","updated_at":"2026-11-13T00:00:00Z"}}')"
assert_eq "台账 2 行" "2" "$(q syn 'select count(*) from syn_idem')"

say "控制台接口"
req GET '/syn/task/page?pageNum=1&pageSize=10' >/dev/null
assert_eq "任务分页" "1" "$(resp '.extra.total')"
req GET '/syn/source/page?pageNum=1&pageSize=10' >/dev/null
assert_eq "来源分页带水位" "4" "$(resp '.extra.list[0].cursor.rowsSynced')"
req GET '/syn/delivery/page?verdict=fatal' >/dev/null
assert_eq "失败不出现在投递记录" "0" "$(resp '.extra.total')"
req GET '/syn/delivery/page?taskCode=adm_person_to_dtw' >/dev/null
assert_eq "按 taskCode 筛选" "2" "$(resp '.extra.total')"
req GET '/syn/idem/page?pageNum=1&pageSize=20' >/dev/null
assert_eq "幂等分页" "2" "$(resp '.extra.total')"
req GET '/syn/overview?window=24h' >/dev/null
assert_eq "总览记账总数" "2" "$(resp '.extra.total')"
assert_eq "小时桶没漏掉当前小时（桶边界修复）" "2" "$(resp '[.extra.series[].success]|add')"

say "全部断言通过"
if [ "$KEEP" = "1" ]; then
  ok "服务保留在 ${API}（pid ${SVR_PID}），日志 ${LOG}"
  STARTED=0   # 不让 trap 停掉
else
  ok "服务将自动停止；联调数据保留便于排查"
fi
