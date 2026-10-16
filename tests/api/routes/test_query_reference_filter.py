"""HTTP-level integration for reference filtering on /query, /query/stream
and /query/data.

RBAC_ENFORCE=false (the default) passes references through untouched; with an
enforcing RBAC manager on ``app.state`` the three endpoints filter references
and chunks through ``filter_references_and_chunks`` before responding. The
rule-level behaviour (owner isolation, soft-delete invisibility, renumbering)
is covered by tests/api/reference_access/; here we pin the wiring.
"""

import json
import sys
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

_ENV_VARS_TO_ISOLATE = (
    "LLM_BINDING",
    "EMBEDDING_BINDING",
    "OPENAI_API_KEY",
    "AUTH_ACCOUNTS",
    "TOKEN_SECRET",
    "LIGHTRAG_API_KEY",
    "WHITELIST_PATHS",
    "LIGHTRAG_API_PREFIX",
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    for var in _ENV_VARS_TO_ISOLATE:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AUTH_ACCOUNTS", "")
    monkeypatch.setenv("TOKEN_SECRET", "")
    monkeypatch.setenv("LIGHTRAG_API_KEY", "")
    monkeypatch.setenv("LLM_BINDING", "openai")
    monkeypatch.setenv("EMBEDDING_BINDING", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    auth_module = sys.modules.get("lightrag.api.auth")
    if auth_module is not None:
        monkeypatch.setattr(auth_module.auth_handler, "accounts", {}, raising=False)
    utils_api_module = sys.modules.get("lightrag.api.utils_api")
    if utils_api_module is not None:
        monkeypatch.setattr(utils_api_module, "auth_configured", False, raising=False)

    import lightrag.api.config as config

    config._global_args = None
    config._initialized = False
    yield
    config._global_args = None
    config._initialized = False


class _FakeRBAC:
    """Minimal enforcing RBAC manager stand-in."""

    def __init__(self, enforce: bool = True):
        self.enforce = enforce

    async def get_permissions(self, username: str):
        return {}


def _build_client():
    original_argv = sys.argv.copy()
    try:
        sys.argv = ["lightrag-server"]
        from lightrag.api.config import parse_args
        from lightrag.api.lightrag_server import create_app

        args = parse_args()

        mock_rag = MagicMock()

        async def _fake_aquery(*_a, **_kw):
            return {
                "llm_response": {"content": "answer", "llm_generated": True},
                "data": {
                    "references": [
                        {"reference_id": "1", "file_path": "/documents/a.pdf"},
                        {"reference_id": "2", "file_path": "/documents/b.pdf"},
                    ],
                    "chunks": [
                        {"content": "chunk-a", "file_path": "/documents/a.pdf",
                         "chunk_id": "c1", "reference_id": "1"},
                        {"content": "chunk-b", "file_path": "/documents/b.pdf",
                         "chunk_id": "c2", "reference_id": "2"},
                    ],
                },
            }

        async def _fake_aquery_data(*_a, **_kw):
            return {
                "status": "success",
                "message": "ok",
                "data": {
                    "entities": [],
                    "relationships": [],
                    "chunks": [
                        {"content": "chunk-a", "file_path": "/documents/a.pdf",
                         "chunk_id": "c1", "reference_id": "1"},
                    ],
                    "references": [
                        {"reference_id": "1", "file_path": "/documents/a.pdf"},
                    ],
                },
                "metadata": {},
            }

        mock_rag.aquery_llm = MagicMock(side_effect=_fake_aquery)
        mock_rag.aquery_data = MagicMock(side_effect=_fake_aquery_data)

        with patch("lightrag.api.lightrag_server.LightRAG", return_value=mock_rag):
            app = create_app(args)
        return app, TestClient(app), mock_rag
    finally:
        sys.argv = original_argv


@pytest.fixture
def client():
    return _build_client()


def _post_query(client, payload):
    return client.post("/query", json=payload)


def test_query_passthrough_without_rbac(client):
    app, test_client, _ = client
    # create_app leaves rbac_manager unset when PG is unavailable in tests;
    # ensure it stays None so the filter is a no-op.
    app.state.rbac_manager = None
    resp = _post_query(test_client, {
        "query": "test query", "mode": "mix", "include_references": True
    })
    assert resp.status_code == 200
    body = resp.json()
    assert [r["file_path"] for r in body["references"]] == [
        "/documents/a.pdf", "/documents/b.pdf"
    ]


def test_query_filters_references_when_enforced(client):
    app, test_client, mock_rag = client
    app.state.rbac_manager = _FakeRBAC(enforce=True)
    # Every document resolves to None (soft-deleted/unknown): all references
    # must be dropped by the endpoint-level filter.
    mock_rag.doc_status = MagicMock()
    async def _missing(_basename):
        return None
    mock_rag.doc_status.get_doc_by_file_basename = MagicMock(side_effect=_missing)

    resp = _post_query(test_client, {
        "query": "test query", "mode": "mix", "include_references": True
    })
    assert resp.status_code == 200
    assert resp.json()["references"] == []


def test_query_keeps_visible_references_when_enforced(client):
    app, test_client, mock_rag = client
    app.state.rbac_manager = _FakeRBAC(enforce=True)
    # b.pdf is unknown/deleted, a.pdf exists and is public (no owner).
    mock_rag.doc_status = MagicMock()
    async def _lookup(basename):
        if basename == "a.pdf":
            return ("doc-a", {"status": "processed", "metadata": {}})
        return None
    mock_rag.doc_status.get_doc_by_file_basename = MagicMock(side_effect=_lookup)

    resp = _post_query(test_client, {
        "query": "test query", "mode": "mix", "include_references": True
    })
    assert resp.status_code == 200
    body = resp.json()
    assert [r["file_path"] for r in body["references"]] == ["/documents/a.pdf"]
    assert [r["reference_id"] for r in body["references"]] == ["1"]


def test_stream_filters_references_when_enforced(client):
    app, test_client, mock_rag = client
    app.state.rbac_manager = _FakeRBAC(enforce=True)
    mock_rag.doc_status = MagicMock()
    async def _missing(_basename):
        return None
    mock_rag.doc_status.get_doc_by_file_basename = MagicMock(side_effect=_missing)

    resp = test_client.post("/query/stream", json={
        "query": "test query", "mode": "mix", "include_references": True
    })
    assert resp.status_code == 200
    first_line = json.loads(resp.text.strip().split("\n")[0])
    assert "references" in first_line
    assert first_line["references"] == []


def test_query_data_filters_references_when_enforced(client):
    app, test_client, mock_rag = client
    app.state.rbac_manager = _FakeRBAC(enforce=True)
    mock_rag.doc_status = MagicMock()
    async def _missing(_basename):
        return None
    mock_rag.doc_status.get_doc_by_file_basename = MagicMock(side_effect=_missing)

    resp = test_client.post("/query/data", json={
        "query": "test query", "mode": "mix"
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["references"] == []
    assert body["data"]["chunks"] == []
