"""
Workspace-level RBAC backed by PostgreSQL tables.

Roles (global, ``LIGHTRAG_USERS.role``): ``admin`` / ``manager`` / ``viewer``.
Workspace grants (``LIGHTRAG_WORKSPACE_PERMISSIONS``): a ``(username,
workspace, access_level)`` row with ``workspace=''`` naming the default
workspace and ``'*'`` a wildcard grant. Access levels: ``read`` / ``write`` /
``admin``.

Behavior contract
-----------------
- ``RBAC_ENFORCE=false`` (default): every authenticated caller keeps today's
  behavior — any authenticated caller reaches any workspace. The matrix is
  still stored and manageable, but not enforced.
- ``RBAC_ENFORCE=true``: every JWT-authenticated request is checked against the
  caller's role and workspace grants. ``X-API-Key`` callers are a service
  admin (``is_service_admin``) and are never blocked.
- Guest mode (no users configured anywhere) stays fully open.
- Authorization reads the DB through a short TTL cache (~30 s), so permission
  changes and role changes take effect without re-login; the JWT ``role``
  claim is only a fallback for the TTL window.

Seeding: at startup, when ``LIGHTRAG_USERS`` is empty, users are seeded from
``AUTH_ACCOUNTS`` (each becomes ``role=admin`` with a ``'*'`` grant) or, when
``AUTH_ACCOUNTS`` is unset, from ``INIT_ADMIN_USERNAME``/``INIT_ADMIN_PASSWORD``.
If neither is configured the system stays in guest mode.
"""
import asyncio
import time
from typing import Any, Dict, List, Optional, Tuple

from lightrag.utils import logger

WILDCARD = "*"
DEFAULT_WORKSPACE = ""

# Access levels sufficient for each action class.
READ_LEVELS = frozenset({"read", "write", "admin"})
WRITE_LEVELS = frozenset({"write", "admin"})
ACTION_LEVELS = {
    "read": READ_LEVELS,
    "write": WRITE_LEVELS,
}

VALID_ROLES = frozenset({"admin", "manager", "viewer"})
VALID_ACCESS_LEVELS = frozenset({"read", "write", "admin"})

# TTL of the in-process user/permission caches.
USER_TTL_SECONDS = 30.0
PERM_TTL_SECONDS = 30.0


