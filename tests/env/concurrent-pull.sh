#!/usr/bin/env bash
# 多副本游标乐观锁并发验证。
#
# `tests/env/run.sh` 只起一个副本，所以 `advance_cursor` 里那条
# `where id = $6 and update_ms = $7` 的 CAS 永远命中不了对手 —— 它写得对，但没被验过。
# 这个脚本起**两个副本**（9007 / 9008，node 3 / 4，同库同数据源），同时打同一个源的
# pull，看三件事：
#
#   1. 水位只涨一轮（不是 2×N）—— 后写的那个 CAS 影响 0 行；
#   2. 失败方返回的 `extra.position` 为空，并留下「游标被并发更新」的 warn；
#   3. 两方都把行投到了下游（**重复投递是设计语义**），靠下游 upsert 吸收，
#      最终行数 = 前值 + N、无重复主键。
#
# 前提：先跑 `tests/env/run.sh`（建隔离表 `syn_it_person` 与来源 `adm_person`；
# 用 `--keep` 也行，但要在本脚本之前把它停掉 —— 9007 会被本脚本占用）。
#
# 用法：
#   tests/env/concurrent-pull.sh           # 默认插 300 行
#   ROWS=500 tests/env/concurrent-pull.sh  # 自定义批量（上限 = 源的 batch_size）
#
# 安全边界与 run.sh 相同：只碰 `admrs`/`dtwrs_ui` 的 `public.syn_it_person`
# （id 段 2001..2000+ROWS）与 `syn` 库里 code = adm_person 的配置行。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_DIR="$ROOT/tests/env"
BIN_A="$ROOT/target/debug/syn-svr"
BIN_B="$ROOT/target/debug/syn-svr-b"   # 独立文件名 = 独立 pid 文件，绕开单实例保护
API_A="http://127.0.0.1:9007"
API_B="http://127.0.0.1:9008"
PG_CONTAINER="${PG_CONTAINER:-pgsql}"
PG_USER="${PG_USER:-postgres}"
ROWS="${ROWS:-300}"
# id 段每次从源表 max(id) 之后取新的：重复跑脚本时若沿用同一段，
# 下游只是 upsert 覆盖、行数不增，"下游行数 = 前值 + N" 会误报
ID_LO=0
ID_HI=0
LOG_A="${TMPDIR:-/tmp}/syn-race-a.log"
LOG_B="${TMPDIR:-/tmp}/syn-race-b.log"
RESP_A="${TMPDIR:-/tmp}/syn-race-a.json"
RESP_B="${TMPDIR:-/tmp}/syn-race-b.json"
# 本机 HTTP 代理会拦 127.0.0.1 的请求，子进程统一绕开
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

pg() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
q() { pg "$1" -Atc "$2"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok   %s\n' "$1"; }
fail() {
  printf '\n\033[31mFAIL: %s\033[0m\n' "$1" >&2
  printf '\n--- 副本 A 日志尾部 ---\n' >&2; tail -30 "$LOG_A" >&2 || true
  printf '\n--- 副本 B 日志尾部 ---\n' >&2; tail -30 "$LOG_B" >&2 || true
  exit 1
}
assert_eq() { [ "$2" = "$3" ] || fail "${1}：期望 [${2}]，实际 [${3}]"; ok "$1 = ${3}"; }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true
  done
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && wait "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_port() { # port 进程名，最多等 30s
  for _ in $(seq 1 60); do
    port_busy "$1" && return 0
    sleep 0.5
  done
  fail "$1 端口未在 30s 内监听（$2）"
}

say "前置检查"
port_busy 9007 && fail "9007 已被占用（先停掉 run.sh 起的服务，或关掉 --keep 那个）"
port_busy 9008 && fail "9008 已被占用"
[ -f "$BIN_A" ] || fail "缺少 ${BIN_A}，先 cargo build -p syn-svr"
q admrs "select 1 from information_schema.tables where table_schema='public' and table_name='syn_it_person'" \
  | grep -q 1 || fail "admrs.public.syn_it_person 不存在，先跑 tests/env/run.sh"
q dtwrs_ui "select 1 from information_schema.tables where table_schema='public' and table_name='syn_it_person'" \
  | grep -q 1 || fail "dtwrs_ui.public.syn_it_person 不存在，先跑 tests/env/run.sh"
SRC_ID="$(q syn "select id from syn_source where code='adm_person'")"
[ -n "$SRC_ID" ] || fail "syn 库里没有 code=adm_person 的来源，先跑 tests/env/run.sh"
BATCH="$(q syn "select batch_size from syn_source where id=$SRC_ID")"
ID_LO=$(( $(q admrs "select coalesce(max(id), 0) from public.syn_it_person") + 1 ))
ID_HI=$((ID_LO + ROWS - 1))
[ "$ROWS" -le "$BATCH" ] || fail "ROWS=${ROWS} 超过源的 batch_size=${BATCH}，一轮取不完就测不出同一批竞争"
ok "来源 adm_person id=${SRC_ID}，batch_size=${BATCH}，本轮插 ${ROWS} 行（id ${ID_LO}..${ID_HI}）"

