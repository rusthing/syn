#!/usr/bin/env python3
"""http 全量联调用的分页假接口。

只做两件事：按页吐数据、记下被打了几次。第二种是为了断言「全量翻到底之后
调度不再打源接口」—— 只对数据库断言看不出来它有没有白跑。

    GET /api/page?page=N&size=M    页码模式（3 页 7 行，第 4 页空）
    GET /api/token?cursor=X&size=M token 模式（游标 "" -> "b" -> 结束，共 4 行）
    GET /stats                     {"page_hits": n, "token_hits": m}

用法：`python3 tests/env/mock-paging.py [port]`，默认 19098。
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19098

# 页码模式的 7 行：3 + 3 + 1，第 4 页空
PAGE_ROWS = [
    {"id": 3000 + i, "name": f"http-page-{i}", "updated_at": "2026-11-13T00:00:00Z"}
    for i in range(1, 8)
]
# token 模式的 4 行：3 + 1
TOKEN_ROWS = [
    {"id": 4000 + i, "name": f"http-token-{i}", "updated_at": "2026-11-13T00:00:00Z"}
    for i in range(1, 5)
]

HITS = {"page": 0, "token": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音：脚本靠 /stats 断言，不看日志
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/stats":
            return self._send(200, {"page_hits": HITS["page"], "token_hits": HITS["token"]})

        if u.path == "/api/page":
            HITS["page"] += 1
            try:
                page = int(q.get("page", ["1"])[0])
                size = int(q.get("size", ["3"])[0])
            except ValueError:
                return self._send(400, {"error": "page/size 必须是整数"})
            if page < 1 or size < 1:
                return self._send(400, {"error": "page/size 必须大于 0"})
            start = (page - 1) * size
            rows = PAGE_ROWS[start : start + size]
            return self._send(
                200,
                {
                    "data": {
                        "list": rows,
                        "next": str(page + 1) if start + size < len(PAGE_ROWS) else None,
                    }
                },
            )

        if u.path == "/api/token":
            HITS["token"] += 1
            try:
                size = int(q.get("size", ["3"])[0])
            except ValueError:
                return self._send(400, {"error": "size 必须是整数"})
            cursor = q.get("cursor", [""])[0]
            if cursor == "":
                rows, nxt = TOKEN_ROWS[:size], "b"
            elif cursor == "b":
                rows, nxt = TOKEN_ROWS[size:], None
            else:
                rows, nxt = [], None
            return self._send(200, {"data": {"list": rows, "nextCursor": nxt}})

        return self._send(404, {"error": f"unknown path {u.path}"})


if __name__ == "__main__":
    print(f"mock-paging listening on {PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