class RBACManager:
    """Database-backed RBAC manager sharing the process's PostgreSQL client."""

    def __init__(
        self,
        db: Any,
        enforce: bool = False,
        redis: Optional[Any] = None,
        redis_prefix: str = "lightrag:",
    ):
        self._db = db
        self._enforce = enforce
        # username -> (monotonic ts, user dict | None)
        self._users: Dict[str, Tuple[float, Optional[dict]]] = {}
        # username -> (monotonic ts, {workspace: access_level})
        self._perms: Dict[str, Tuple[float, dict[str, str]]] = {}
        self._lock = asyncio.Lock()
        # Cross-worker cache layer (optional): when Redis is reachable the
        # TTL caches are mirrored there so a permission/role change in one
        # worker is seen by the others within the TTL window. ``None`` keeps
        # the pre-P1 in-process behavior.
        self._redis = redis
        self._redis_prefix = redis_prefix or "lightrag:"

    def _redis_key(self, kind: str, username: str) -> str:
        return f"{self._redis_prefix}rbac:{kind}:{username}"

    @property
    def enforce(self) -> bool:
        return self._enforce

    def set_enforce(self, enforce: bool) -> None:
        self._enforce = enforce

    # ── Internal DB access ────────────────────────────────────────────────

    async def _query_user(self, username: str) -> Optional[dict]:
        rows = await self._db.query(
            "SELECT username, password_hash, role, enabled "
            "FROM LIGHTRAG_USERS WHERE username = $1",
            [username],
            multirows=True,
        )
        if not rows:
            return None
        row = rows[0]
        return {
            "username": row["username"],
            "password_hash": row["password_hash"],
            "role": row["role"],
            "enabled": bool(row["enabled"]),
        }

    async def get_user(self, username: str) -> Optional[dict]:
        """Return the user row (cached ~30 s) or None."""
        now = time.monotonic()
        cached = self._users.get(username)
        if cached is not None and now - cached[0] < USER_TTL_SECONDS:
            return cached[1]
        user = None
        if self._redis is not None:
            user = await self._redis.get_json(
                self._redis_key("user", username)
            )
        if user is None:
            user = await self._query_user(username)
            if self._redis is not None and user is not None:
                await self._redis.set_json(
                    self._redis_key("user", username),
                    user,
                    int(USER_TTL_SECONDS),
                )
        self._users[username] = (now, user)
        return user

    async def _query_permissions(self, username: str) -> dict[str, str]:
        rows = await self._db.query(
            "SELECT workspace, access_level "
            "FROM LIGHTRAG_WORKSPACE_PERMISSIONS WHERE username = $1",
            [username],
            multirows=True,
        )
        return {row["workspace"]: row["access_level"] for row in (rows or [])}

    async def get_permissions(self, username: str) -> dict[str, str]:
        """Return {workspace: access_level} for the user (cached ~30 s)."""
        now = time.monotonic()
        cached = self._perms.get(username)
        if cached is not None and now - cached[0] < PERM_TTL_SECONDS:
            return cached[1]
        perms = None
        if self._redis is not None:
            perms = await self._redis.get_json(
                self._redis_key("perms", username)
            )
        if perms is None:
            perms = await self._query_permissions(username)
            if self._redis is not None:
                await self._redis.set_json(
                    self._redis_key("perms", username),
                    perms,
                    int(PERM_TTL_SECONDS),
                )
        self._perms[username] = (now, perms)
        return perms

    async def invalidate(self, username: Optional[str] = None) -> None:
        """Drop cache entries after a mutation. With no username, clears all."""
        if username is not None:
            self._users.pop(username, None)
            self._perms.pop(username, None)
            # Any user-set mutation changes the answer to has_any_user too.
            self._users.pop("__any__", None)
            if self._redis is not None:
                await self._redis.delete(self._redis_key("user", username))
                await self._redis.delete(self._redis_key("perms", username))
            return
        self._users.clear()
        self._perms.clear()

    # ── Seeding ───────────────────────────────────────────────────────────

    async def seed_if_empty(
        self,
        auth_accounts: str,
        init_admin_username: str = "",
        init_admin_password: str = "",
    ) -> bool:
        """Seed LIGHTRAG_USERS when empty. Idempotent, called once at startup.

        Returns True when a seed actually ran (so callers know the system moved
        from guest mode to enforced-auth-capable mode).
        """
        try:
            rows = await self._db.query(
                "SELECT 1 FROM LIGHTRAG_USERS LIMIT 1", multirows=True
            )
        except Exception as exc:
            logger.warning(f"RBAC: cannot inspect LIGHTRAG_USERS for seeding: {exc}")
            return False
        if rows:
            return False

        entries: List[Tuple[str, str]] = []
        if auth_accounts:
            for account in auth_accounts.split(","):
                try:
                    username, password = account.split(":", 1)
                    username = username.strip()
                    if not username or not password:
                        continue
                except ValueError:
                    continue
                entries.append((username, password))
        elif init_admin_username and init_admin_password:
            from lightrag.api.passwords import hash_password

            entries.append(
                (init_admin_username.strip(), hash_password(init_admin_password))
            )

        seeded = 0
        for username, password_hash in entries:
            try:
                await self._db.execute(
                    "INSERT INTO LIGHTRAG_USERS (username, password_hash, role) "
                    "VALUES ($1, $2, 'admin') ON CONFLICT (username) DO NOTHING",
                    {"username": username, "password_hash": password_hash},
                )
                await self._db.execute(
                    "INSERT INTO LIGHTRAG_WORKSPACE_PERMISSIONS "
                    "(username, workspace, access_level) VALUES ($1, '*', 'admin') "
                    "ON CONFLICT (username, workspace) DO NOTHING",
                    {"username": username},
                )
                seeded += 1
            except Exception as exc:  # pragma: no cover - best effort per row
                logger.warning(f"RBAC: failed to seed user {username}: {exc}")
        if seeded:
            logger.info(
                f"RBAC: seeded {seeded} initial user(s) from bootstrap configuration"
            )
            await self.invalidate()
        return seeded > 0

    # ── User CRUD (admin API) ────────────────────────────────────────────

    async def create_user(
        self, username: str, password_hash: str, role: str, enabled: bool = True
    ) -> None:
        if role not in VALID_ROLES:
            raise ValueError(f"Invalid role '{role}'. Expected one of admin/manager/viewer.")
        await self._db.execute(
            "INSERT INTO LIGHTRAG_USERS (username, password_hash, role, enabled) "
            "VALUES ($1, $2, $3, $4)",
            {
                "username": username,
                "password_hash": password_hash,
                "role": role,
                "enabled": enabled,
            },
        )
        await self.invalidate(username)

    async def update_user(
        self,
        username: str,
        password_hash: Optional[str] = None,
        role: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> None:
        if role is not None and role not in VALID_ROLES:
            raise ValueError(f"Invalid role '{role}'. Expected one of admin/manager/viewer.")
        if password_hash is not None:
            await self._db.execute(
                "UPDATE LIGHTRAG_USERS SET password_hash = $2, updated_at = now() "
                "WHERE username = $1",
                {"username": username, "password_hash": password_hash},
            )
        if role is not None:
            await self._db.execute(
                "UPDATE LIGHTRAG_USERS SET role = $2, updated_at = now() "
                "WHERE username = $1",
                {"username": username, "role": role},
            )
        if enabled is not None:
            await self._db.execute(
                "UPDATE LIGHTRAG_USERS SET enabled = $2, updated_at = now() "
                "WHERE username = $1",
                {"username": username, "enabled": enabled},
            )
        await self.invalidate(username)

    async def delete_user(self, username: str) -> None:
        await self._db.execute(
            "DELETE FROM LIGHTRAG_USERS WHERE username = $1",
            {"username": username},
        )
        await self.invalidate(username)

    async def list_users(self) -> List[dict]:
        rows = await self._db.query(
            "SELECT username, role, enabled, created_at, updated_at "
            "FROM LIGHTRAG_USERS ORDER BY username",
            multirows=True,
        )
        return [dict(r) for r in (rows or [])]

    async def has_any_user(self) -> bool:
        """True when LIGHTRAG_USERS holds at least one row (TTL-cached).

        Drives the ``auth_configured`` decision: a DB user created via the
        admin API turns authentication on even when ``AUTH_ACCOUNTS`` is empty.
        """
        now = time.monotonic()
        cached = self._users.get("__any__")
        if cached is not None and now - cached[0] < USER_TTL_SECONDS:
            return bool(cached[1]["present"])
        try:
            rows = await self._db.query(
                "SELECT 1 FROM LIGHTRAG_USERS LIMIT 1", multirows=True
            )
            any_user = bool(rows)
        except Exception as exc:  # pragma: no cover - PG down mid-flight
            logger.warning(f"RBAC: cannot check LIGHTRAG_USERS presence: {exc}")
            any_user = False
        self._users["__any__"] = (now, {"present": any_user})
        return any_user

    # ── Workspace permissions (admin API) ────────────────────────────────

    async def set_permission(
        self, username: str, workspace: str, access_level: str
    ) -> None:
        if access_level not in VALID_ACCESS_LEVELS:
            raise ValueError(
                f"Invalid access_level '{access_level}'. Expected read/write/admin."
            )
        await self._db.execute(
            "INSERT INTO LIGHTRAG_WORKSPACE_PERMISSIONS "
            "(username, workspace, access_level) VALUES ($1, $2, $3) "
            "ON CONFLICT (username, workspace) DO UPDATE SET "
            "access_level = EXCLUDED.access_level, updated_at = now()",
            {
                "username": username,
                "workspace": workspace,
                "access_level": access_level,
            },
        )
        await self.invalidate(username)

    async def delete_permission(self, username: str, workspace: str) -> None:
        await self._db.execute(
            "DELETE FROM LIGHTRAG_WORKSPACE_PERMISSIONS "
            "WHERE username = $1 AND workspace = $2",
            {"username": username, "workspace": workspace},
        )
        await self.invalidate(username)

    # ── Authorization ─────────────────────────────────────────────────────

    async def accessible_workspaces(self, username: str, role: str) -> List[dict]:
        """Workspaces the user may use, each with its access level.

        Admin returns the wildcard grant; everyone else returns their
        per-workspace rows.
        """
        if role == "admin":
            return [{"workspace": WILDCARD, "access_level": "admin"}]
        perms = await self.get_permissions(username)
        return [
            {"workspace": w, "access_level": lvl}
            for w, lvl in sorted(perms.items())
        ]

    async def check(self, account: dict, action_class: str, workspace: str) -> bool:
        """Authorize ``account`` (``{username, role}``) for ``action_class``
        (``read`` / ``write``) on ``workspace``.

        ``is_service_admin`` (X-API-Key callers) bypasses all checks. The role
        is re-read from the DB (TTL-cached) so a role change or a disabled
        account takes effect within the cache window without re-login; the
        JWT's role claim is the fallback while the cache is warm.
        """
        if not self._enforce:
            return True
        if account.get("is_service_admin"):
            return True
        username = account.get("username")
        if not username:
            return False
        user = await self.get_user(username)
        if user is None or not user["enabled"]:
            return False
        role = user["role"] or account.get("role")
        if role == "admin":
            return True
        if role not in ("manager", "viewer"):
            return False
        required = ACTION_LEVELS.get(action_class)
        if not required:
            return False
        perms = await self.get_permissions(username)
        level = perms.get(workspace) or perms.get(WILDCARD)
        return level in required


# Process-wide holder so the manager is created once and reused by all routers.
_rbac_manager: Optional[RBACManager] = None
_rbac_lock = asyncio.Lock()


async def get_rbac_manager(
    enforce: bool = False, args: Optional[Any] = None
) -> Optional[RBACManager]:
    """Return the process-wide RBAC manager backed by the shared PostgreSQL
    client, or None when PostgreSQL is unavailable (callers then degrade to
    auth-only behavior).

    ``enforce`` is only applied on first creation; later calls keep the initial
    setting (the server sets it once at startup). When ``args`` provides Redis
    configuration and Redis is reachable, the TTL caches are mirrored to Redis
    so role/permission changes are visible across workers within the TTL
    window; without Redis the in-process cache behavior is unchanged.
    """
    global _rbac_manager
    async with _rbac_lock:
        if _rbac_manager is not None:
            return _rbac_manager
        try:
            from lightrag.kg.postgres_impl import ClientManager

            db = await ClientManager.get_client(
                vector_storage=getattr(args, "vector_storage", None) if args else None
            )
        except Exception as exc:  # pragma: no cover - PG unavailable
            logger.warning(f"RBAC: PostgreSQL client unavailable, RBAC disabled: {exc}")
            return None
        redis = None
        prefix = "lightrag:"
        if args is not None:
            try:
                from lightrag.api.redis_client import get_redis_client

                redis = await get_redis_client(args)
                prefix = getattr(args, "redis_prefix", "lightrag:") or "lightrag:"
            except Exception as exc:  # pragma: no cover - Redis unavailable
                logger.debug(f"RBAC: Redis unavailable, in-process cache only: {exc}")
                redis = None
        _rbac_manager = RBACManager(db, enforce=enforce, redis=redis, redis_prefix=prefix)
        return _rbac_manager
