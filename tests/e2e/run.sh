#!/usr/bin/env bash
# syn 端到端联调：真库跑通 migration → poll 取数 → DB sink on conflict → 幂等 → 控制台接口。
#
# 前置：本机有名为 pgsql 的 PG 容器（5432），syn-svr 已编译（cargo build -p syn-svr）。
# 用法：
#   tests/e2e/run.sh              # 三个 syn_it* 库必须都不存在；跑完保留，便于排查
#   tests/e2e/run.sh --reset      # 先删掉 syn_it* 三个库再从头跑（破坏性，仅限这三个名字）
#   tests/e2e/run.sh --cleanup    # 只停服务并删掉 syn_it* 三个库，不跑验证
#
# 安全性：脚本只 drop 名字精确等于 syn_it / syn_it_src / syn_it_dst 的库，
# 发现它们在运行前已存在且没给 --reset 就直接退出，绝不碰工作区里的其它库。

set -euo pipefail

# e2e/ -> tests/ -> syn/（workspace 根，target/ 在这一层）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/tests/e2e"
BIN="$ROOT/target/debug/syn-svr"
CFG="$E2E/syn-svr-it.toml"
LOG="${TMPDIR:-/tmp}/syn-it-svr.log"
PG_CONTAINER="${PG_CONTAINER:-pgsql}"
PG_USER="${PG_USER:-postgres}"
API="http://127.0.0.1:19007"
SVR_PID=""

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
assert_eq() { # label expected actual
  [ "$2" = "$3" ] || fail "${1}：期望 [${2}]，实际 [${3}]"
  ok "$1 = $3"
}
stop_server() {
  if [ -n "$SVR_PID" ] && kill -0 "$SVR_PID" 2>/dev/null; then
    kill -TERM "$SVR_PID" 2>/dev/null || true
    wait "$SVR_PID" 2>/dev/null || true
  fi
  SVR_PID=""
}
trap stop_server EXIT

drop_dbs() {
  for db in syn_it syn_it_src syn_it_dst; do
    pg postgres -c "drop database if exists $db with (force)" >/dev/null
  done
}

# ---- 前置检查 -------------------------------------------------------------
for cmd in docker curl jq; do
  command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"
done
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -Atc 'select 1' >/dev/null \
  || fail "连不上 $PG_CONTAINER 里的 PostgreSQL"

if [ "${1:-}" = "--cleanup" ]; then
  stop_server
  drop_dbs
  say "联调库已清理"
  exit 0
fi

[ -x "$BIN" ] || fail "找不到 ${BIN}，先跑 cargo build -p syn-svr"
[ -f "$CFG" ] || fail "找不到联调配置 $CFG"
if nc -z -G 1 127.0.0.1 19007 2>/dev/null; then
  fail "19007 已被占用，先停掉占用进程"
fi

for db in syn_it syn_it_src syn_it_dst; do
  exists=$(q postgres "select count(*) from pg_database where datname='$db'")
  if [ "$exists" != "0" ]; then
    [ "${1:-}" = "--reset" ] || fail "$db 已存在；要重建请加 --reset（只删 syn_it* 三个库）"
  fi
done
if [ "${1:-}" = "--reset" ]; then
  say "删除旧的 syn_it* 联调库"
  drop_dbs
fi

# ---- 造数据 ---------------------------------------------------------------
say "建三个库：服务库 / 源库 / 下游库"
for db in syn_it syn_it_src syn_it_dst; do
  pg postgres -c "create database $db" >/dev/null
done
pg syn_it_src -c "
  create table demo_person (id int8 primary key, name text not null, updated_at timestamptz not null);
  insert into demo_person (id,name,updated_at) values
    (1,'alice-src', now() - interval '60 minutes'),
    (2,'bob-src',   now() - interval '50 minutes'),
    (3,'carol-src', now() - interval '40 minutes');
" >/dev/null
# 预置一行脏数据：验证 on conflict do update 是真的覆盖了，不是恰好没冲突
pg syn_it_dst -c "
  create table demo_person (id int8 primary key, name text not null, updated_at timestamptz not null);
  insert into demo_person (id,name,updated_at) values (1,'alice-stale', now() - interval '2 days');
" >/dev/null

# ---- 启服务（db_migrate! 自动建 syn_* 五张表） ------------------------------
say "启动 syn-svr（-c 指定联调配置，端口 19007）"
# exec 让 $! 就是二进制自己的 PID，退出时 kill -TERM 才能触发优雅停机
(cd "$(dirname "$BIN")" && exec "$BIN" -c "$CFG" --signal start >"$LOG" 2>&1) &
SVR_PID=$!
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "$API/syn/task/list" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] || fail "syn-svr 30s 内没起来"

