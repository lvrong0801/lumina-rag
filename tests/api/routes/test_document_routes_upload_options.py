"""Tests for the `/documents/upload` advanced-settings form fields.

``chunk_size`` / ``chunk_overlap_size`` are merged (over the filename-hint
params) into a fresh ``addon_params`` snapshot for the ACTIVE chunking
strategy and forwarded to ``pipeline_index_file``; ``summary_language`` /
``enable_multimodal`` ride the ``doc_status_extra`` → ``doc_status.metadata``
channel so every processing attempt honours them. An invalid effective
``chunk_overlap_size >= chunk_size`` combination is a synchronous HTTP 400 —
never an async error document after the upload has been accepted.
"""

import asyncio
import importlib
import io
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lightrag.chunker import chunking_by_token_size

_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
_dr = importlib.import_module("lightrag.api.routers.document_routes")
_shared_storage = importlib.import_module("lightrag.kg.shared_storage")
sys.argv = _original_argv

pytestmark = pytest.mark.offline

_HEADERS = {"X-API-Key": "test-key"}


class _FakeDocStatus:
    async def get_by_id(self, doc_id):
        return None

    async def get_doc_by_file_basename(self, basename):
        return None


class _FakeRag:
    def __init__(self):
        self.doc_status = _FakeDocStatus()
        # {} resolves to the default chunker config (fixed_token 1200/100).
        self.addon_params = {}
        self.chunking_func = chunking_by_token_size


def _make_client(monkeypatch, tmp_path):
    """Build a TestClient whose background indexing work runs inline and whose
    ``pipeline_index_file`` is a spy recording the forwarded kwargs."""
    captured: dict = {}

    async def _spy(
        rag,
        file_path,
        track_id,
        admission_token=None,
        owner=None,
        doc_status_extra=None,
        chunk_options=None,
        parse_engine_override=None,
    ):
        captured["file_path"] = file_path
        captured["track_id"] = track_id
        captured["owner"] = owner
        captured["doc_status_extra"] = doc_status_extra
        captured["chunk_options"] = chunk_options
        captured["parse_engine_override"] = parse_engine_override

    async def _noop_reserve(rag, token):
        return False

    async def _noop_release(rag, token):
        return None

    async def _inline_task(background_tasks, *, work, backstop_release):
        started = asyncio.Event()
        await work(started)
        assert started.is_set()

    monkeypatch.setattr(_dr, "pipeline_index_file", _spy)
    monkeypatch.setattr(_dr, "_reserve_enqueue_slot", _noop_reserve)
    monkeypatch.setattr(_dr, "_release_enqueue_slot", _noop_release)
    monkeypatch.setattr(
        _shared_storage, "start_reserved_background_task", _inline_task
    )

    rag = _FakeRag()
    manager = _dr.DocumentManager(str(tmp_path / "inputs"))

    app = FastAPI()
    app.state.background_tasks = set()
    app.include_router(
        _dr.create_document_routes(rag, manager, api_key="test-key")
    )
    return TestClient(app), captured


def _post_upload(client, data=None, filename="a.txt"):
    return client.post(
        "/documents/upload",
        headers=_HEADERS,
        files={"file": (filename, io.BytesIO(b"hello world"), "text/plain")},
        data=data or {},
    )


def test_upload_without_overrides_forwards_none(monkeypatch, tmp_path):
    """Back-compat: no advanced fields -> no snapshot, no metadata extras."""
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client)
    assert resp.status_code == 200, resp.text
    assert captured["chunk_options"] is None
    assert captured["doc_status_extra"] is None


def test_upload_chunk_overrides_merged_into_active_strategy(
    monkeypatch, tmp_path
):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(
        client, data={"chunk_size": "1000", "chunk_overlap_size": "150"}
    )
    assert resp.status_code == 200, resp.text
    snapshot = captured["chunk_options"]
    assert snapshot is not None
    fixed = snapshot["fixed_token"]
    assert fixed["chunk_token_size"] == 1000
    assert fixed["chunk_overlap_token_size"] == 150


