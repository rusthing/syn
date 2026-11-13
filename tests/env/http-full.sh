#!/usr/bin/env bash
# http 全量分页取数的真库联调。
#
# 验的是「首次同步」这条路：一轮推一页、空页收尾、翻到底标 done、此后不再拉、
# reset 能重跑同一批。数据由 `tests/env/mock-paging.py` 提供（3 页 7 行 + token 模式）。
#
# 前提：先跑 `tests/env/run.sh`（建隔离表 `syn_it_person`；来源/任务的清理规则见那边）。
# 本脚本只用 9007 与 19098，跑完自动停服务、删自己建的源与任务。
#
# 用法：tests/env/http-full.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="$ROOT/tests/env"
BIN="$ROOT/target/debug/syn-svr"
API="http://127.0.0.1:9007"
MOCK="http://127.0.0.1:19098"
PG_CONTAINER="${PG_CONTAINER:-pgsql}"
PG_USER="${PG_USER:-postgres}"
LOG="${TMPDIR:-/tmp}/syn-http-full.log"
MOCK_LOG="${TMPDIR:-/tmp}/syn-mock-paging.log"
RESP="${TMPDIR:-/tmp}/syn-http-resp.json"
TMP="${TMPDIR:-/tmp}/syn-http"
SVR_PID=""
MOCK_PID=""
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

pg() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
q() { pg "$1" -Atc "$2"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '\n\033[31mFAIL: %s\033[0m\n' "$1" >&2
  printf '\n--- syn-svr 日志尾部 ---\n' >&2; tail -40 "$LOG" >&2 || true
  printf '\n--- mock 日志 ---\n' >&2; tail -10 "$MOCK_LOG" >&2 || true
  exit 1
}
assert_eq() { [ "$2" = "$3" ] || fail "${1}：期望 [${2}]，实际 [${3}]"; ok "$1 = ${3}"; }

# 只删自己建的源与任务，按 code 精确匹配。
# **退出时也要删**：留着它们会让 run.sh 的「剩余来源数」断言变成 3，而且 http 全量源
# 一旦停在「未完成」，jobx 心跳会每拍继续推它。
clean_config() {
  cat >"$TMP/clean.sql" <<'SQL'
delete from syn_idem where task_id in (select id from syn_task where code in ('http_page_to_dtw','http_token_to_dtw'));
delete from syn_task_version where task_id in (select id from syn_task where code in ('http_page_to_dtw','http_token_to_dtw'));
delete from syn_cursor where source_id in (select id from syn_source where code in ('http_page','http_token'));
delete from syn_task where code in ('http_page_to_dtw','http_token_to_dtw');
delete from syn_source where code in ('http_page','http_token');
SQL
  pg syn -q -c "$(cat "$TMP/clean.sql")" || true
}

