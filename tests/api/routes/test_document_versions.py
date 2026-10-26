"""Contract tests for the ``/documents/versions`` endpoints.

The version store lives as ``_doc_versions`` in the ``full_docs`` KV
namespace (``{"versions": [{"name", "categories": [..]}]}``). Its first read
runs the one-time migration: legacy ``_doc_categories`` become version
"1.0", categories found only on docs are appended, and every unversioned doc
is backfilled. Version names are dot-joined integers, so ordering/latest is
a numeric-tuple compare ("10.0" > "2.0"), never a string compare. Deleting a
version is refused (409) while any document still carries it.
"""

import importlib
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
_dr = importlib.import_module("lightrag.api.routers.document_routes")
sys.argv = _original_argv

pytestmark = pytest.mark.offline

_HEADERS = {"X-API-Key": "test-key"}


class _FakeFullDocs:
    """Dict-backed stand-in for the ``full_docs`` KV namespace."""

    def __init__(self, categories=("产品需求文档",)):
        self.store = {"_doc_categories": {"categories": list(categories)}}

    async def get_by_id(self, key):
        return self.store.get(key)

    async def upsert(self, payload):
        self.store.update(payload)


class _FakeDocStatus:
    """Dict-backed doc_status honouring the paginated ``category`` kwarg."""

    def __init__(self, docs):
        # docs: {doc_id: metadata-dict}
        self.docs = {doc_id: {"metadata": dict(meta)} for doc_id, meta in docs.items()}

    async def get_by_id(self, doc_id):
        return self.docs.get(doc_id)

    async def get_docs_paginated(self, **kwargs):
        items = list(self.docs.items())
        cat = kwargs.get("category")
        if cat is not None:
            items = [
                i
                for i in items
                if (i[1].get("metadata") or {}).get("category") == cat
            ]
        page = kwargs.get("page", 1)
        size = kwargs.get("page_size", 200)
        sliced = items[(page - 1) * size : page * size]
        return [
            (
                doc_id,
                type("Doc", (), {"metadata": data["metadata"]})(),
            )
            for doc_id, data in sliced
        ], len(items)

    async def update_doc_status_fields(self, doc_id, fields):
        self.docs[doc_id].update(fields)


def _make_client(docs=None, tmp_path=None, categories=("产品需求文档",)):
    rag = type("Rag", (), {})()
    rag.full_docs = _FakeFullDocs(categories)
    rag.doc_status = _FakeDocStatus(docs or {})
    manager = _dr.DocumentManager(str(tmp_path / "inputs"))
    app = FastAPI()
    app.state.background_tasks = set()
    app.include_router(_dr.create_document_routes(rag, manager, api_key="test-key"))
    return TestClient(app), rag


