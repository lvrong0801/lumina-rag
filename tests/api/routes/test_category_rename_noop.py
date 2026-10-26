"""Regression tests for ``PUT /documents/categories/{old_name}``.

Renaming a category to its CURRENT name must be an idempotent 200 no-op —
previously it fell into the ``new_name in cats`` check and returned 409
"Category already exists", which surfaced in the WebUI as "cannot rename"
(every IME-composition Enter submits the still-unchanged text). A genuine
rename keeps moving the docs' ``metadata.category`` to the new name.

Since the version feature, categories live under a version: these tests seed
only the legacy ``_doc_categories`` store, so every request first exercises the
lazy migration into ``_doc_versions`` (docs backfilled to version "1.0"), then
asserts the rename behavior inside that version scope.
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

    def __init__(self, categories):
        self.store = {"_doc_categories": {"categories": list(categories)}}

    async def get_by_id(self, key):
        return self.store.get(key)

    async def upsert(self, payload):
        self.store.update(payload)


class _FakeDocStatus:
    """One-document doc_status spying on the paginated scan and updates."""

    def __init__(self):
        self.paginated_calls = []
        self.updated = []
        self.doc_metadata = {"category": "产品需求文档"}
        self.deleted = False

    async def get_docs_paginated(self, **kwargs):
        self.paginated_calls.append(kwargs)
        if self.deleted:
            return [], 0
        doc = type("Doc", (), {"metadata": self.doc_metadata})()
        category = kwargs.get("category")
        if category is not None and category != self.doc_metadata.get("category", ""):
            return [], 0
        return [("doc-1", doc)], 1

    async def update_doc_status_fields(self, doc_id, fields):
        self.doc_metadata.update(fields.get("metadata") or {})
        self.updated.append((doc_id, fields))


def _make_client(categories=("产品需求文档",), tmp_path=None):
    rag = type("Rag", (), {})()
    rag.full_docs = _FakeFullDocs(categories)
    rag.doc_status = _FakeDocStatus()
    manager = _dr.DocumentManager(str(tmp_path / "inputs"))
    app = FastAPI()
    app.state.background_tasks = set()
    app.include_router(
        _dr.create_document_routes(rag, manager, api_key="test-key")
    )
    return TestClient(app), rag


def test_rename_to_same_name_is_noop(tmp_path):
    client, rag = _make_client(tmp_path=tmp_path)
    resp = client.put(
        "/documents/categories/%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3",
        headers=_HEADERS,
        json={"new_name": "产品需求文档"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"old_name": "产品需求文档", "new_name": "产品需求文档"}
    versions = rag.full_docs.store["_doc_versions"]["versions"]
    assert versions == [{"name": "1.0", "categories": ["产品需求文档"]}]
    # The category list itself is untouched; only the migration backfill ran.
    assert rag.doc_status.updated == [
        ("doc-1", {"metadata": {"category": "产品需求文档", "version": "1.0"}})
    ]


def test_rename_to_new_name_moves_docs(tmp_path):
    client, rag = _make_client(tmp_path=tmp_path)
    resp = client.put(
        "/documents/categories/%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3",
        headers=_HEADERS,
        json={"new_name": "PRD文档"},
    )
    assert resp.status_code == 200, resp.text
    versions = rag.full_docs.store["_doc_versions"]["versions"]
    assert versions == [{"name": "1.0", "categories": ["PRD文档"]}]
    rename_scans = [c for c in rag.doc_status.paginated_calls if c.get("category")]
    assert rename_scans and rename_scans[0]["category"] == "产品需求文档"
    assert rag.doc_status.doc_metadata == {
        "category": "PRD文档",
        "version": "1.0",
    }
