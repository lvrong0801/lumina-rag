# -*- coding: utf-8 -*-
"""
Rerank proxy: LightRAG (cohere binding) -> Ollama (OpenAI-compatible rerank API).

Ollama 提供的是 OpenAI 兼容的 /v1/rerank 端点（与 cohere v2 格式略不同）：
  请求:  {"model": ..., "query": ..., "documents": [...], "top_n": N}
  响应:  {"results": [{"index": i, "relevance_score": s}], "meta": {...}}

LightRAG cohere binding 期望：
  请求:  {"model": ..., "query": ..., "documents": [...], "top_n": N,
          "return_documents": bool}
  响应:  {"id": ..., "results": [{"index": i, "relevance_score": s,
                                  "document": {"index": i, "text": ...}}]}

本代理做以下适配：
  1. 端点路径 /rerank -> /v1/rerank
  2. 响应补齐 id 与 results[0].document 字段
  3. 兼容 cohere v2 documents 为对象列表 [{text:...}] 的场景

用法:
    python rerank_proxy_ollama.py         # 监听 127.0.0.1:8001

.env 配套:
    RERANK_BINDING=cohere
    RERANK_MODEL=hans-tech/bge-reranker-v2-m3:260522
    RERANK_BINDING_HOST=http://localhost:8001/rerank
    RERANK_BINDING_API_KEY=ollama   # 任意非空字符串即可，Ollama 不校验
    MIN_RERANK_SCORE=0.0
    RERANK_BY_DEFAULT=True
"""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# ========== 可改 ==========
OLLAMA_HOST = "http://127.0.0.1:11434"
OLLAMA_API_KEY = "ollama"      # 任意非空字符串即可；如需 Ollama auth 可改
MODEL = "hans-tech/bge-reranker-v2-m3:260522"

PROXY_PORT = 8001
LOG_FILE = "D:\\rerank_proxy_ollama.log"
# =========================

def log(msg: str):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")


def normalize_documents(docs):
    """cohere v2 的 documents 可能是字符串列表或对象列表（含 text 字段），统一转字符串。"""
    out = []
    for d in docs:
        if isinstance(d, str):
            out.append(d)
        elif isinstance(d, dict) and "text" in d:
            out.append(d["text"])
        else:
            out.append(str(d))
    return out


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/rerank":
            self.send_error(404, "only /rerank supported")
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            docs = normalize_documents(body.get("documents", []))
            query = body.get("query", "")
            top_n = body.get("top_n")
            want_doc = body.get("return_documents", True)
            model = body.get("model") or MODEL

            log(f"REQ query={query[:60]!r} docs_n={len(docs)} top_n={top_n} want_doc={want_doc}")

            # 单文档（或空）：无重排意义，直接按原序返回
            if len(docs) < 2:
                data = {
                    "id": "rerank-proxy-single-" + str(int(time.time() * 1000)),
                    "results": [
                        {"index": i, "relevance_score": round(1.0 - i * 0.001, 6),
                         "document": {"index": i, "text": d}}
                        for i, d in enumerate(docs)
                    ],
                }
                log(f"SINGLE_DOC skip, docs_n={len(docs)}")
            else:
                # 转发 Ollama /v1/rerank
                payload = {
                    "model": model,
                    "query": query,
                    "documents": docs,
                    "top_n": top_n,
                    "return_documents": want_doc,
                }
                req = Request(
                    f"{OLLAMA_HOST}/v1/rerank",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {OLLAMA_API_KEY}",
                    },
                )
                try:
                    with urlopen(req, timeout=300) as resp:
                        raw = resp.read()
                except HTTPError as e:
                    err_body = e.read().decode("utf-8", errors="replace")
                    log(f"OLLAMA http_error status={e.code} body={err_body[:400]}")
                    raise RuntimeError(f"Ollama rerank {e.code}: {err_body[:200]}")
                except URLError as e:
                    log(f"OLLAMA url_error reason={e.reason}")
                    raise RuntimeError(f"Ollama rerank unreachable: {e.reason}")

                data = json.loads(raw.decode("utf-8"))
                log(f"OLLAMA ok, raw_results={len(data.get('results', []))}")

                # 补齐 cohere v2 的 id 与 document 字段
                if "id" not in data:
                    data["id"] = "rerank-proxy-ollama-" + str(int(time.time() * 1000))
                for r in data.get("results", []):
                    idx = r.get("index")
                    if idx is not None and 0 <= idx < len(docs):
                        r["document"] = {"index": idx, "text": docs[idx]}

            out = json.dumps(data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            log("OK -> "
                + ",".join(str(r.get("relevance_score")) for r in sorted(data.get("results", []), key=lambda x: x.get("index", 0))))
        except Exception as e:
            log(f"ERROR {type(e).__name__}: {e}")
            err = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def log_message(self, fmt, *args):  # 静默访问日志
        pass


if __name__ == "__main__":
    print(f"rerank proxy_ollama listening on 127.0.0.1:{PROXY_PORT} -> {OLLAMA_HOST}/v1/rerank")
    HTTPServer(("127.0.0.1", PROXY_PORT), Handler).serve_forever()