tables=$(q syn_it "select count(*) from pg_tables where schemaname='public' and tablename like 'syn_%'")
# syn_task / syn_task_version / syn_source / syn_cursor / syn_idem / syn_datasource
assert_eq "migration 建表数" 6 "$tables"

# ---- 配置 -----------------------------------------------------------------
say "创建任务与数据源"
task_resp=$(curl -fsS -X POST "$API/syn/task" -H 'Content-Type: application/json' \
  -H 'X-User-Id: 1' --data-binary @"$E2E/task.json")
task_id=$(printf '%s' "$task_resp" | jq -r '.extra.id')
[ -n "$task_id" ] && [ "$task_id" != "null" ] || fail "任务创建失败：$task_resp"
source_resp=$(curl -fsS -X POST "$API/syn/source" -H 'Content-Type: application/json' \
  -H 'X-User-Id: 1' --data-binary @"$E2E/source.json")
source_id=$(printf '%s' "$source_resp" | jq -r '.extra.id')
[ -n "$source_id" ] && [ "$source_id" != "null" ] || fail "数据源创建失败：$source_resp"
assert_eq "数据源虚拟 topic" "source:it_person" "$(printf '%s' "$source_resp" | jq -r '.extra.topic')"
ok "task=$task_id source=$source_id"

# ---- poll + DB sink -------------------------------------------------------
say "第一轮 pull：3 行增量 + on conflict 覆盖"
pull1=$(curl -fsS -X POST "$API/syn/source/$source_id/pull")
assert_eq "本轮推进行数" 3 "$(printf '%s' "$pull1" | jq -r '.extra.rows')"
assert_eq "成功行数" 3 "$(printf '%s' "$pull1" | jq -r '.extra.success')"
assert_eq "失败行数" 0 "$(printf '%s' "$pull1" | jq -r '.extra.fatal')"
assert_eq "目标表行数" 3 "$(q syn_it_dst 'select count(*) from demo_person')"
assert_eq "id=1 被 upsert 覆盖" "alice-src" "$(q syn_it_dst "select name from demo_person where id=1")"
assert_eq "游标累计行数" 3 "$(q syn_it 'select rows_synced from syn_cursor')"
[ "$(printf '%s' "$pull1" | jq -r '.extra.position')" != "null" ] || fail "水位没有推进"

say "第二轮 pull：无新数据不重复投递"
pull2=$(curl -fsS -X POST "$API/syn/source/$source_id/pull")
assert_eq "本轮推进行数" 0 "$(printf '%s' "$pull2" | jq -r '.extra.rows')"
assert_eq "目标表行数" 3 "$(q syn_it_dst 'select count(*) from demo_person')"

say "源库新增 1 行后第三轮 pull"
pg syn_it_src -c "insert into demo_person (id,name,updated_at) values (4,'dave-src', now() - interval '10 minutes')" >/dev/null
pull3=$(curl -fsS -X POST "$API/syn/source/$source_id/pull")
assert_eq "本轮推进行数" 1 "$(printf '%s' "$pull3" | jq -r '.extra.rows')"
assert_eq "目标表行数" 4 "$(q syn_it_dst 'select count(*) from demo_person')"
assert_eq "游标累计行数" 4 "$(q syn_it 'select rows_synced from syn_cursor')"

# ---- 幂等 -----------------------------------------------------------------
say "幂等：首次执行 / 命中短路 / 失败不记账"
sync() { # key body [topic] -> 输出 "http_code body"
  curl -sS -o "${TMPDIR:-/tmp}/syn-it-sync-body.json" -w '%{http_code}' \
    -X POST "$API/syn/sync/${3:-source:it_person}" -H 'Content-Type: application/json' \
    -H "X-Idempotency-Key: $1" --data-binary "$2"
}
idem_rec='{"op":"r","after":{"id":999,"name":"idem-first","updated_at":"2026-11-12T23:00:00Z"}}'
assert_eq "幂等首次 HTTP" 200 "$(sync it-key-1 "$idem_rec")"
assert_eq "台账行数" 1 "$(q syn_it 'select count(*) from syn_idem')"
assert_eq "下游写入 id=999" "idem-first" "$(q syn_it_dst "select name from demo_person where id=999")"
pg syn_it_dst -c "update demo_person set name='manual-edit' where id=999" >/dev/null
assert_eq "同键重投 HTTP" 200 "$(sync it-key-1 "$idem_rec")"
assert_eq "命中后没再写下游" "manual-edit" "$(q syn_it_dst "select name from demo_person where id=999")"
grep -q '幂等命中' "${TMPDIR:-/tmp}/syn-it-sync-body.json" || fail "重投没有走台账短路"
assert_eq "台账未被重复写入" 1 "$(q syn_it 'select count(*) from syn_idem')"