cleanup() {
  for p in "${MOCK_PID:-}" "${SVR_PID:-}"; do
    [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true
  done
  for p in "${MOCK_PID:-}" "${SVR_PID:-}"; do
    [ -n "$p" ] && wait "$p" 2>/dev/null || true
  done
  clean_config
}
trap cleanup EXIT

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_port() {
  for _ in $(seq 1 60); do port_busy "$1" && return 0; sleep 0.5; done
  fail "$1 端口未在 30s 内监听（$2）"
}
req() { # method path [data-file]；响应写 $RESP，回显状态码
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -o "$RESP" -w '%{http_code}' -X "$method" "${API}${path}" \
      -H 'Content-Type: application/json' -H 'X-User-Id: 1' --data-binary @"$data"
  else
    curl -sS -o "$RESP" -w '%{http_code}' -X "$method" "${API}${path}" -H 'X-User-Id: 1'
  fi
}
resp() { jq -r "$1" "$RESP"; }
pull() { # source-id [reset]
  local path="/syn/source/$1/pull"
  [ "${2:-}" = "reset" ] && path="${path}?reset=true"
  req POST "$path"
}
hits() { curl -sS --noproxy '*' "$MOCK/stats" | jq -r ".${1}_hits"; }

mkdir -p "$TMP"

say "前置检查"
port_busy 9007 && fail "9007 已被占用（先停掉 run.sh 起的服务）"
port_busy 19098 && fail "19098 已被占用（mock 没退干净？）"
[ -f "$BIN" ] || fail "缺少 $BIN，先 cargo build -p syn-svr"
q admrs "select 1 from information_schema.tables where table_schema='public' and table_name='syn_it_person'" \
  | grep -q 1 || fail "隔离表不存在，先跑 tests/env/run.sh"
command -v python3 >/dev/null || fail "需要 python3 跑 mock 分页服务"

clean_config
q dtwrs_ui "delete from public.syn_it_person where id between 3001 and 3007 or id between 4001 and 4004" >/dev/null
ok "环境干净（无残留源/任务/目标行）"

say "起 mock 与 syn"
python3 "$ENV_DIR/mock-paging.py" 19098 >"$MOCK_LOG" 2>&1 &
MOCK_PID=$!
wait_port 19098 mock
"$BIN" -c "$ENV_DIR/syn-svr-a.toml" >"$LOG" 2>&1 &
SVR_PID=$!
wait_port 9007 syn
ok "mock 与 syn 都已监听"

say "建源与任务"
cat >"$TMP/source-page.json" <<'JSON'
{
  "code": "http_page",
  "name": "人员全量（页码模式）",
  "kind": 1,
  "enabled": true,
  "intervalDuration": "60s",
  "batchSize": 3,
  "remark": "env 联调：http 全量，page={cursor} 页码模式",
  "spec": {
    "url": "http://127.0.0.1:19098/api/page?page={cursor}&size={size}",
    "data_path": "$.data.list",
    "page_size": 3,
    "wrap": "row"
  }
}
JSON
cat >"$TMP/source-token.json" <<'JSON'
{
  "code": "http_token",
  "name": "人员全量（token 模式）",
  "kind": 1,
  "enabled": true,
  "intervalDuration": "60s",
  "batchSize": 3,
  "remark": "env 联调：http 全量，next_path 走 token 翻页",
  "spec": {
    "url": "http://127.0.0.1:19098/api/token?cursor={cursor}&size={size}",
    "data_path": "$.data.list",
    "next_path": "$.data.nextCursor",
    "page_size": 3,
    "wrap": "row"
  }
}
JSON

task_json() { # code topic
  cat <<JSON
{
  "name": "HTTP 全量直写（$1）",
  "remark": "env 联调：http poll -> db sink on conflict do update",
  "spec": {
    "id": "$1",
    "topic": "source:$2",
    "priority": 100,
    "enabled": true,
    "exclusive": true,
    "target": {
      "kind": "db",
      "datasource": "dtw",
      "table": "public.syn_it_person",
      "key": ["id"],
      "on_conflict": "update"
    },
    "match": [],
    "mapping": {
      "omit_null": true,
      "rows": [
        { "to": "id", "from": "\$.after.id" },
        { "to": "name", "from": "\$.after.name" },
        { "to": "updated_at", "from": "\$.after.updated_at" }
      ]
    },
    "actions": [{ "op": "r", "method": "POST", "path": "", "body": "mapped" }],
    "guards": [],
    "outcomes": [
      { "scope": "body", "assert": [{ "field": "\$.affected", "op": "gt", "value": 0 }], "verdict": "success", "code": "DB_OK" },
      { "scope": "status", "assert": [{ "op": "in", "value": [200] }], "verdict": "fatal", "code": "DB_NO_ROW" }
    ]
  }
}
JSON
}

assert_eq "建页码源" "200" "$(req POST /syn/source "$TMP/source-page.json")"
PAGE_ID="$(resp '.extra.id')"
assert_eq "建 token 源" "200" "$(req POST /syn/source "$TMP/source-token.json")"
TOKEN_ID="$(resp '.extra.id')"
task_json http_page_to_dtw http_page >"$TMP/task-page.json"
task_json http_token_to_dtw http_token >"$TMP/task-token.json"
assert_eq "建页码任务" "200" "$(req POST /syn/task "$TMP/task-page.json")"
assert_eq "建 token 任务" "200" "$(req POST /syn/task "$TMP/task-token.json")"
assert_eq "重载快照" "200" "$(req POST /syn/task/reload)"
ok "来源 $PAGE_ID / $TOKEN_ID 已就绪"

say "页码模式：一轮一页，空页收尾"
HITS0="$(hits page)"
assert_eq "第 1 页" "200 3 false" "$(pull "$PAGE_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "第 2 页" "200 3 false" "$(pull "$PAGE_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "第 3 页（最后 1 行）" "200 1 false" "$(pull "$PAGE_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "第 4 页（空页即结束）" "200 0 true" "$(pull "$PAGE_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "下游 7 行" "7" "$(q dtwrs_ui "select count(*) from public.syn_it_person where id between 3001 and 3007")"
assert_eq "累计行数记 7" "7" "$(q syn "select rows_synced from syn_cursor where source_id=$PAGE_ID")"
case "$(q syn "select cursor_value from syn_cursor where source_id=$PAGE_ID")" in
  *'"done":true'*) ok "游标已标记 done" ;;
  *) fail "游标没有 done 标记：$(q syn "select cursor_value from syn_cursor where source_id=$PAGE_ID")" ;;
esac

say "已完成：不再打源接口，也不再重复投递"
HITS_DONE="$(hits page)"
assert_eq "再拉一轮返回已完成" "200 0 true" "$(pull "$PAGE_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "源接口没被再打一次" "$HITS_DONE" "$(hits page)"
assert_eq "下游没多出行" "7" "$(q dtwrs_ui "select count(*) from public.syn_it_person where id between 3001 and 3007")"
assert_eq "本轮确实打过 4 次源接口" "$((HITS0 + 4))" "$HITS_DONE"

say "reset：从第一页重跑，upsert 不增行"
assert_eq "reset 后第 1 页" "200 3 false" "$(pull "$PAGE_ID" reset) $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "重跑后下游仍是 7 行" "7" "$(q dtwrs_ui "select count(*) from public.syn_it_person where id between 3001 and 3007")"
assert_eq "reset 清了累计行数再计" "3" "$(q syn "select rows_synced from syn_cursor where source_id=$PAGE_ID")"

say "token 模式：next_path 翻页"
assert_eq "第 1 页" "200 3 false" "$(pull "$TOKEN_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "第 2 页（next 为空即结束）" "200 1 true" "$(pull "$TOKEN_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "下游 4 行" "4" "$(q dtwrs_ui "select count(*) from public.syn_it_person where id between 4001 and 4004")"
TOKEN_HITS="$(hits token)"
assert_eq "完成后不再打接口" "200 0 true" "$(pull "$TOKEN_ID") $(resp '.extra.rows') $(resp '.extra.fullDone')"
assert_eq "token 源接口调用数不变" "$TOKEN_HITS" "$(hits token)"

printf '\n\033[32m全部通过\033[0m：页模式与 token 模式都能一轮一页翻到底，done 后不再拉，reset 可重跑。\n'
printf '日志：%s\n' "$LOG"
