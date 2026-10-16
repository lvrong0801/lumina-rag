"""RBACManager with a Redis cache layer: read-through on miss, mirror on hit,
and cross-worker invalidation via key deletion.

The in-process TTL cache is untouched; Redis only changes where a cache miss
reads from (and where invalidate writes to). A fake Redis doubles the real
client so tests never need a live server.
"""

import pytest

from lightrag.api.rbac import RBACManager


class _FakeRedis:
    def __init__(self):
        self.store: dict[str, object] = {}
        self.deleted: list[str] = []
        self.writes: list[tuple[str, object]] = []

    async def get_json(self, key: str):
        return self.store.get(key)

    async def set_json(self, key: str, value, ttl_seconds: int) -> bool:
        self.store[key] = value
        self.writes.append((key, ttl_seconds))
        return True

    async def delete(self, key: str) -> None:
        self.store.pop(key, None)
        self.deleted.append(key)


class _FakeUserDb:
    def __init__(self):
        self.users = {
            "alice": {
                "username": "alice", "password_hash": "h",
                "role": "admin", "enabled": True,
            }
        }
        self.perms = {"alice": {"docs": "write"}}
        self.user_queries = 0
        self.perm_queries = 0

    async def query(self, sql, params=None, multirows=False):
        if "FROM LIGHTRAG_USERS" in sql:
            self.user_queries += 1
            name = params[0]
            row = self.users.get(name)
            if row is None:
                return []
            return [row]
        if "FROM LIGHTRAG_WORKSPACE_PERMISSIONS" in sql:
            self.perm_queries += 1
            name = params[0]
            return [
                {"workspace": w, "access_level": lvl}
                for w, lvl in (self.perms.get(name) or {}).items()
            ]
        return []

    async def execute(self, sql, params=None):
        return None


@pytest.fixture
def fake_redis():
    return _FakeRedis()


@pytest.fixture
def rbac(fake_redis):
    return RBACManager(_FakeUserDb(), enforce=True, redis=fake_redis)


@pytest.mark.asyncio
async def test_reads_through_redis_on_miss_and_mirrors(rbac, fake_redis):
    # First read: no Redis value -> PG query -> mirror to Redis with TTL.
    user = await rbac.get_user("alice")
    assert user["role"] == "admin"
    assert fake_redis.writes
    redis_user = fake_redis.store["lightrag:rbac:user:alice"]
    assert redis_user["role"] == "admin"

    perms = await rbac.get_permissions("alice")
    assert perms == {"docs": "write"}
    assert fake_redis.store["lightrag:rbac:perms:alice"] == {"docs": "write"}


@pytest.mark.asyncio
async def test_redis_miss_does_not_mirror_absent_user(rbac, fake_redis):
    user = await rbac.get_user("nobody")
    assert user is None
    assert "lightrag:rbac:user:nobody" not in fake_redis.store


@pytest.mark.asyncio
async def test_redis_value_skips_pg_query(rbac, fake_redis):
    # Simulate another worker having written the cache: PG must not be hit.
    fake_redis.store["lightrag:rbac:user:alice"] = {
        "username": "alice", "password_hash": "h",
        "role": "viewer", "enabled": True,
    }
    user = await rbac.get_user("alice")
    assert user["role"] == "viewer"
    assert rbac._db.user_queries == 0


@pytest.mark.asyncio
async def test_invalidate_deletes_redis_keys(rbac, fake_redis):
    await rbac.get_user("alice")
    await rbac.get_permissions("alice")
    assert "lightrag:rbac:user:alice" in fake_redis.store

    await rbac.invalidate("alice")
    assert "lightrag:rbac:user:alice" not in fake_redis.store
    assert "lightrag:rbac:perms:alice" not in fake_redis.store
    assert "lightrag:rbac:user:alice" in fake_redis.deleted
    # Next read hits PG again (stale entry gone).
    assert (await rbac.get_user("alice"))["role"] == "admin"


@pytest.mark.asyncio
async def test_no_redis_keeps_in_process_behavior():
    rbac = RBACManager(_FakeUserDb(), enforce=True, redis=None)
    assert (await rbac.get_user("alice"))["role"] == "admin"
    await rbac.invalidate("alice")
    assert (await rbac.get_user("alice"))["role"] == "admin"