bad='{"op":"r","after":{"name":"no-id","updated_at":"2026-11-12T23:00:00Z"}}'
assert_eq "缺冲突键 HTTP" 400 "$(sync it-key-2 "$bad")"
grep -q 'DB_KEY_MISSING' "${TMPDIR:-/tmp}/syn-it-sync-body.json" || fail "缺键没有按 DB_KEY_MISSING 分类"
assert_eq "失败不记账" 1 "$(q syn_it 'select count(*) from syn_idem')"
good='{"op":"r","after":{"id":1000,"name":"retry-ok","updated_at":"2026-11-12T23:00:00Z"}}'
assert_eq "失败后同键重投 HTTP" 200 "$(sync it-key-2 "$good")"
assert_eq "重投真的写了下游" "retry-ok" "$(q syn_it_dst "select name from demo_person where id=1000")"
assert_eq "台账终态行数" 2 "$(q syn_it 'select count(*) from syn_idem')"

# ---- 控制台接口（前端 wire 契约） ------------------------------------------
say "控制台五类接口 + reload"
assert_eq "task/page total" 1 "$(curl -fsS "$API/syn/task/page" | jq -r '.extra.total')"
assert_eq "source/page 游标累计" 4 "$(curl -fsS "$API/syn/source/page" | jq -r '.extra.list[0].cursor.rowsSynced')"
assert_eq "delivery/page total" 2 "$(curl -fsS "$API/syn/delivery/page" | jq -r '.extra.total')"
assert_eq "fatal 筛选（失败不记账）" 0 "$(curl -fsS "$API/syn/delivery/page?verdict=fatal" | jq -r '.extra.total')"
assert_eq "taskCode 筛选" 2 "$(curl -fsS "$API/syn/delivery/page?taskCode=it_person_db" | jq -r '.extra.total')"
assert_eq "idem/page total" 2 "$(curl -fsS "$API/syn/idem/page" | jq -r '.extra.total')"
overview=$(curl -fsS "$API/syn/overview?window=24h")
assert_eq "overview total" 2 "$(printf '%s' "$overview" | jq -r '.extra.total')"
# 桶必须覆盖当前小时：曲线里所有 success 之和要等于合计，不能把刚发生的记账漏掉
assert_eq "小时桶 success 之和" 2 "$(printf '%s' "$overview" | jq -r '[.extra.series[].success] | add')"
assert_eq "reload 生效任务数" 1 "$(curl -fsS -X POST "$API/syn/task/reload" | jq -r '.extra')"

# ---- 数据源 CRUD 与「连接串只写不回显」 -------------------------------------
# 两个安全契约必须在真库上锁死：读接口绝不出现 url 明文；改其它字段时留空连接串
# 必须保持库里原值。这两条错了都不会报错，只会「悄悄把密码写没」或「把密码漏出去」。
say "数据源 CRUD：连接串只写不回显"
assert_eq "初始数据源清单为空（清单读表，不读配置）" 0 \
  "$(curl -fsS "$API/syn/datasource/list" | jq -r '.extra | length')"
ds_resp=$(curl -fsS -X POST "$API/syn/datasource" -H 'Content-Type: application/json' \
  -H 'X-User-Id: 1' --data '{"code":"it_ds","name":"联调数据源","url":"postgresql://syn:secret@10.1.2.3:5432/it_ds?sslmode=disable","maxConnections":4,"enabled":true,"remark":"e2e"}')
assert_eq "新建后 target 已脱敏" "10.1.2.3:5432/it_ds" "$(printf '%s' "$ds_resp" | jq -r '.extra.target')"
assert_eq "新建响应不含 url 明文" "true" \
  "$(printf '%s' "$ds_resp" | jq -r 'if (.extra | has("url")) then "false" else "true" end')"
assert_eq "新建响应不含密码" "true" \
  "$(printf '%s' "$ds_resp" | jq -r 'if (tostring | test("secret")) then "false" else "true" end')"
