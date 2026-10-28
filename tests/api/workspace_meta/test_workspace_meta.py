"""WorkspaceMetaManager unit tests against an in-memory PostgreSQL-shaped fake.

The fake answers the exact SQL shapes WorkspaceMetaManager issues on
LIGHTRAG_WORKSPACES, so the tests pin the two regressions behind the "editing
a workspace description has no effect" report without a live database:

- get_workspace_meta_manager must borrow the already-initialized shared pool
  (no vector-signature guessing from env vars);
- update() must upsert, so a legacy workspace without a metadata row is
  editable instead of silently matching zero rows.
"""
import re
import sys
import types

import pytest

from lightrag.api import workspace_meta
from lightrag.api.workspace_meta import WorkspaceMetaManager


class FakeDb:
    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.executed: list[str] = []

    async def query(self, sql, params=None, multirows=True):
        if "FROM LIGHTRAG_WORKSPACES WHERE name" in sql:
            row = self.rows.get((params or [None])[0])
            return [dict(row)] if row else []
        if "FROM LIGHTRAG_WORKSPACES ORDER BY name" in sql:
            return [dict(r) for _, r in sorted(self.rows.items())]
        if "INSERT INTO LIGHTRAG_WORKSPACES" in sql and "RETURNING" in sql:
            # PostgreSQLDB.query binds tuple(params): a list is mandatory —
            # a dict would bind its keys. Fail loud if that regresses.
            assert isinstance(params, (list, tuple)), "create() must bind positionally"
            name, owner, description = params
            if name in self.rows:
                return []
            self.rows[name] = {
                "name": name,
                "owner": owner,
                "description": description,
                "status": "active",
                "created_at": None,
                "updated_at": None,
            }
            return [{"name": name}]
        return []

    async def execute(self, sql, params=None):
        self.executed.append(sql)
        if "ON CONFLICT (name) DO UPDATE" in sql:
            # Positional p1..pn binding; column order follows the INSERT list.
            columns = re.search(r"\(([^)]*)\)\s*VALUES", sql).group(1).split(",")
            record = dict(zip((c.strip() for c in columns), params.values()))
            row = self.rows.setdefault(
                record["name"],
                {
                    "name": record["name"],
                    "owner": None,
                    "description": "",
                    "status": "active",
                    "created_at": None,
                    "updated_at": None,
                },
            )
            row.update({k: v for k, v in record.items() if k != "name"})
        elif "DELETE FROM LIGHTRAG_WORKSPACES" in sql:
            self.rows.pop(params["name"], None)


@pytest.fixture
def meta():
    return WorkspaceMetaManager(FakeDb())


# ── create() ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_persists_owner_and_description(meta: WorkspaceMetaManager):
    """create() must bind values, not keys: PostgreSQLDB.query binds
    tuple(params), so a dict would store the literal key strings and blow the
    owner FK. (Surfaced live as a foreign-key violation on owner='owner'.)"""
    assert await meta.create("fresh", owner="admin", description="v1") is True
    row = await meta.get("fresh")
    assert row["owner"] == "admin"
    assert row["description"] == "v1"
    # Idempotent: second create does not clobber the stored row.
    assert await meta.create("fresh", owner="mallory", description="x") is False
    row = await meta.get("fresh")
    assert row["owner"] == "admin"


# ── update() upsert ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_inserts_row_for_legacy_workspace(meta: WorkspaceMetaManager):
    """A workspace with no metadata row (legacy directory) must be editable."""
    db: FakeDb = meta._db
    assert await meta.update("legacy", description="v1", status="archived") is True
    row = await meta.get("legacy")
    assert row["description"] == "v1"
    assert row["status"] == "archived"
    assert row["owner"] is None
    assert any("ON CONFLICT (name) DO UPDATE" in sql for sql in db.executed)


@pytest.mark.asyncio
async def test_update_existing_row_changes_only_provided_fields(
    meta: WorkspaceMetaManager,
):
    db: FakeDb = meta._db
    db.rows["docs"] = {
        "name": "docs",
        "owner": "admin",
        "description": "before",
        "status": "active",
        "created_at": None,
        "updated_at": None,
    }
    assert await meta.update("docs", description="after") is True
    row = await meta.get("docs")
    assert row["description"] == "after"
    assert row["status"] == "active"
    assert row["owner"] == "admin"


@pytest.mark.asyncio
async def test_update_invalidates_status_cache(meta: WorkspaceMetaManager):
    db: FakeDb = meta._db
    db.rows["docs"] = {
        "name": "docs",
        "owner": None,
        "description": "",
        "status": "active",
        "created_at": None,
        "updated_at": None,
    }
    assert await meta.get_status("docs") == "active"  # warm the cache
    await meta.update("docs", status="archived")
    assert await meta.get_status("docs") == "archived"


@pytest.mark.asyncio
async def test_update_without_fields_is_noop(meta: WorkspaceMetaManager):
    db: FakeDb = meta._db
    assert await meta.update("docs") is False
    assert db.executed == []


@pytest.mark.asyncio
async def test_update_rejects_invalid_status_before_any_sql(
    meta: WorkspaceMetaManager,
):
    db: FakeDb = meta._db
    with pytest.raises(ValueError):
        await meta.update("docs", status="frozen")
    assert db.executed == []


# ── get_workspace_meta_manager pool acquisition ─────────────────────────────


def _stub_postgres_impl(monkeypatch, *, initialized_db):
    class StubClientManager:
        @classmethod
        async def get_initialized_client(cls):
            return initialized_db()

        @classmethod
        async def get_client(cls, vector_storage=None):  # pragma: no cover
            raise AssertionError(
                "get_workspace_meta_manager must not re-demand a vector signature"
            )

    module = types.ModuleType("lightrag.kg.postgres_impl")
    module.ClientManager = StubClientManager
    monkeypatch.setitem(sys.modules, "lightrag.kg.postgres_impl", module)
    return module


@pytest.fixture
def reset_manager(monkeypatch):
    monkeypatch.setattr(workspace_meta, "_meta_manager", None)
    return monkeypatch


@pytest.mark.asyncio
async def test_manager_borrows_initialized_pool_without_env_signature(
    reset_manager,
):
    """The env var LIGHTRAG_VECTOR_STORAGE must not decide whether metadata
    works: the manager uses whatever pool the storages already initialized."""
    reset_manager.delenv("LIGHTRAG_VECTOR_STORAGE", raising=False)
    _stub_postgres_impl(reset_manager, initialized_db=FakeDb)
    manager = await workspace_meta.get_workspace_meta_manager()
    assert manager is not None
    assert isinstance(manager._db, FakeDb)
    # Success is cached process-wide: the second call returns the same one.
    assert await workspace_meta.get_workspace_meta_manager() is manager


@pytest.mark.asyncio
async def test_manager_waits_for_pool_and_retries(reset_manager):
    holder = {"db": None}
    _stub_postgres_impl(reset_manager, initialized_db=lambda: holder["db"])
    assert await workspace_meta.get_workspace_meta_manager() is None
    # The negative result is not cached: a later call after pool init succeeds.
    holder["db"] = FakeDb()
    assert await workspace_meta.get_workspace_meta_manager() is not None