say "起两个副本（9007 node=3 / 9008 node=4）"
# 第二副本必须是另一个文件名：pid 文件按二进制路径生成，同名会被单实例保护挡住
cp "$BIN_A" "$BIN_B"
"$BIN_A" -c "$ENV_DIR/syn-svr-a.toml" >"$LOG_A" 2>&1 &
PIDS+=($!)
"$BIN_B" -c "$ENV_DIR/syn-svr-b.toml" >"$LOG_B" 2>&1 &
PIDS+=($!)
wait_port 9007 A
wait_port 9008 B
ok "两个副本都已监听"

say "造数：插入 $ROWS 行（updated_at=now）"
pg admrs -q -c "delete from public.syn_it_person where id between $ID_LO and $ID_HI;
  insert into public.syn_it_person (id, name, updated_at)
  select g, 'race-'||g, now() from generate_series($ID_LO, $ID_HI) g;"
# 取数带 5 秒重叠窗口（`updated_at <= now() - 5s`），刚插入的行会被挡住；
# 不在等的这 7 秒里插，两边都会读成 0 行，测出来的是「没数据」不是「没竞态」
sleep 7
ok "源表 $ROWS 行就绪，已过重叠窗口"

BEFORE_TARGET="$(q dtwrs_ui "select count(*) from public.syn_it_person")"
BEFORE_ROWS="$(q syn "select rows_synced from syn_cursor where source_id=$SRC_ID")"
BEFORE_CUR="$(q syn "select cursor_value from syn_cursor where source_id=$SRC_ID")"
say "并发触发：两副本同时 pull 同一个源"
printf '  前置：下游 %s 行，rows_synced=%s，游标 %s\n' "$BEFORE_TARGET" "$BEFORE_ROWS" "$BEFORE_CUR"

curl -sS --noproxy '*' -o "$RESP_A" -w '%{http_code}' -X POST "$API_A/syn/source/$SRC_ID/pull" >"$RESP_A.code" &
PA=$!
curl -sS --noproxy '*' -o "$RESP_B" -w '%{http_code}' -X POST "$API_B/syn/source/$SRC_ID/pull" >"$RESP_B.code" &
PB=$!
wait "$PA" || true
wait "$PB" || true

CODE_A="$(cat "$RESP_A.code")"; CODE_B="$(cat "$RESP_B.code")"
ROWS_A="$(jq -r '.extra.rows' "$RESP_A")"; ROWS_B="$(jq -r '.extra.rows' "$RESP_B")"
POS_A="$(jq -r '.extra.position // ""' "$RESP_A")"; POS_B="$(jq -r '.extra.position // ""' "$RESP_B")"
printf '  A: http=%s rows=%s position=%s\n' "$CODE_A" "$ROWS_A" "${POS_A:-<空>}"
printf '  B: http=%s rows=%s position=%s\n' "$CODE_B" "$ROWS_B" "${POS_B:-<空>}"

say "断言"
assert_eq "两副本均返回 200" "200 200" "$CODE_A $CODE_B"
assert_eq "两副本都取到同一批行（重复投递是设计语义）" "$ROWS $ROWS" "$ROWS_A $ROWS_B"

WINNERS=0
[ -n "$POS_A" ] && WINNERS=$((WINNERS + 1))
[ -n "$POS_B" ] && WINNERS=$((WINNERS + 1))
assert_eq "恰好一方带回 position（CAS 只有一方成功）" "1" "$WINNERS"

AFTER_ROWS="$(q syn "select rows_synced from syn_cursor where source_id=$SRC_ID")"
DELTA=$((AFTER_ROWS - BEFORE_ROWS))
assert_eq "水位只涨一轮（不重复累计）" "$ROWS" "$DELTA"

AFTER_TARGET="$(q dtwrs_ui "select count(*) from public.syn_it_person")"
assert_eq "下游行数 = 前值 + $ROWS" "$((BEFORE_TARGET + ROWS))" "$AFTER_TARGET"
assert_eq "下游无重复主键" "0" "$(q dtwrs_ui "select count(*) - count(distinct id) from public.syn_it_person")"

AFTER_CUR="$(q syn "select cursor_value from syn_cursor where source_id=$SRC_ID")"
case "$AFTER_CUR" in
  *"\"$ID_HI\""*) ok "游标停在本批最后一行（id=${ID_HI}）" ;;
  *) fail "游标未停在 id=${ID_HI}：${AFTER_CUR}" ;;
esac

# 败方的 position 为空，且必须在自己的日志里留下 CAS 被拦下的痕迹 ——
# 否则「恰好一方带 position」也可能只是对方先跑完、这边读到 0 行
if [ -z "$POS_A" ]; then LOSER_LOG="$LOG_A"; LOSER_NAME="A"; else LOSER_LOG="$LOG_B"; LOSER_NAME="B"; fi
if grep -q "游标被并发更新" "$LOSER_LOG"; then
  ok "败方 $LOSER_NAME 留下「游标被并发更新」warn"
else
  fail "败方 $LOSER_NAME 日志里没有并发告警，说明没真正撞上 CAS"
fi

printf '\n\033[32m全部通过\033[0m：两副本抢同一批 %s 行，水位只推进一次，重复投递由下游吸收。\n' "$ROWS"
printf '日志：%s / %s\n' "$LOG_A" "$LOG_B"
