"""Recycle-bin (soft delete / restore / purge) endpoint tests.

Covers the P1 soft-delete contract on the document router:
- DELETE /documents/delete_document defaults to SOFT delete (purge=False):
  the doc_status row flips to ``deleted`` with ``deleted_at`` /
  ``deleted_by`` / ``original_status`` recorded in metadata; nothing is
  physically removed and no destructive slot is taken.
- purge=True keeps the physical background-delete path (destructive slot).
- GET /documents/recycle_bin lists only deleted rows (include_deleted=True
  with a DELETED status filter).
- POST /documents/restore flips rows back to their recorded status and
  clears the soft-delete metadata markers.
- DELETE /documents/purge physically deletes recycle-bin rows via the
  destructive slot.
- Live listing / counts exclude deleted rows by default.

The fake storage is deliberately small: it implements exactly the
doc_status surface these endpoints touch.
"""

import importlib
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
_document_routes = importlib.import_module("lightrag.api.routers.document_routes")
_base = importlib.import_module("lightrag.base")
sys.argv = _original_argv

create_document_routes = _document_routes.create_document_routes
DocStatus = _base.DocStatus
DocProcessingStatus = _base.DocProcessingStatus

pytestmark = pytest.mark.offline


@pytest.fixture(autouse=True)
def _ensure_shared_storage_initialized():
    """Initialize shared_storage dicts and reset pipeline_status flags per
    test. The physical-delete paths (_acquire/_release_destructive_busy) read
    ``pipeline_status`` via get_namespace_data, which raises unless the shared
    store is initialized; with no pipeline_status bootstrapped the destructive
    slot is trivially acquired (the same behaviour the real endpoints have on
    a cold server before the pipeline starts)."""
    import importlib

    shared_storage = importlib.import_module("lightrag.kg.shared_storage")
    shared_storage.initialize_share_data()
    yield
    if shared_storage._shared_dicts is not None:
        for key in list(shared_storage._shared_dicts.keys()):
            if key.endswith("pipeline_status") or key == "pipeline_status":
                ns = shared_storage._shared_dicts[key]
                if isinstance(ns, dict):
                    ns["busy"] = False
                    ns["scanning"] = False


def _doc(status: DocStatus, doc_id: str, metadata=None) -> DocProcessingStatus:
    return DocProcessingStatus(
        content_summary=f"{status.value} summary",
        content_length=10,
        file_path=f"{doc_id}.pdf",
        status=status,
        created_at="2024-01-01T00:00:00+00:00",
        updated_at="2024-01-01T00:00:00+00:00",
        metadata=metadata or {},
    )


class _FakeDocStatusStorage:
    """In-memory doc_status with soft-delete semantics mirroring the real
    backends: paginated/counts exclude ``deleted`` unless include_deleted,
    update_doc_status_fields writes status+metadata, get_by_id reads back
    as a plain dict (the real backends' contract)."""

    def __init__(self):
        self.docs = {
            "live-doc": _doc(DocStatus.PROCESSED, "live"),
            "trash-doc": _doc(
                DocStatus.DELETED,
                "trash",
                metadata={
                    "deleted_at": "2024-02-01T00:00:00+00:00",
                    "deleted_by": "alice",
                    "original_status": "processed",
                },
            ),
        }
        self.update_calls = []

    async def get_by_id(self, doc_id):
        row = self.docs.get(doc_id)
        if row is None:
            return None
        return {
            "status": row.status.value,
            "metadata": dict(row.metadata or {}),
            "file_path": row.file_path,
        }

    async def update_doc_status_fields(self, doc_id, fields, *, missing_ok=False):
        if doc_id not in self.docs:
            if missing_ok:
                return
            raise KeyError(doc_id)
        self.update_calls.append((doc_id, dict(fields)))
        row = self.docs[doc_id]
        for key, value in fields.items():
            if key == "status":
                row.status = DocStatus(value)
            else:
                setattr(row, key, value)

    async def get_docs_paginated(
        self,
        status_filter=None,
        status_filters=None,
        page=1,
        page_size=50,
        sort_field="updated_at",
        sort_direction="desc",
        include_deleted=False,
    ):
        selected = (
            DocStatusStorage.resolve_status_filter_values(
                status_filter=status_filter, status_filters=status_filters
            )
            if status_filter is not None or status_filters is not None
            else None
        )
        documents = [
            (doc_id, doc)
            for doc_id, doc in self.docs.items()
            if (selected is None or doc.status.value in selected)
            and (include_deleted or doc.status != DocStatus.DELETED)
        ]
        return documents[:page_size], len(documents)

    async def get_all_status_counts(self, include_deleted=False):
        counts = {}
        for doc in self.docs.values():
            key = doc.status.value
            counts[key] = counts.get(key, 0) + 1
        if not include_deleted:
            counts.pop("deleted", None)
        counts["all"] = sum(counts.values())
        return counts

    async def get_doc_by_id(self, doc_id):
        return self.docs.get(doc_id)


