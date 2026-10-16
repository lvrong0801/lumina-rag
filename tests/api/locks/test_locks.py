"""DistributedLock tests.

Two paths:
- PG advisory path: asyncpg is swapped for a fake module (monkeypatched into
  sys.modules) so ``pg_try_advisory_lock`` results are controllable.
- Degradation path: when PostgreSQL is unavailable, ``acquire`` falls back to
  a process-local try-lock with the same non-blocking semantics.
"""
import sys

import pytest

from lightrag.api.locks import DistributedLock, distributed_lock


class FakeConn:
    def __init__(self, fetchval_result):
        self._result = fetchval_result
        self.closed = False
        self.executed: list[str] = []

    async def fetchval(self, sql, *args):
        return self._result

    async def execute(self, sql, *args):
        self.executed.append(sql)

    async def close(self):
        self.closed = True


class FakeAsyncpg:
    # postgres_impl module-level imports: `from asyncpg import Pool`,
    # ``asyncpg.Connection`` in annotations, and asyncpg.exceptions.* in its
    # retry tuple.
    Pool = object
    Connection = object

    class exceptions:
        InterfaceError = RuntimeError
        TooManyConnectionsError = RuntimeError
        CannotConnectNowError = RuntimeError
        PostgresConnectionError = RuntimeError
        ConnectionDoesNotExistError = RuntimeError
        ConnectionFailureError = RuntimeError
        UndefinedObjectError = RuntimeError
        InvalidParameterValueError = RuntimeError

    def __init__(self, result):
        self.result = result
        self.conns: list[FakeConn] = []

    async def connect(self, **kwargs):
        conn = FakeConn(self.result)
        self.conns.append(conn)
        return conn


@pytest.fixture
def fake_pg(monkeypatch):
    """Swap sys.modules['asyncpg'] for a copy of the real module with only
    ``connect`` overridden, so postgres_impl module-level imports (Pool,
    Connection, Record, exceptions) keep resolving."""
    import types

    import asyncpg as real_asyncpg

    def _install(result):
        fake = types.ModuleType("asyncpg")
        fake.__dict__.update(real_asyncpg.__dict__)
        holder = FakeAsyncpg(result)
        fake.conns = holder.conns
        fake.connect = holder.connect
        monkeypatch.setitem(sys.modules, "asyncpg", fake)
        return fake

    return _install


@pytest.fixture
def no_pg(monkeypatch):
    def _break_config():
        import types

        import asyncpg as real_asyncpg

        fake = types.ModuleType("asyncpg")
        fake.__dict__.update(real_asyncpg.__dict__)

        async def _boom(*args, **kwargs):
            raise RuntimeError("pg down")

        fake.connect = _boom
        monkeypatch.setitem(sys.modules, "asyncpg", fake)

        import lightrag.kg.postgres_impl as pg

        def boom():
            raise RuntimeError("no postgres")

        monkeypatch.setattr(pg.ClientManager, "get_config", boom)

    return _break_config


# ── PG advisory path ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_acquire_success_and_release(fake_pg):
    fake = fake_pg(True)
    lock = distributed_lock("scan", "docs")
    assert await lock.acquire() is True
    # Lock held on the dedicated connection.
    assert len(fake.conns) == 1
    assert fake.conns[0].closed is False
    await lock.release()
    assert fake.conns[0].executed[0].startswith("SELECT pg_advisory_unlock")
    assert fake.conns[0].closed is True
    assert lock._acquired is False


@pytest.mark.asyncio
async def test_acquire_conflict_closes_connection(fake_pg):
    fake = fake_pg(False)  # pg_try_advisory_lock returns False (held elsewhere)
    lock = distributed_lock("scan", "docs")
    assert await lock.acquire() is False
    assert lock._acquired is False
    assert len(fake.conns) == 1
    assert fake.conns[0].closed is True  # no lingering connection


@pytest.mark.asyncio
async def test_acquire_is_idempotent(fake_pg):
    fake = fake_pg(True)
    lock = distributed_lock("scan", "docs")
    assert await lock.acquire() is True
    assert await lock.acquire() is True  # already owned -> no second connection
    assert len(fake.conns) == 1
    await lock.release()


@pytest.mark.asyncio
async def test_key_includes_namespace_and_workspace(fake_pg):
    fake_pg(True)
    lock = distributed_lock("scan", "docs")
    assert lock.key == "lightrag:scan:docs"


# ── Degradation path ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_degrades_to_process_local_lock(no_pg):
    no_pg()
    lock = distributed_lock("scan", "docs")
    assert await lock.acquire() is True
    # A second lock on the same key cannot be acquired while held.
    other = distributed_lock("scan", "docs")
    assert await other.acquire() is False
    await lock.release()
    # Released -> the other caller may now take it.
    assert await other.acquire() is True
    await other.release()


@pytest.mark.asyncio
async def test_release_without_acquire_is_noop():
    lock = distributed_lock("scan", "docs")
    await lock.release()
    assert lock._acquired is False
