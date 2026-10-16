"""
Operation audit trail — change operations only (per owner decision).

Every login, upload, deletion, graph edit, workspace lifecycle event and admin
user-management event is written to ``LIGHTRAG_AUDIT_LOG`` through the shared
PostgreSQL client. Read/query operations are intentionally not audited (their
volume would dwarf the trail).

Resilience contract: an audit write must never break the operation it records.
A failed insert is logged as a structured fallback line in the application log
and swallowed; callers do not await rollback or raise.
"""
import json
from typing import Any, Dict, List, Optional

from fastapi import Request

from lightrag.utils import logger
from .auth import auth_handler
from .utils_api import get_route_path

# Change-operation action names shared by the audit points and the query API.
ACTION_LOGIN = "login"
ACTION_LOGIN_FAILED = "login_failed"
ACTION_UPLOAD = "document_upload"
ACTION_DELETE_DOCUMENT = "document_delete"
ACTION_GRAPH_WRITE = "graph_write"
ACTION_WORKSPACE_CREATE = "workspace_create"
ACTION_WORKSPACE_DELETE = "workspace_delete"
ACTION_USER_MANAGE = "user_manage"
ACTION_PERMISSION_MANAGE = "permission_manage"


class AuditLogger:
    """PG-backed change-operation audit logger (best-effort by contract)."""

    def __init__(self, db: Any, enabled: bool = False):
        self._db = db
        self._enabled = enabled

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    async def record(
        self,
        *,
        action: str,
        status: str = "success",
        username: Optional[str] = None,
        role: Optional[str] = None,
        workspace: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        detail: Optional[Dict[str, Any]] = None,
        request_id: Optional[str] = None,
    ) -> None:
        """Append one audit row. Never raises into the caller."""
        if not self._enabled:
            return
        payload: Dict[str, Any] = {
            "username": username,
            "role": role,
            "workspace": workspace,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "ip": ip,
            "user_agent": user_agent,
            "status": status,
            "detail": detail,
            "request_id": request_id,
        }
        try:
            await self._db.execute(
                "INSERT INTO LIGHTRAG_AUDIT_LOG "
                "(username, role, workspace, action, resource_type, resource_id, "
                " ip, user_agent, status, detail, request_id) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
                {
                    "username": username,
                    "role": role,
                    "workspace": workspace,
                    "action": action,
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "ip": ip,
                    "user_agent": user_agent,
                    "status": status,
                    "detail": (
                        json.dumps(detail, ensure_ascii=False, default=str)
                        if detail is not None
                        else None
                    ),
                    "request_id": request_id,
                },
            )
        except Exception as exc:
            # Fallback trail + swallow: the audited operation keeps running.
            logger.warning(
                f"Audit: failed to write {action} record, logged as fallback: {exc} "
                f"payload={json.dumps(payload, ensure_ascii=False, default=str)}"
            )

    async def query_logs(
        self,
        *,
        username: Optional[str] = None,
        workspace: Optional[str] = None,
        action: Optional[str] = None,
        status: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[dict]:
        """Paged audit query (admin API). Filters are optional; ``start``/``end``
        are ISO timestamps passed through to PostgreSQL.
        """
        clauses: List[str] = []
        params: List[Any] = []
        if username is not None:
            params.append(username)
            clauses.append(f"username = ${len(params)}")
        if workspace is not None:
            params.append(workspace)
            clauses.append(f"workspace = ${len(params)}")
        if action is not None:
            params.append(action)
            clauses.append(f"action = ${len(params)}")
        if status is not None:
            params.append(status)
            clauses.append(f"status = ${len(params)}")
        if start is not None:
            params.append(start)
            clauses.append(f"ts >= ${len(params)}")
        if end is not None:
            params.append(end)
            clauses.append(f"ts <= ${len(params)}")
        where = "WHERE " + " AND ".join(clauses) if clauses else ""
        params.append(limit)
        params.append(offset)
        rows = await self._db.query(
            f"SELECT id, ts, username, role, workspace, action, resource_type, "
            f"resource_id, ip, user_agent, status, detail, request_id "
            f"FROM LIGHTRAG_AUDIT_LOG {where} "
            f"ORDER BY ts DESC LIMIT ${len(params) - 1} OFFSET ${len(params)}",
            params,
            multirows=True,
        )
        return [dict(r) for r in (rows or [])]


# Process-wide holder, created once by the server and exposed via
# ``request.app.state.audit_logger``.
_audit_logger: Optional[AuditLogger] = None


async def get_audit_logger(
    enabled: bool = False, args: Optional[Any] = None
) -> Optional[AuditLogger]:
    """Return the process-wide audit logger or None when PostgreSQL is
    unavailable (audit then degrades to auth-only, no trail)."""
    global _audit_logger
    if _audit_logger is not None:
        return _audit_logger
    try:
        from lightrag.kg.postgres_impl import ClientManager

        db = await ClientManager.get_client(
            vector_storage=getattr(args, "vector_storage", None) if args else None
        )
    except Exception as exc:  # pragma: no cover - PG unavailable
        logger.warning(f"Audit: PostgreSQL client unavailable, audit disabled: {exc}")
        return None
    _audit_logger = AuditLogger(db, enabled=enabled)
    return _audit_logger


# ── Audit middleware ─────────────────────────────────────────────────────────

class AuditMiddleware:
    """ASGI middleware that records change operations by route.

    Compared with per-endpoint hooks this keeps the audit points in one table,
    covers future routes with a single mapping edit, and cannot drift from the
    actual request lifecycle: identity comes from ``request.state.account``
    (set by the combined auth dependency), result status from the real
    response status code, and the event is written exactly once per matched
    request at response start.

    Only change operations are mapped (per the owner decision); read/query
    routes are never audited. Login is audited separately in the /login route
    because its body is a form consumed by the handler.
    """

    # (method, route pattern) -> (action, resource_type); a trailing ``*`` in
    # the pattern matches any remaining path segments.
    _ROUTES = {
        ("POST", "/documents/upload"): (ACTION_UPLOAD, "document"),
        ("POST", "/documents/text"): (ACTION_UPLOAD, "document"),
        ("POST", "/documents/texts"): (ACTION_UPLOAD, "document"),
        ("POST", "/documents/scan"): ("document_scan", "workspace"),
        ("DELETE", "/documents"): ("document_clear", "workspace"),
        ("DELETE", "/documents/delete_document"): (ACTION_DELETE_DOCUMENT, "document"),
        ("POST", "/documents/reprocess_failed"): ("document_reprocess", "workspace"),
        ("POST", "/documents/recovery/force_reset"): ("document_reprocess", "workspace"),
        ("POST", "/documents/cancel_pipeline"): ("pipeline_cancel", "workspace"),
        ("POST", "/documents/source_conflicts/repair"): ("document_repair", "workspace"),
        ("POST", "/graph/entity/create"): (ACTION_GRAPH_WRITE, "entity"),
        ("POST", "/graph/entity/edit"): (ACTION_GRAPH_WRITE, "entity"),
        ("POST", "/graph/relation/create"): (ACTION_GRAPH_WRITE, "relation"),
        ("POST", "/graph/relation/edit"): (ACTION_GRAPH_WRITE, "relation"),
        ("POST", "/graph/entities/merge"): (ACTION_GRAPH_WRITE, "entity"),
        ("DELETE", "/graph/entity/delete"): (ACTION_GRAPH_WRITE, "entity"),
        ("DELETE", "/graph/relation/delete"): (ACTION_GRAPH_WRITE, "relation"),
        ("POST", "/workspaces"): (ACTION_WORKSPACE_CREATE, "workspace"),
        ("DELETE", "/workspaces/*"): (ACTION_WORKSPACE_DELETE, "workspace"),
        ("POST", "/admin/users"): (ACTION_USER_MANAGE, "user"),
        ("PATCH", "/admin/users/*"): (ACTION_USER_MANAGE, "user"),
        ("DELETE", "/admin/users/*"): (ACTION_USER_MANAGE, "user"),
        ("PUT", "/admin/users/*/permissions/*"): (ACTION_PERMISSION_MANAGE, "permission"),
        ("DELETE", "/admin/users/*/permissions/*"): (ACTION_PERMISSION_MANAGE, "permission"),
    }

    def __init__(self, app: Any, audit_logger: Optional[AuditLogger], api_key: Optional[str] = None):
        self.app = app
        self.audit_logger = audit_logger
        self.api_key = api_key

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        # Resolve the logger at call time: the lifespan attaches it to
        # app.state after this middleware is constructed. ``self.app`` is the
        # NEXT middleware in the chain (e.g. CORSMiddleware), which has no
        # ``state``; the ASGI ``scope["app"]`` slot always points at the root
        # FastAPI application.
        audit_logger = self.audit_logger
        if audit_logger is None:
            root_app = scope.get("app")
            audit_logger = (
                getattr(getattr(root_app, "state", None), "audit_logger", None)
                if root_app is not None
                else None
            )
        if audit_logger is None or not audit_logger.enabled:
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        try:
            route = get_route_path(scope)
        except Exception:
            route = ""
        action, resource_type = self._match(scope["method"], route)
        if action is None:
            await self.app(scope, receive, send)
            return

        # Identity: prefer the dependency-attached account; fall back to a
        # direct token/API-key parse for robustness.
        account = getattr(request.state, "account", None)
        if account is None:
            account = self._resolve_account(request)
        username = (account or {}).get("username")
        role = (account or {}).get("role")

        async def send_wrapper(message: dict) -> None:
            if message["type"] == "http.response.start":
                status_code = message.get("status", 200)
                status = "success" if status_code < 400 else ("denied" if status_code in (401, 403) else "failed")
                client = request.client
                try:
                    # Use the closure logger (may come from app.state when the
                    # constructor arg was None); never self.audit_logger.
                    await audit_logger.record(
                        action=action,
                        status=status,
                        username=username,
                        role=role,
                        workspace=request.headers.get("LIGHTRAG-WORKSPACE", "") or None,
                        resource_type=resource_type,
                        resource_id=self._resource_id(route),
                        ip=client.host if client else None,
                        user_agent=request.headers.get("user-agent"),
                        detail={"method": scope["method"], "path": route},
                    )
                except Exception as exc:  # pragma: no cover - never break the response
                    logger.warning(f"Audit: middleware record failed: {exc}")
            await send(message)

        await self.app(scope, receive, send_wrapper)

    def _match(self, method: str, route: str) -> tuple:
        for (m, pattern), meta in self._ROUTES.items():
            if m != method:
                continue
            if "*" in pattern:
                prefix = pattern.split("*", 1)[0]
                if route == prefix.rstrip("/") or route.startswith(prefix):
                    return meta
            elif route == pattern:
                return meta
        return (None, None)

    def _resource_id(self, route: str) -> Optional[str]:
        if route.startswith("/workspaces/") and not route.endswith("/"):
            return route.rsplit("/", 1)[-1]
        if route.startswith("/admin/users/"):
            parts = route.split("/")
            # /admin/users/{username}[/permissions/{workspace}]
            if len(parts) >= 4:
                username = parts[3]
                if len(parts) >= 6 and parts[4] == "permissions":
                    return f"{username}:{parts[5]}"
                return username
        return None

    def _resolve_account(self, request: Request) -> Optional[dict]:
        auth_header = request.headers.get("authorization", "")
        if auth_header.startswith("Bearer "):
            try:
                info = auth_handler.validate_token(auth_header[7:])
            except Exception:
                info = None
            if info:
                return {"username": info.get("username"), "role": info.get("role")}
        if self.api_key and request.headers.get("X-API-Key") == self.api_key:
            return {"username": "__api_key__", "role": "admin", "is_service_admin": True}
        return None