def test_upload_chunk_override_partial_keeps_server_size(
    monkeypatch, tmp_path
):
    """Only overlap given: the snapshot pins overlap and leaves chunk size to
    the live instance default (slim snapshot — no top-level pinning)."""
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"chunk_overlap_size": "200"})
    assert resp.status_code == 200, resp.text
    fixed = captured["chunk_options"]["fixed_token"]
    assert fixed["chunk_overlap_token_size"] == 200
    # NOT pinned: the effective size keeps tracking the server configuration.
    assert "chunk_token_size" not in fixed


def test_upload_chunk_overlap_equal_to_size_rejected(monkeypatch, tmp_path):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(
        client, data={"chunk_size": "100", "chunk_overlap_size": "100"}
    )
    assert resp.status_code == 400, resp.text
    assert "Invalid chunking configuration" in resp.json()["detail"]
    assert "chunk_options" not in captured


def test_upload_chunk_overlap_above_inherited_size_rejected(
    monkeypatch, tmp_path
):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"chunk_overlap_size": "5000"})
    assert resp.status_code == 400, resp.text
    assert "chunk_options" not in captured


def test_upload_negative_chunk_values_rejected(monkeypatch, tmp_path):
    client, _captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"chunk_size": "0"})
    assert resp.status_code == 400, resp.text
    resp = _post_upload(client, data={"chunk_overlap_size": "-1"})
    assert resp.status_code == 400, resp.text


def test_upload_summary_language_lands_in_doc_status_extra(
    monkeypatch, tmp_path
):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"summary_language": "English"})
    assert resp.status_code == 200, resp.text
    assert captured["doc_status_extra"] == {"summary_language": "English"}


def test_upload_summary_language_stripped(monkeypatch, tmp_path):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"summary_language": "  Chinese  "})
    assert resp.status_code == 200, resp.text
    assert captured["doc_status_extra"] == {"summary_language": "Chinese"}


def test_upload_overlong_summary_language_rejected(monkeypatch, tmp_path):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"summary_language": "x" * 101})
    assert resp.status_code == 400, resp.text
    assert "doc_status_extra" not in captured


def test_upload_enable_multimodal_true_and_false(monkeypatch, tmp_path):
    client, captured = _make_client(monkeypatch, tmp_path)
    resp = _post_upload(client, data={"enable_multimodal": "true"})
    assert resp.status_code == 200, resp.text
    assert captured["doc_status_extra"] == {"enable_multimodal": True}

    captured.clear()
    resp = _post_upload(
        client, data={"enable_multimodal": "false"}, filename="b.txt"
    )
    assert resp.status_code == 200, resp.text
    assert captured["doc_status_extra"] == {"enable_multimodal": False}


def test_upload_overrides_combine_with_mode_target_metadata(
    monkeypatch, tmp_path
):
    """incremental mode's ``incremental_of`` column and the upload-intent
    metadata keys must merge, never replace each other."""
    client, captured = _make_client(monkeypatch, tmp_path)

    class _TargetingDocStatus(_FakeDocStatus):
        async def get_by_id(self, doc_id):
            return {"status": "processed", "file_path": "old.txt"}

    class _TargetingRag(_FakeRag):
        def __init__(self):
            super().__init__()
            self.doc_status = _TargetingDocStatus()

    # Rebuild the client with the targeted rag.
    async def _noop_reserve(rag, token):
        return False

    async def _noop_release(rag, token):
        return None

    async def _inline_task(background_tasks, *, work, backstop_release):
        started = asyncio.Event()
        await work(started)
        assert started.is_set()

    async def _spy(
        rag,
        file_path,
        track_id,
        admission_token=None,
        owner=None,
        doc_status_extra=None,
        chunk_options=None,
        parse_engine_override=None,
    ):
        captured.clear()
        captured["doc_status_extra"] = doc_status_extra
        captured["chunk_options"] = chunk_options
        captured["parse_engine_override"] = parse_engine_override

    monkeypatch.setattr(_dr, "pipeline_index_file", _spy)
    monkeypatch.setattr(_dr, "_reserve_enqueue_slot", _noop_reserve)
    monkeypatch.setattr(_dr, "_release_enqueue_slot", _noop_release)
    monkeypatch.setattr(
        _shared_storage, "start_reserved_background_task", _inline_task
    )

    rag = _TargetingRag()
    manager = _dr.DocumentManager(str(tmp_path / "inputs-inc"))
    app = FastAPI()
    app.state.background_tasks = set()
    app.include_router(
        _dr.create_document_routes(rag, manager, api_key="test-key")
    )
    client = TestClient(app)

    resp = client.post(
        "/documents/upload",
        headers=_HEADERS,
        files={"file": ("new.txt", io.BytesIO(b"hello world"), "text/plain")},
        data={
            "mode": "incremental",
            "target_doc_ids": ["doc-old"],
            "summary_language": "Chinese",
            "chunk_size": "1500",
        },
    )
    assert resp.status_code == 200, resp.text
    extra = captured["doc_status_extra"]
    assert extra["incremental_of"] == ["doc-old"]
    assert extra["summary_language"] == "Chinese"
    fixed = captured["chunk_options"]["fixed_token"]
    assert fixed["chunk_token_size"] == 1500