ds_id=$(printf '%s' "$ds_resp" | jq -r '.extra.id')
assert_eq "清单里有这条" 1 \
  "$(curl -fsS "$API/syn/datasource/list" | jq -r '[.extra[] | select(.code=="it_ds")] | length')"

# 修改时不带 url：其余字段生效，连接串保持不变
upd_resp=$(curl -fsS -X PUT "$API/syn/datasource/$ds_id" -H 'Content-Type: application/json' \
  -H 'X-User-Id: 1' --data '{"code":"it_ds","name":"联调数据源改","url":"","maxConnections":8,"enabled":true,"remark":"e2e-2"}')
assert_eq "改名生效" "联调数据源改" "$(printf '%s' "$upd_resp" | jq -r '.extra.name')"
assert_eq "连接池上限生效" 8 "$(printf '%s' "$upd_resp" | jq -r '.extra.maxConnections')"
assert_eq "留空 url 不改连接串" "10.1.2.3:5432/it_ds" "$(printf '%s' "$upd_resp" | jq -r '.extra.target')"

assert_eq "停用生效" "false" \
  "$(curl -fsS -X PUT "$API/syn/datasource/$ds_id/enabled" -H 'Content-Type: application/json' \
     -H 'X-User-Id: 1' --data '{"enabled":false}' | jq -r '.extra.enabled')"
curl -fsS -X DELETE "$API/syn/datasource/$ds_id" -H 'X-User-Id: 1' >/dev/null
assert_eq "删除后清单为空" 0 "$(curl -fsS "$API/syn/datasource/list" | jq -r '.extra | length')"

# 注册中心候选：联调没有注册中心，必须降级成空数组而不是 5xx
assert_eq "服务名候选降级为空数组" "200" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/syn/registry/services")"

# ---- 服务发现负向路径 ------------------------------------------------------
# 联调配置里没有注册中心。http 任务必须显式 fatal：解析不到实例是部署问题，
# 不能猜一个地址把数据发出去。连投两条再验框架的负缓存：注册中心只被问一次。
say "服务发现不可用：http 任务必须 TARGET_UNRESOLVED"
unresolved_resp=$(curl -fsS -X POST "$API/syn/task" -H 'Content-Type: application/json' \
  -H 'X-User-Id: 1' --data-binary @"$E2E/task-http-unresolved.json")
unresolved_id=$(printf '%s' "$unresolved_resp" | jq -r '.extra.id')
[ -n "$unresolved_id" ] && [ "$unresolved_id" != "null" ] \
  || fail "http 任务创建失败：$unresolved_resp"
assert_eq "reload 后生效任务数" 2 "$(curl -fsS -X POST "$API/syn/task/reload" | jq -r '.extra')"

unresolved_rec='{"op":"r","after":{"id":2001,"name":"unresolved"}}'
assert_eq "服务发现失败 HTTP" 400 \
  "$(sync it-http-1 "$unresolved_rec" source:it_http_unresolved)"
assert_eq "结论 fatal" "fatal" \
  "$(jq -r '.result' "${TMPDIR:-/tmp}/syn-it-sync-body.json")"
assert_eq "分类码 TARGET_UNRESOLVED" "TARGET_UNRESOLVED" \
  "$(jq -r '.code' "${TMPDIR:-/tmp}/syn-it-sync-body.json")"
assert_eq "停在 action 段（没发出 HTTP）" "action" \
  "$(jq -r '.stage' "${TMPDIR:-/tmp}/syn-it-sync-body.json")"
grep -q '注册中心' "${TMPDIR:-/tmp}/syn-it-sync-body.json" \
  || fail "失败原因没指向注册中心"

assert_eq "第二条记录同样 fatal" 400 \
  "$(sync it-http-2 "$unresolved_rec" source:it_http_unresolved)"
assert_eq "第二条也是 TARGET_UNRESOLVED" "TARGET_UNRESOLVED" \
  "$(jq -r '.code' "${TMPDIR:-/tmp}/syn-it-sync-body.json")"
# 框架选址层的失败节流 / 空结果负缓存：两条记录只查一次注册中心
hits=$(grep -c 'service discovery: syn-it-no-such-svr refresh failed' "$LOG" || true)
assert_eq "注册中心只被查 1 次" 1 "$hits"
assert_eq "fatal 不记幂等台账" 2 "$(q syn_it 'select count(*) from syn_idem')"

say "全部通过"
printf '  服务日志：%s\n' "$LOG"
printf '  联调库保留：syn_it / syn_it_src / syn_it_dst（清理跑 %s --cleanup）\n' "$0"
