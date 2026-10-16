# -*- coding: utf-8 -*-
"""
Rerank score inversion proxy for llama.cpp + Qwen3-Reranker.
llama.cpp 对 Qwen3-Reranker (LLM-based reranker) 的 /rerank 返回的
relevance_score 与相关度反向（无关文档高分、相关文档低分）。
本代理将分数取反 (score' = 1 - score)，恢复"高分=相关"的标准语义，
供 LightRAG (cohere binding) 消费。

兼容处理：
  - documents 归一化：cohere v2 允许 documents 为对象列表 [{text:...}]，
    llama.cpp 只接受字符串数组，统一转为字符串后转发。
  - 响应补齐 cohere v2 的 document 字段与 id 字段。

用法:  python rerank_proxy.py   (监听 127.0.0.1:8001)
日志:  D:\rerank_proxy.log
"""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

LLAMA_RERANK_URL = "http://127.0.0.1:8000/rerank"
PROXY_PORT = 8001
LOG_FILE = "D:\\rerank_proxy.log"


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
            log(f"REQ keys={list(body.keys())} docs_type={type(body.get('documents')).__name__} "
                f"docs_n={len(body.get('documents', []))}")

            # 归一化 documents 再转发 llama.cpp
            payload = dict(body)
            docs = normalize_documents(body.get("documents", []))
            if "documents" in payload:
                payload["documents"] = docs

            # 单文档（或空）：llama.cpp 对该场景返回 500，且无重排意义，直接原样返回
            if len(docs) < 2:
                data = {
                    "model": body.get("model", ""),
                    "results": [
                        {"index": i, "relevance_score": round(1.0 - i * 0.001, 6),
                         "document": {"index": i, "text": d}}
                        for i, d in enumerate(docs)
                    ],
                    "id": "rerank-proxy-single-" + str(int(time.time() * 1000)),
                }
                log(f"SINGLE_DOC skip llama, docs_n={len(docs)}")
            else:
                req = Request(
                    LLAMA_RERANK_URL,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                with urlopen(req, timeout=300) as resp:
                    raw = resp.read()
                data = json.loads(raw.decode("utf-8"))
                log(f"LLAMA status={resp.status} raw_results={len(data.get('results', []))}")

                # 分数反相：恢复"越高越相关"语义；补齐 cohere v2 的 document 字段
                for r in data.get("results", []):
                    r["relevance_score"] = round(1.0 - r["relevance_score"], 6)
                    idx = r.get("index")
                    if idx is not None and 0 <= idx < len(docs):
                        r["document"] = {"index": idx, "text": docs[idx]}
                if "id" not in data:
                    data["id"] = "rerank-proxy-" + str(int(time.time() * 1000))

            out = json.dumps(data).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            log("OK -> score sequence: "
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
    print(f"rerank proxy listening on 127.0.0.1:{PROXY_PORT} -> {LLAMA_RERANK_URL}")
    HTTPServer(("127.0.0.1", PROXY_PORT), Handler).serve_forever()
