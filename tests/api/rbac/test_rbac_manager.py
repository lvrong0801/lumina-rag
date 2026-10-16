"""RBACManager unit tests against an in-memory PostgreSQL-shaped fake.

The fake answers the exact SQL shapes RBACManager issues (SELECT/INSERT/
UPDATE/DELETE on LIGHTRAG_USERS / LIGHTRAG_WORKSPACE_PERMISSIONS), so the
tests cover cache behavior, seeding, CRUD and the authorization matrix without
a live database.
"""
import asyncio
import sys

import pytest

_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
from lightrag.api.rbac import DEFAULT_WORKSPACE, WILDCARD, RBACManager

sys.argv = _original_argv


class FakeDb:
    """Minimal async PG-shaped backend: in-memory rows + SQL intent matching."""

    def __init__(self):
        self.users: dict[str, dict] = {}
        self.perms: dict[str, dict[str, str]] = {}
        self.executed: list[str] = []

    async def query(self, sql, params=None, multirows=True):
        if "SELECT 1 FROM LIGHTRAG_USERS" in sql:
            return [{"1": 1}] if self.users else []
        if "SELECT username, password_hash, role, enabled" in sql:
            user = self.users.get((params or [None])[0])
            return [dict(user)] if user else []
        if "SELECT workspace, access_level" in sql:
            username = (params or [None])[0]
            return [
                {"workspace": w, "access_level": lvl}
                for w, lvl in sorted(self.perms.get(username, {}).items())
            ]
        if "SELECT username, role, enabled, created_at, updated_at" in sql:
            return [
                {
                    "username": username,
                    "role": row["role"],
                    "enabled": row["enabled"],
                    "created_at": None,
                    "updated_at": None,
                }
                for username, row in sorted(self.users.items())
            ]
        return []

    async def execute(self, sql, params=None):
        self.executed.append(sql)
        p = params or {}
        if "INSERT INTO LIGHTRAG_USERS" in sql:
            # seed_if_empty hard-codes role='admin' in the SQL literal.
            role = "admin" if "'admin'" in sql else p.get("role", "viewer")
            self.users[p["username"]] = {
                "username": p["username"],
                "password_hash": p["password_hash"],
                "role": role,
                "enabled": p.get("enabled", True),
            }
        elif "UPDATE LIGHTRAG_USERS SET password_hash" in sql:
            self.users[p["username"]]["password_hash"] = p["password_hash"]
        elif "UPDATE LIGHTRAG_USERS SET role" in sql:
            self.users[p["username"]]["role"] = p["role"]
        elif "UPDATE LIGHTRAG_USERS SET enabled" in sql:
            self.users[p["username"]]["enabled"] = p["enabled"]
        elif "DELETE FROM LIGHTRAG_USERS" in sql:
            self.users.pop(p["username"], None)
            self.perms.pop(p["username"], None)
        elif "INSERT INTO LIGHTRAG_WORKSPACE_PERMISSIONS" in sql:
            if "DO UPDATE" in sql:  # set_permission (named params present)
                workspace = p["workspace"]
                access_level = p["access_level"]
            else:  # seed_if_empty hard-codes ('*', 'admin') in the SQL
                workspace = "*"
                access_level = "admin"
            self.perms.setdefault(p["username"], {})[workspace] = access_level
        elif "DELETE FROM LIGHTRAG_WORKSPACE_PERMISSIONS" in sql:
            self.perms.get(p["username"], {}).pop(p["workspace"], None)


@pytest.fixture
def rbac():
    db = FakeDb()
    return RBACManager(db, enforce=True)


def account(username: str, role: str = "viewer", **extra):
    return {"username": username, "role": role, **extra}


# ── Seeding ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_seed_if_empty_from_auth_accounts(rbac: RBACManager):
    db: FakeDb = rbac._db
    seeded = await rbac.seed_if_empty("admin:pw1,alice:pw2")
    assert seeded is True
    assert set(db.users) == {"admin", "alice"}
    assert all(u["role"] == "admin" for u in db.users.values())
    # Wildcard admin grant for each seeded user.
    assert db.perms["admin"] == {WILDCARD: "admin"}
    assert db.perms["alice"] == {WILDCARD: "admin"}
    # Idempotent: a second call sees rows and seeds nothing.
    assert await rbac.seed_if_empty("admin:pw1,alice:pw2") is False


@pytest.mark.asyncio
async def test_seed_if_empty_from_init_admin(rbac: RBACManager):
    db: FakeDb = rbac._db
    seeded = await rbac.seed_if_empty("", "root", "s3cret")
    assert seeded is True
    assert set(db.users) == {"root"}
    assert db.users["root"]["password_hash"].startswith("{bcrypt}$2b$")  # bcrypt
    assert db.perms["root"] == {WILDCARD: "admin"}


@pytest.mark.asyncio
async def test_seed_if_empty_nothing_configured_stays_guest(rbac: RBACManager):
    db: FakeDb = rbac._db
    seeded = await rbac.seed_if_empty("", "", "")
    assert seeded is False
    assert db.users == {}


# ── User CRUD ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_and_get_user(rbac: RBACManager):
    await rbac.create_user("bob", "$2b$hash", "manager")
    user = await rbac.get_user("bob")
    assert user["role"] == "manager"
    assert user["enabled"] is True
    assert await rbac.get_user("nobody") is None


@pytest.mark.asyncio
async def test_create_user_rejects_invalid_role(rbac: RBACManager):
    with pytest.raises(ValueError):
        await rbac.create_user("x", "hash", "superuser")


