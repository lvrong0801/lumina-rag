"""Regression tests for ``PUT /documents/categories/{old_name}``.

Renaming a category to its CURRENT name must be an idempotent 200 no-op —
previously it fell into the ``new_name in cats`` check and returned 409
"Category already exists", which surfaced in the WebUI as "cannot rename"
(every IME-composition Enter submits the still-unchanged text). A genuine
rename keeps moving the docs' ``metadata.category`` to the new name.
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

    async def get_docs_paginated(self, **kwargs):
        self.paginated_calls.append(kwargs)
        doc = type(
            "Doc",
            (),
            {"metadata": {"category": kwargs["category"]}},
        )()
        return [("doc-1", doc)], 1

    async def update_doc_status_fields(self, doc_id, fields):
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
    # No list mutation and no doc-status scan: a true no-op.
    assert rag.full_docs.store["_doc_categories"]["categories"] == ["产品需求文档"]
    assert rag.doc_status.paginated_calls == []
    assert rag.doc_status.updated == []


def test_rename_to_new_name_moves_docs(tmp_path):
    client, rag = _make_client(tmp_path=tmp_path)
    resp = client.put(
        "/documents/categories/%E4%BA%A7%E5%93%81%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3",
        headers=_HEADERS,
        json={"new_name": "PRD文档"},
    )
    assert resp.status_code == 200, resp.text
    assert rag.full_docs.store["_doc_categories"]["categories"] == ["PRD文档"]
    assert rag.doc_status.paginated_calls[0]["category"] == "产品需求文档"
    assert rag.doc_status.updated == [("doc-1", {"metadata": {"category": "PRD文档"}})]
