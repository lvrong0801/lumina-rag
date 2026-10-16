"""
Cross-worker distributed locks for background operations.

Primary mechanism: PostgreSQL session-level advisory locks held on a dedicated
short-lived connection, so a worker that crashes releases the lock
automatically (connection close) and a second worker cannot enter the same
critical section. ``pg_try_advisory_lock`` is non-blocking: a lock already held
elsewhere is reported as "not acquired" immediately.

Degradation: when PostgreSQL is unavailable the lock falls back to a
process-local try-lock (synchronous, non-blocking). That is the correct scope
for the file-backed storages (NetworkX etc.), which cannot share writers across
processes anyway; the important property — "the scan is already running, skip"
— is preserved within the process.

Usage::

    lock = distributed_lock("scan", workspace)
    if not await lock.acquire():
        # another worker owns the critical section
        raise HTTPException(status_code=409, detail="...")
    try:
        ...
    finally:
        await lock.release()
"""
import asyncio
import logging
from typing import Any, Optional

from lightrag.utils import logger


class _LocalTryLock:
    """Non-blocking process-local lock (no awaits inside try_acquire)."""

    def __init__(self) -> None:
        self._locked = False

    def try_acquire(self) -> bool:
        if self._locked:
            return False
        self._locked = True
        return True

    def release(self) -> None:
        self._locked = False


# Process-wide registry so degraded locks are shared per key: two
# DistributedLock instances for the same key must contend on the same
# process-local lock, or in-process concurrency (uvicorn single worker,
# multiple tasks) would bypass the mutual exclusion entirely.
_local_locks: dict[str, _LocalTryLock] = {}
_local_locks_guard = asyncio.Lock()


async def _get_local_lock(key: str) -> _LocalTryLock:
    async with _local_locks_guard:
        lock = _local_locks.get(key)
        if lock is None:
            lock = _LocalTryLock()
            _local_locks[key] = lock
        return lock


class DistributedLock:
    """A named lock acquired across workers (PG advisory) or in-process."""

    def __init__(self, namespace: str, workspace: Optional[str] = None) -> None:
        self._key = f"lightrag:{namespace}:{workspace or ''}"
        self._conn: Optional[Any] = None
        self._local: Optional[_LocalTryLock] = None
        self._acquired = False

    @property
    def key(self) -> str:
        return self._key

    async def _try_pg_acquire(self) -> bool:
        import asyncpg

        from lightrag.kg.postgres_impl import ClientManager

        config = ClientManager.get_config()
        conn = await asyncpg.connect(
            host=config["host"],
            port=config["port"],
            user=config["user"],
            password=config["password"],
            database=config["database"],
            timeout=10,
        )
        try:
            acquired = await conn.fetchval(
                "SELECT pg_try_advisory_lock(hashtext($1)::bigint)", self._key
            )
        except Exception:
            await conn.close()
            raise
        if not acquired:
            await conn.close()
            return False
        self._conn = conn
        return True

    async def acquire(self) -> bool:
        """Try to acquire. True = this caller owns the lock and MUST release;
        False = held elsewhere (or unavailable), caller should skip/wait."""
        if self._acquired:
            return True
        try:
            if await self._try_pg_acquire():
                self._acquired = True
                return True
            return False
        except Exception as exc:
            logger.warning(
                f"Lock: PG advisory lock unavailable for '{self._key}', "
                f"falling back to process-local lock: {exc}"
            )
            local = await _get_local_lock(self._key)
            if local.try_acquire():
                self._local = local
                self._acquired = True
                return True
            return False

    async def release(self) -> None:
        if not self._acquired:
            return
        if self._conn is not None:
            conn = self._conn
            self._conn = None
            self._acquired = False
            try:
                await conn.execute(
                    "SELECT pg_advisory_unlock(hashtext($1)::bigint)", self._key
                )
            except Exception as exc:  # pragma: no cover - best effort
                logger.warning(
                    f"Lock: failed to unlock '{self._key}' (connection will drop "
                    f"it anyway): {exc}"
                )
            finally:
                await conn.close()
        elif self._local is not None:
            self._local.release()
            self._local = None
            self._acquired = False


def distributed_lock(namespace: str, workspace: Optional[str] = None) -> DistributedLock:
    return DistributedLock(namespace, workspace)
