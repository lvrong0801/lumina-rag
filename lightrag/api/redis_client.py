"""
Lightweight Redis client for the stateless API coordination layer.

Used for: cross-worker RBAC cache invalidation, pipeline-status mirroring and
short-TTL reference caches. Every accessor degrades to ``None``/no-op when
Redis is unreachable, so the server never depends on Redis for correctness —
the in-process fallbacks (TTL caches, PG-backed state) are the same behavior
the pre-P1 code had.

Configuration comes from the server args (``REDIS_URL`` / granular
``REDIS_HOST`` / ``REDIS_PORT`` / ``REDIS_DB`` / ``REDIS_PASSWORD`` /
``REDIS_PREFIX``). All keys are namespaced under the prefix.
"""
import asyncio
import json
import re
from typing import Any, Optional

from lightrag.utils import logger

# Strips the userinfo (user:password@) from a URL before logging, so a Redis
# password never leaks into application logs on a connect failure.
_REDIS_URL_CRED_RE = re.compile(r"://[^@/]*@")


class RedisClient:
    """Thin wrapper around ``redis.asyncio`` with JSON helpers."""

    def __init__(self, url: str, prefix: str) -> None:
        try:
            from redis.asyncio import Redis
        except ImportError:  # pragma: no cover - redis not installed
            raise RuntimeError("redis package is not installed")

        self._prefix = prefix or "lightrag:"
        self._redis: Optional[Redis] = None
        self._url = url

    def _key(self, key: str) -> str:
        return f"{self._prefix}{key}"

    async def connect(self) -> bool:
        """Establish the connection; returns True when usable."""
        if self._redis is not None:
            try:
                return bool(await self._redis.ping())
            except Exception:
                return False
        try:
            from redis.asyncio import Redis

            self._redis = Redis.from_url(
                self._url, decode_responses=True, socket_connect_timeout=3
            )
            ok = bool(await self._redis.ping())
            if not ok:
                self._redis = None
            return ok
        except Exception as exc:
            logger.warning(
                f"Redis: unavailable at '{_REDIS_URL_CRED_RE.sub('://', self._url)}': {exc}"
            )
            self._redis = None
            return False

    async def close(self) -> None:
        if self._redis is not None:
            try:
                await self._redis.aclose()
            except Exception:  # pragma: no cover - best effort
                pass
            self._redis = None

    async def get_json(self, key: str) -> Optional[Any]:
        if self._redis is None:
            return None
        try:
            raw = await self._redis.get(self._key(key))
            if raw is None:
                return None
            return json.loads(raw)
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug(f"Redis: get_json failed for '{key}': {exc}")
            return None

    async def set_json(self, key: str, value: Any, ttl_seconds: int) -> bool:
        if self._redis is None:
            return False
        try:
            await self._redis.set(
                self._key(key), json.dumps(value), ex=ttl_seconds
            )
            return True
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug(f"Redis: set_json failed for '{key}': {exc}")
            return False

    async def delete(self, key: str) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.delete(self._key(key))
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug(f"Redis: delete failed for '{key}': {exc}")

    async def publish(self, channel: str, message: Any) -> None:
        if self._redis is None:
            return
        try:
            await self._redis.publish(self._key(channel), json.dumps(message))
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug(f"Redis: publish failed for '{channel}': {exc}")


# Process-wide holder: one client, lazily connected.
_client: Optional[RedisClient] = None
_client_lock = asyncio.Lock()
_client_config: Optional[dict] = None


async def get_redis_client(args: Optional[Any] = None) -> Optional[RedisClient]:
    """Return the process-wide Redis client (connected) or None when Redis is
    unavailable. ``args`` supplies the config on first creation only."""
    global _client, _client_config
    async with _client_lock:
        if args is not None:
            if _client_config is None:
                url = (
                    getattr(args, "redis_url", "") or ""
                ) or _url_from_args(args)
                _client_config = {
                    "url": url,
                    "prefix": getattr(args, "redis_prefix", "lightrag:") or "lightrag:",
                }
            else:
                # Already configured: ignore a second args (server args are
                # process-global and identical across routers).
                pass
        if _client_config is None:
            # No args ever supplied: default to localhost (tests may inject).
            _client_config = {
                "url": "redis://localhost:6379/0",
                "prefix": "lightrag:",
            }
        if _client is None:
            _client = RedisClient(
                _client_config["url"], _client_config["prefix"]
            )
        if await _client.connect():
            return _client
        return None


def _url_from_args(args: Any) -> str:
    host = getattr(args, "redis_host", "localhost") or "localhost"
    port = int(getattr(args, "redis_port", 6379) or 6379)
    db = int(getattr(args, "redis_db", 0) or 0)
    password = getattr(args, "redis_password", "") or ""
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"


async def invalidate_cache_keys(*keys: str) -> None:
    """Best-effort cache invalidation across workers (no-op without Redis)."""
    client = await get_redis_client()
    if client is None:
        return
    for key in keys:
        await client.delete(key)
