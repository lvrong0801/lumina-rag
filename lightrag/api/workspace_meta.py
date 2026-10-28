"""
Persistent workspace metadata (``LIGHTRAG_WORKSPACES``).

The P0 model kept workspace identity in filesystem directories plus RBAC grant
rows; this module adds the persistent metadata row (owner, description, status)
that multi-tenant deepening needs: who created the workspace, what it is for,
and whether it is ``active`` (accepts writes) or ``archived`` (read-only).

Degradation: when PostgreSQL is unavailable, every method degrades to a
no-op / empty result so the server keeps working in its auth-only mode. The
manager is process-wide and shares the PostgreSQL client exactly like
:class:`lightrag.api.rbac.RBACManager`.
"""
import asyncio
import time
from typing import Any, Dict, List, Optional

from lightrag.utils import logger

# TTL of the in-process status cache (used by the archive gate).
STATUS_TTL_SECONDS = 30.0

VALID_STATUSES = frozenset({"active", "archived"})


class WorkspaceMetaManager:
    """DB-backed workspace metadata store sharing the PostgreSQL client."""

    def __init__(self, db: Any) -> None:
        self._db = db
        # name -> (monotonic ts, status | None); None means "no row".
        self._status_cache: Dict[str, tuple[float, Optional[str]]] = {}
        self._lock = asyncio.Lock()

    # ── Internal DB access ────────────────────────────────────────────────

    async def _query_row(self, name: str) -> Optional[dict]:
        rows = await self._db.query(
            "SELECT name, owner, description, status, created_at, updated_at "
            "FROM LIGHTRAG_WORKSPACES WHERE name = $1",
            [name],
            multirows=True,
        )
        return dict(rows[0]) if rows else None

    async def get(self, name: str) -> Optional[dict]:
        """Return the workspace metadata row or None."""
        try:
            return await self._query_row(name)
        except Exception as exc:  # pragma: no cover - PG down mid-flight
            logger.warning(f"WorkspaceMeta: cannot read workspace '{name}': {exc}")
            return None

    async def get_status(self, name: str) -> Optional[str]:
        """Return the workspace status (``active``/``archived``), TTL-cached.

        ``None`` means "no row" (legacy workspace created before the metadata
        table existed) — treated as ``active`` by callers.
        """
        now = time.monotonic()
        cached = self._status_cache.get(name)
        if cached is not None and now - cached[0] < STATUS_TTL_SECONDS:
            return cached[1]
        try:
            row = await self._query_row(name)
            status = row["status"] if row else None
        except Exception as exc:  # pragma: no cover - PG down mid-flight
            logger.warning(f"WorkspaceMeta: cannot check status of '{name}': {exc}")
            status = None
        self._status_cache[name] = (now, status)
        return status

    async def list_all(self) -> List[dict]:
        try:
            rows = await self._db.query(
                "SELECT name, owner, description, status, created_at, updated_at "
                "FROM LIGHTRAG_WORKSPACES ORDER BY name",
                multirows=True,
            )
            return [dict(r) for r in (rows or [])]
        except Exception as exc:  # pragma: no cover - PG down
            logger.warning(f"WorkspaceMeta: cannot list workspaces: {exc}")
            return []

    # ── Mutations ─────────────────────────────────────────────────────────

    async def create(
        self,
        name: str,
        owner: Optional[str] = None,
        description: str = "",
    ) -> bool:
        """Insert a workspace metadata row. Returns True when inserted, False
        when a row already existed (idempotent)."""
        try:
            # query() binds tuple(params) — passing a dict would bind its KEYS
            # (unlike execute(), which binds data.values()).
            rows = await self._db.query(
                "INSERT INTO LIGHTRAG_WORKSPACES (name, owner, description) "
                "VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING RETURNING name",
                [name, owner or None, description or ""],
                multirows=True,
            )
            inserted = bool(rows)
            self._status_cache.pop(name, None)
            return inserted
        except Exception as exc:  # pragma: no cover - PG down
            logger.warning(f"WorkspaceMeta: cannot create workspace '{name}': {exc}")
            return False

    async def update(
        self,
        name: str,
        *,
        description: Optional[str] = None,
        status: Optional[str] = None,
    ) -> bool:
        """Update description and/or status via upsert. Returns True on success.

        Workspaces whose directory predates the metadata table (or whose row
        was never written) have no row to UPDATE; a plain UPDATE would match
        zero rows and silently change nothing while reporting success."""
        if status is not None and status not in VALID_STATUSES:
            raise ValueError(
                f"Invalid workspace status '{status}'. Expected active/archived."
            )
        provided: List[tuple[str, Any]] = []
        if description is not None:
            provided.append(("description", description))
        if status is not None:
            provided.append(("status", status))
        if not provided:
            return False
        # $1 binds name; provided fields bind $2..$n in order.
        columns = ", ".join(["name"] + [col for col, _ in provided])
        marks = ", ".join(["$1"] + [f"${i}" for i in range(2, len(provided) + 2)])
        sets = ", ".join(f"{col} = ${i}" for i, (col, _) in enumerate(provided, 2))
        sql = (
            f"INSERT INTO LIGHTRAG_WORKSPACES ({columns}) VALUES ({marks}) "
            f"ON CONFLICT (name) DO UPDATE SET {sets}, updated_at = now()"
        )
        try:
            # execute() binds tuple(data.values()) positionally, so use $1..$n
            # placeholders (asyncpg has no named-parameter support).
            values = [name] + [value for _, value in provided]
            await self._db.execute(sql, {f"p{i}": v for i, v in enumerate(values, 1)})
            self._status_cache.pop(name, None)
            return True
        except Exception as exc:  # pragma: no cover - PG down
            logger.warning(f"WorkspaceMeta: cannot update workspace '{name}': {exc}")
            return False

    async def delete(self, name: str) -> None:
        try:
            await self._db.execute(
                "DELETE FROM LIGHTRAG_WORKSPACES WHERE name = $1", {"name": name}
            )
        except Exception as exc:  # pragma: no cover - PG down
            logger.warning(f"WorkspaceMeta: cannot delete workspace '{name}': {exc}")
        self._status_cache.pop(name, None)


# Process-wide holder so the manager is created once and shared by routers.
_meta_manager: Optional[WorkspaceMetaManager] = None
_meta_lock = asyncio.Lock()


async def get_workspace_meta_manager() -> Optional[WorkspaceMetaManager]:
    """Return the process-wide workspace metadata manager, or None when
    PostgreSQL is unavailable (callers then degrade to no metadata).

    The manager borrows the shared client pool already initialized by the PG
    storages (or RBAC/audit at startup) instead of calling get_client itself:
    the pool refuses any caller whose vector-storage signature differs from the
    first initializer's, and this module has no way to know that signature —
    the env var that names the vector storage is not the variable the LightRAG
    instance was actually constructed with. When no pool exists yet the call
    returns None and is retried on the next request (only success is cached).
    """
    global _meta_manager
    async with _meta_lock:
        if _meta_manager is not None:
            return _meta_manager
        try:
            from lightrag.kg.postgres_impl import ClientManager

            db = await ClientManager.get_initialized_client()
        except Exception as exc:  # pragma: no cover - import/setup failure
            logger.warning(f"WorkspaceMeta: PostgreSQL unavailable, metadata disabled: {exc}")
            return None
        if db is None:
            logger.info(
                "WorkspaceMeta: PostgreSQL pool not initialized, metadata disabled"
            )
            return None
        _meta_manager = WorkspaceMetaManager(db)
        return _meta_manager