DocStatusStorage = _base.DocStatusStorage


class _BusyRag:
    """Minimal rag for the physical-delete (purge) path: pipeline_status is
    never bootstrapped, so _acquire_destructive_busy returns (True, None)."""

    def __init__(self, workspace="ws"):
        self.workspace = workspace
        self.doc_status = _FakeDocStatusStorage()
        self.adelete_by_doc_id_calls = []

    async def adelete_by_doc_id(self, doc_id, delete_llm_cache=False):
        self.adelete_by_doc_id_calls.append(doc_id)
        return {"status": "success"}


def _make_client():
    rag = _BusyRag()
    app = FastAPI()
    # get_managed_background_tasks reads request.app.state.background_tasks.
    app.state.background_tasks = set()
    app.include_router(
        create_document_routes(
            rag,
            SimpleNamespace(),
            api_key="test-key",
        )
    )
    client = TestClient(app)
    return client, rag


_headers = {"X-API-Key": "test-key"}


def test_delete_document_defaults_to_soft_delete():
    client, rag = _make_client()
    response = client.request(
        "DELETE",
        "/documents/delete_document",
        headers=_headers,
        json={"doc_ids": ["live-doc"]},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "soft_deleted"

    row = rag.doc_status.docs["live-doc"]
    assert row.status == DocStatus.DELETED
    assert row.metadata["original_status"] == "processed"
    # api-key auth fills the account username; the soft delete records whoever
    # issued it (non-empty here), never None.
    assert row.metadata["deleted_by"]
    assert "deleted_at" in row.metadata

    # No destructive slot was taken: the pipeline was never touched, and no
    # physical deletion ran.
    assert rag.adelete_by_doc_id_calls == []
    # Soft delete is idempotent (row already deleted -> untouched).
    first_deleted_at = row.metadata["deleted_at"]
    response2 = client.request(
        "DELETE",
        "/documents/delete_document",
        headers=_headers,
        json={"doc_ids": ["live-doc"]},
    )
    assert response2.json()["status"] == "soft_deleted"
    assert rag.doc_status.docs["live-doc"].metadata["deleted_at"] == first_deleted_at


def test_delete_document_purge_true_uses_physical_delete_path():
    client, rag = _make_client()
    response = client.request(
        "DELETE",
        "/documents/delete_document",
        headers=_headers,
        json={"doc_ids": ["live-doc"], "purge": True},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "deletion_started"
    # The fake backend has no pipeline_status bootstrapped, so the destructive
    # slot is trivially acquired and the bg task is handed off; physical
    # deletion itself runs in the background task (not asserted here).
    assert payload["doc_id"] == "live-doc"


def test_recycle_bin_lists_only_deleted_rows():
    client, _rag = _make_client()
    response = client.get("/documents/recycle_bin", headers=_headers)
    assert response.status_code == 200
    payload = response.json()
    doc_ids = [doc["id"] for doc in payload["documents"]]
    assert doc_ids == ["trash-doc"]
    assert payload["pagination"]["total_count"] == 1
    # status_counts are the LIVE counts (deleted excluded).
    assert "deleted" not in payload["status_counts"]


def test_restore_flips_back_to_original_status():
    client, rag = _make_client()
    response = client.post(
        "/documents/restore", headers=_headers, json={"doc_ids": ["trash-doc"]}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["restored_docs"] == ["trash-doc"]
    assert payload["failed_docs"] == []

    row = rag.doc_status.docs["trash-doc"]
    assert row.status == DocStatus.PROCESSED
    assert "deleted_at" not in row.metadata
    assert "deleted_by" not in row.metadata
    assert "original_status" not in row.metadata


def test_restore_reports_failed_for_non_recycle_bin_docs():
    client, rag = _make_client()
    response = client.post(
        "/documents/restore",
        headers=_headers,
        json={"doc_ids": ["live-doc", "ghost-doc"]},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["restored_docs"] == []
    assert sorted(payload["failed_docs"]) == ["ghost-doc", "live-doc"]
    # live-doc is untouched.
    assert rag.doc_status.docs["live-doc"].status == DocStatus.PROCESSED


def test_purge_uses_destructive_slot():
    client, rag = _make_client()
    response = client.request(
        "DELETE",
        "/documents/purge",
        headers=_headers,
        json={"doc_ids": ["trash-doc"]},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "deletion_started"
    assert payload["doc_id"] == "trash-doc"
    # The background task would physically delete; the fake backend's
    # background_delete_documents never runs inside the test client, so no
    # assertion on storage state here — the endpoint contract (reservation +
    # hand-off) is what this pins.


def test_paginated_excludes_deleted_by_default():
    client, _rag = _make_client()
    response = client.post(
        "/documents/paginated",
        headers=_headers,
        json={"page": 1, "page_size": 10},
    )
    assert response.status_code == 200
    payload = response.json()
    doc_ids = [doc["id"] for doc in payload["documents"]]
    assert "trash-doc" not in doc_ids
    assert payload["pagination"]["total_count"] == 1