class TestParseEngineOverride:
    """``parse_engine`` Form field: synchronous validation + precedence.

    A bare engine name must be user-selectable, deployed (endpoint/package
    gate) and able to read the uploaded suffix — every violation is a 400
    before any file is written. An explicit filename ``[engine]`` hint
    outranks the batch-level form value (per-file intent wins).
    """

    def test_unknown_engine_rejected(self, monkeypatch, tmp_path):
        client, _ = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(client, data={"parse_engine": "not-an-engine"})
        assert resp.status_code == 400
        assert "Unknown parse engine" in resp.json()["detail"]

    def test_blank_engine_rejected(self, monkeypatch, tmp_path):
        client, _ = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(client, data={"parse_engine": "   "})
        assert resp.status_code == 400
        assert "must not be empty" in resp.json()["detail"]

    def test_unavailable_engine_rejected(self, monkeypatch, tmp_path):
        # Docling needs a configured endpoint; without one the choice must
        # fail fast with the missing requirement named in the body.
        monkeypatch.delenv("DOCLING_ENDPOINT", raising=False)
        client, _ = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(
            client, data={"parse_engine": "docling"}, filename="a.pdf"
        )
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "docling" in detail and "not available" in detail

    def test_suffix_mismatch_rejected(self, monkeypatch, tmp_path):
        from lightrag.parser import registry as _reg

        # Force the availability gate so the assertion is deterministic on
        # machines without the optional package installed.
        monkeypatch.setattr(_reg, "engine_endpoint_configured", lambda e: True)
        client, _ = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(client, data={"parse_engine": "pymupdf4llm"})
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "pymupdf4llm" in detail and ".pdf" in detail

    def test_valid_engine_forwarded(self, monkeypatch, tmp_path):
        from lightrag.parser import registry as _reg

        monkeypatch.setattr(_reg, "engine_endpoint_configured", lambda e: True)
        client, captured = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(
            client, data={"parse_engine": "pymupdf4llm"}, filename="a.pdf"
        )
        assert resp.status_code == 200, resp.text
        assert captured["parse_engine_override"] == "pymupdf4llm"

    def test_filename_hint_outranks_form_choice(self, monkeypatch, tmp_path):
        # legacy is deployed in every environment (in-process), so the hint
        # on this filename wins and the docling request never gets gated on
        # endpoint availability at all.
        monkeypatch.delenv("DOCLING_ENDPOINT", raising=False)
        client, captured = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(
            client, data={"parse_engine": "docling"}, filename="a.[legacy].pdf"
        )
        assert resp.status_code == 200, resp.text
        assert captured["parse_engine_override"] is None

    def test_omitted_engine_forwards_none(self, monkeypatch, tmp_path):
        client, captured = _make_client(monkeypatch, tmp_path)
        resp = _post_upload(client, filename="a.pdf")
        assert resp.status_code == 200, resp.text
        assert captured["parse_engine_override"] is None
