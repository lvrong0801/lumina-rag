"""AuditLogger and AuditMiddleware tests.

AuditLogger is tested against an in-memory fake answering the exact SQL shapes
it issues (INSERT into LIGHTRAG_AUDIT_LOG; SELECT with optional WHERE clauses).
AuditMiddleware is exercised through a minimal Starlette app with the real
middleware, so route matching, identity resolution, status classification and
the never-break-the-response contract are all verified end to end.
"""
import sys

import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

# The api/auth chain parses sys.argv with argparse at first config access;
# pytest's argv (test paths) would abort with SystemExit 2. Pin a clean argv
# for the import, then restore (config is already initialized).
_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
from lightrag.api.audit import ACTION_UPLOAD, AuditLogger, AuditMiddleware

sys.argv = _original_argv


class FakeDb:
    def __init__(self):
        self.inserts: list[dict] = []
        self.query_calls: list[tuple[str, list]] = []
        self.rows: list[dict] = []
        self.fail_insert = False

    async def execute(self, sql, params=None):
        if self.fail_insert:
            raise RuntimeError("db down")
        self.inserts.append(dict(params or {}))

    async def query(self, sql, params=None, multirows=True):
        self.query_calls.append((sql, list(params or [])))
        return list(self.rows)


@pytest.fixture
def logger():
    return AuditLogger(FakeDb(), enabled=True)


# ── AuditLogger ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_record_writes_all_fields(logger: AuditLogger):
    await logger.record(
        action=ACTION_UPLOAD,
        status="success",
        username="alice",
        role="manager",
        workspace="docs",
        resource_type="document",
        resource_id="doc-1",
        ip="127.0.0.1",
        user_agent="pytest",
        detail={"method": "POST", "path": "/documents/upload"},
        request_id="req-1",
    )
    assert len(logger._db.inserts) == 1
    row = logger._db.inserts[0]
    assert row["action"] == ACTION_UPLOAD
    assert row["username"] == "alice"
    assert row["role"] == "manager"
    assert row["workspace"] == "docs"
    assert row["resource_id"] == "doc-1"
    assert row["ip"] == "127.0.0.1"
    assert row["detail"]["path"] == "/documents/upload"


@pytest.mark.asyncio
async def test_record_disabled_is_noop():
    db = FakeDb()
    logger = AuditLogger(db, enabled=False)
    await logger.record(action=ACTION_UPLOAD)
    assert db.inserts == []


@pytest.mark.asyncio
async def test_record_failure_is_swallowed(logger: AuditLogger):
    db: FakeDb = logger._db
    db.fail_insert = True
    # Must not raise into the audited operation (resilience contract).
    await logger.record(action=ACTION_UPLOAD, username="alice")
    assert db.inserts == []


@pytest.mark.asyncio
async def test_query_logs_builds_filters_and_paging(logger: AuditLogger):
    db: FakeDb = logger._db
    db.rows = [{"id": 1, "action": ACTION_UPLOAD, "username": "alice"}]
    rows = await logger.query_logs(
        username="alice", action=ACTION_UPLOAD, limit=10, offset=20
    )
    assert rows == db.rows
    sql, params = db.query_calls[0]
    assert "username = $1" in sql
    assert "action = $2" in sql
    assert params[-2] == 10  # LIMIT
    assert params[-1] == 20  # OFFSET


# ── AuditMiddleware ─────────────────────────────────────────────────────────

def _make_app(logger: AuditLogger) -> Starlette:
    async def upload_handler(request: Request):
        return JSONResponse({"ok": True})

    async def forbidden_handler(request: Request):
        from starlette.exceptions import HTTPException

        raise HTTPException(status_code=403, detail="denied")

    app = Starlette(
        routes=[
            Route("/documents/upload", upload_handler, methods=["POST"]),
            Route("/admin/users/{username}", forbidden_handler, methods=["DELETE"]),
            Route("/query", upload_handler, methods=["POST"]),
        ]
    )
    app.add_middleware(AuditMiddleware, audit_logger=logger, api_key="svc-key")
    return app


def test_middleware_records_matched_change_operation():
    logger = AuditLogger(FakeDb(), enabled=True)
    app = _make_app(logger)
    client = TestClient(app)
    resp = client.post("/documents/upload", json={"file_ids": ["x"]})
    assert resp.status_code == 200
    assert len(logger._db.inserts) == 1
    row = logger._db.inserts[0]
    assert row["action"] == ACTION_UPLOAD
    assert row["status"] == "success"


def test_middleware_classifies_403_as_denied():
    logger = AuditLogger(FakeDb(), enabled=True)
    app = _make_app(logger)
    client = TestClient(app)
    resp = client.delete("/admin/users/alice", headers={"X-API-Key": "svc-key"})
    assert resp.status_code == 403
    assert len(logger._db.inserts) == 1
    assert logger._db.inserts[0]["status"] == "denied"


def test_middleware_never_audits_read_or_unmapped_routes():
    logger = AuditLogger(FakeDb(), enabled=True)
    app = _make_app(logger)
    client = TestClient(app)
    client.post("/query", json={"query": "hi"})
    assert logger._db.inserts == []


def test_middleware_disabled_logger_passes_through():
    logger = AuditLogger(FakeDb(), enabled=False)
    app = _make_app(logger)
    client = TestClient(app)
    resp = client.post("/documents/upload", json={})
    assert resp.status_code == 200
    assert logger._db.inserts == []


def test_middleware_identity_from_request_state():
    logger = AuditLogger(FakeDb(), enabled=True)
    app = _make_app(logger)
    client = TestClient(app)
    client.post(
        "/documents/upload",
        headers={"Authorization": "Bearer not-a-jwt", "LIGHTRAG-WORKSPACE": "docs"},
    )
    row = logger._db.inserts[0]
    # Unparsable token -> no identity, but workspace header still recorded.
    assert row["username"] is None
    assert row["workspace"] == "docs"