def test_first_read_migrates_legacy_state(tmp_path):
    client, rag = _make_client(
        docs={
            "doc-1": {"category": "产品需求文档"},
            "doc-2": {},
            "doc-3": {"category": "会议纪要"},  # drift: doc-only category
        },
        tmp_path=tmp_path,
    )
    resp = client.get("/documents/versions", headers=_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["latest_version"] == "1.0"
    assert body["total_count"] == 3
    assert body["uncategorized_count"] == 1
    (v1,) = body["versions"]
    assert v1["name"] == "1.0"
    assert v1["count"] == 3
    cats = {c["name"]: c["count"] for c in v1["categories"]}
    assert cats == {"产品需求文档": 1, "会议纪要": 1}
    # Every doc backfilled to 1.0
    for doc in rag.doc_status.docs.values():
        assert doc["metadata"]["version"] == "1.0"
    # Stored, so a second read skips migration entirely
    stored = rag.full_docs.store["_doc_versions"]["versions"]
    assert stored == [{"name": "1.0", "categories": ["产品需求文档", "会议纪要"]}]


def test_versions_sort_semver_and_latest(tmp_path):
    client, _rag = _make_client(tmp_path=tmp_path)
    for name in ("10.0", "2.0"):
        resp = client.post("/documents/versions", headers=_HEADERS, json={"name": name})
        assert resp.status_code == 200, resp.text
    body = client.get("/documents/versions", headers=_HEADERS).json()
    assert [v["name"] for v in body["versions"]] == ["1.0", "2.0", "10.0"]
    # String compare would pick "2.0"; numeric-tuple compare picks "10.0".
    assert body["latest_version"] == "10.0"


def test_create_version_rejects_duplicates_and_bad_names(tmp_path):
    client, _rag = _make_client(tmp_path=tmp_path)
    resp = client.post("/documents/versions", headers=_HEADERS, json={"name": "1.0"})
    assert resp.status_code == 409, resp.text
    for bad in ("v2", "1.", "1..0", "1-beta", ""):
        resp = client.post("/documents/versions", headers=_HEADERS, json={"name": bad})
        assert resp.status_code in (400, 422), (bad, resp.text)


def test_rename_version_moves_docs(tmp_path):
    client, rag = _make_client(
        docs={"doc-1": {"category": "产品需求文档"}, "doc-2": {}},
        tmp_path=tmp_path,
    )
    resp = client.put(
        "/documents/versions/1.0", headers=_HEADERS, json={"new_name": "1.5"}
    )
    assert resp.status_code == 200, resp.text
    for doc in rag.doc_status.docs.values():
        assert doc["metadata"]["version"] == "1.5"
    body = client.get("/documents/versions", headers=_HEADERS).json()
    assert [v["name"] for v in body["versions"]] == ["1.5"]

    # Idempotent no-op, unknown name, and collision.
    resp = client.put(
        "/documents/versions/1.5", headers=_HEADERS, json={"new_name": "1.5"}
    )
    assert resp.status_code == 200, resp.text
    resp = client.put(
        "/documents/versions/9.9", headers=_HEADERS, json={"new_name": "2.0"}
    )
    assert resp.status_code == 404, resp.text
    client.post("/documents/versions", headers=_HEADERS, json={"name": "2.0"})
    resp = client.put(
        "/documents/versions/1.5", headers=_HEADERS, json={"new_name": "2.0"}
    )
    assert resp.status_code == 409, resp.text


def test_delete_version_refused_while_docs_carry_it(tmp_path):
    client, _rag = _make_client(docs={"doc-1": {}}, tmp_path=tmp_path)
    resp = client.delete("/documents/versions/1.0", headers=_HEADERS)
    assert resp.status_code == 409, resp.text
    # Move the doc out, then the delete succeeds.
    client.post("/documents/versions", headers=_HEADERS, json={"name": "2.0"})
    resp = client.put("/documents/doc-1/version", headers=_HEADERS, json={"version": "2.0"})
    assert resp.status_code == 200, resp.text
    resp = client.delete("/documents/versions/1.0", headers=_HEADERS)
    assert resp.status_code == 200, resp.text
    body = client.get("/documents/versions", headers=_HEADERS).json()
    assert [v["name"] for v in body["versions"]] == ["2.0"]


def test_assign_document_version_keeps_matching_category_else_clears(tmp_path):
    client, rag = _make_client(
        docs={
            "doc-keep": {"category": "产品需求文档"},
            "doc-clear": {"category": "会议纪要"},
        },
        tmp_path=tmp_path,
    )
    client.post("/documents/versions", headers=_HEADERS, json={"name": "2.0"})
    resp = client.post(
        "/documents/categories",
        headers=_HEADERS,
        json={"name": "产品需求文档", "version": "2.0"},
    )
    assert resp.status_code == 200, resp.text

    resp = client.put(
        "/documents/doc-keep/version", headers=_HEADERS, json={"version": "2.0"}
    )
    assert resp.status_code == 200, resp.text
    meta = rag.doc_status.docs["doc-keep"]["metadata"]
    assert meta == {"category": "产品需求文档", "version": "2.0"}

    resp = client.put(
        "/documents/doc-clear/version", headers=_HEADERS, json={"version": "2.0"}
    )
    assert resp.status_code == 200, resp.text
    meta = rag.doc_status.docs["doc-clear"]["metadata"]
    assert meta == {"version": "2.0"}

    resp = client.put(
        "/documents/doc-keep/version", headers=_HEADERS, json={"version": "9.9"}
    )
    assert resp.status_code == 404, resp.text


def test_categories_are_scoped_per_version(tmp_path):
    """Same category name may exist in two versions; renames stay in scope."""
    client, rag = _make_client(
        docs={
            "doc-old": {"category": "产品需求文档"},
            "doc-new": {"category": "产品需求文档", "version": "2.0"},
        },
        tmp_path=tmp_path,
    )
    client.post("/documents/versions", headers=_HEADERS, json={"name": "2.0"})
    resp = client.post(
        "/documents/categories",
        headers=_HEADERS,
        json={"name": "产品需求文档", "version": "2.0"},
    )
    assert resp.status_code == 200, resp.text

    # Counts for ?version= are scoped to that version.
    body = client.get("/documents/categories", headers=_HEADERS, params={"version": "2.0"}).json()
    assert body["total_count"] == 1
    assert body["categories"] == [{"name": "产品需求文档", "count": 1}]

    # Rename in 2.0 leaves the 1.0 doc untouched.
    resp = client.put(
        "/documents/categories/%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3",
        headers=_HEADERS,
        params={"version": "2.0"},
        json={"new_name": "PRD"},
    )
    assert resp.status_code == 200, resp.text
    assert rag.doc_status.docs["doc-old"]["metadata"]["category"] == "产品需求文档"
    assert rag.doc_status.docs["doc-new"]["metadata"]["category"] == "PRD"