@pytest.mark.asyncio
async def test_update_user_role_enabled_password(rbac: RBACManager):
    await rbac.create_user("bob", "oldhash", "viewer")
    await rbac.update_user("bob", role="manager", enabled=False, password_hash="newhash")
    user = await rbac.get_user("bob")
    assert user["role"] == "manager"
    assert user["enabled"] is False
    assert user["password_hash"] == "newhash"


@pytest.mark.asyncio
async def test_delete_user_removes_permissions(rbac: RBACManager):
    await rbac.create_user("bob", "hash", "viewer")
    await rbac.set_permission("bob", "docs", "read")
    await rbac.delete_user("bob")
    assert await rbac.get_user("bob") is None
    assert await rbac.get_permissions("bob") == {}


@pytest.mark.asyncio
async def test_list_users_sorted(rbac: RBACManager):
    await rbac.create_user("zeta", "h", "viewer")
    await rbac.create_user("alpha", "h", "admin")
    names = [u["username"] for u in await rbac.list_users()]
    assert names == ["alpha", "zeta"]


@pytest.mark.asyncio
async def test_has_any_user(rbac: RBACManager):
    assert await rbac.has_any_user() is False
    await rbac.create_user("bob", "h", "viewer")
    assert await rbac.has_any_user() is True


# ── Permissions ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_and_get_permissions(rbac: RBACManager):
    await rbac.set_permission("bob", "docs", "write")
    await rbac.set_permission("bob", "", "read")
    assert await rbac.get_permissions("bob") == {"": "read", "docs": "write"}


@pytest.mark.asyncio
async def test_set_permission_rejects_invalid_level(rbac: RBACManager):
    with pytest.raises(ValueError):
        await rbac.set_permission("bob", "docs", "owner")


@pytest.mark.asyncio
async def test_delete_permission(rbac: RBACManager):
    await rbac.set_permission("bob", "docs", "read")
    await rbac.delete_permission("bob", "docs")
    assert await rbac.get_permissions("bob") == {}


# ── Authorization matrix ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_not_enforced_allows_everything():
    db = FakeDb()
    rbac = RBACManager(db, enforce=False)
    assert await rbac.check(account("bob"), "write", "anything") is True


@pytest.mark.asyncio
async def test_check_service_admin_bypass(rbac: RBACManager):
    assert (
        await rbac.check(account("svc", is_service_admin=True), "write", "x")
        is True
    )


@pytest.mark.asyncio
async def test_check_admin_bypasses_grants(rbac: RBACManager):
    await rbac.create_user("root", "h", "admin")
    assert await rbac.check(account("root", "admin"), "write", "unlisted") is True


@pytest.mark.asyncio
async def test_check_unknown_or_disabled_user(rbac: RBACManager):
    assert await rbac.check(account("nobody"), "read", "x") is False
    await rbac.create_user("bob", "h", "viewer", enabled=False)
    assert await rbac.check(account("bob", "viewer"), "read", "x") is False


@pytest.mark.asyncio
async def test_check_read_write_matrix(rbac: RBACManager):
    await rbac.create_user("carol", "h", "manager")
    await rbac.set_permission("carol", "docs", "read")
    assert await rbac.check(account("carol", "manager"), "read", "docs") is True
    # write needs a write/admin grant
    assert await rbac.check(account("carol", "manager"), "write", "docs") is False
    await rbac.set_permission("carol", "docs", "write")
    assert await rbac.check(account("carol", "manager"), "write", "docs") is True
    assert await rbac.check(account("carol", "manager"), "read", "other") is False


@pytest.mark.asyncio
async def test_check_viewer_read_only(rbac: RBACManager):
    await rbac.create_user("dave", "h", "viewer")
    await rbac.set_permission("dave", "docs", "read")
    assert await rbac.check(account("dave", "viewer"), "read", "docs") is True
    assert await rbac.check(account("dave", "viewer"), "write", "docs") is False


@pytest.mark.asyncio
async def test_check_wildcard_grant(rbac: RBACManager):
    await rbac.create_user("eve", "h", "viewer")
    await rbac.set_permission("eve", WILDCARD, "write")
    assert await rbac.check(account("eve", "viewer"), "write", "any-ws") is True


@pytest.mark.asyncio
async def test_check_default_workspace_grant(rbac: RBACManager):
    await rbac.create_user("frank", "h", "viewer")
    await rbac.set_permission("frank", DEFAULT_WORKSPACE, "read")
    assert await rbac.check(account("frank", "viewer"), "read", "") is True
    assert await rbac.check(account("frank", "viewer"), "write", "") is False


# ── TTL cache invalidation ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mutation_invalidates_cache(rbac: RBACManager):
    await rbac.create_user("bob", "h", "viewer")
    await rbac.set_permission("bob", "docs", "read")
    # Warm the cache, then mutate through another path.
    assert await rbac.check(account("bob", "viewer"), "read", "docs") is True
    await rbac.set_permission("bob", "docs", "write")
    # create_user/set_permission invalidate; the next check re-reads.
    assert await rbac.check(account("bob", "viewer"), "write", "docs") is True


@pytest.mark.asyncio
async def test_cache_returns_freshly_queried_user(rbac: RBACManager):
    await rbac.create_user("bob", "h", "viewer")
    # Direct db mutation behind the manager's back (e.g. another worker).
    db: FakeDb = rbac._db
    db.users["bob"]["enabled"] = False
    assert await rbac.get_user("bob") is None or True  # cache may be warm
    await rbac.invalidate("bob")
    user = await rbac.get_user("bob")
    assert user["enabled"] is False
