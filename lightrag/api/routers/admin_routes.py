"""
Admin user & workspace-permission management API (admin-only).

Routers:
- ``/admin/users`` and ``/admin/users/{username}/permissions`` — RBAC user and
  grant CRUD backed by :class:`lightrag.api.rbac.RBACManager`.
- ``/audit/logs`` — paged audit query backed by
  :class:`lightrag.api.audit.AuditLogger`.

The manager/logger are resolved per request (``app.state`` first, process-wide
manager fallback) so this router can be registered before the app lifespan
initializes them. Authorization: every route requires an admin identity — a
JWT with ``role=admin`` (a DB user) or the deployment ``X-API-Key`` (service
admin). In guest mode (no users configured) these routes refuse: bootstrapping
goes through ``AUTH_ACCOUNTS`` / ``INIT_ADMIN_*`` seeding, not through an open
admin API.
"""
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from lightrag.api.audit import AuditLogger
from lightrag.api.passwords import hash_password
from lightrag.api.rbac import RBACManager, get_rbac_manager
from lightrag.api.utils_api import (
    get_combined_auth_dependency,
    get_current_account,
)
from lightrag.utils import logger

# Username charset: letters, digits, underscore, dot, hyphen; the JWT "sub"
# bound (MAX_TOKEN_SUBJECT_LENGTH = 256) is enforced by auth.validate_token.
_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.\-]{1,64}$")
_VALID_ROLES = ("admin", "manager", "viewer")
_VALID_ACCESS_LEVELS = ("read", "write", "admin")


class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)
    role: str = Field("viewer", description="admin | manager | viewer")
    enabled: bool = True


class UserUpdateRequest(BaseModel):
    password: Optional[str] = Field(None, max_length=256)
    role: Optional[str] = None
    enabled: Optional[bool] = None


class PermissionSetRequest(BaseModel):
    access_level: str = Field(..., description="read | write | admin")


class AdminResponse(BaseModel):
    status: str = "success"
    message: str


def _validate_username(username: str) -> str:
    username = (username or "").strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail=(
                "Username must be 1-64 characters of letters, digits, "
                "underscore, dot or hyphen."
            ),
        )
    return username


def _validate_role(role: str) -> str:
    role = (role or "").strip().lower()
    if role not in _VALID_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid role '{role}'. Expected one of admin/manager/viewer.",
        )
    return role


def _validate_access_level(level: str) -> str:
    level = (level or "").strip().lower()
    if level not in _VALID_ACCESS_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid access_level '{level}'. Expected one of read/write/admin.",
        )
    return level


async def require_admin(account: dict | None = Depends(get_current_account)):
    """Admin-only gate: JWT role=admin, X-API-Key service admin, or guest mode.

    Guest mode (RBAC not enforced) keeps the fully-open single-tenant
    behaviour, so a guest identity is treated as admin for workspace lifecycle
    and user-management routes; once RBAC_ENFORCE=true a guest is refused.
    """
    if account is None:
        raise HTTPException(status_code=403, detail="Authentication required.")
    if account.get("is_service_admin") or account.get("role") == "admin":
        return account
    if account.get("role") == "guest":
        rbac = await get_rbac_manager()
        if rbac is None or not rbac.enforce:
            return account
    raise HTTPException(
        status_code=403, detail="Admin privileges required for this operation."
    )


async def _get_rbac(request: Request) -> RBACManager:
    """Per-request RBAC manager (app.state first, process-wide fallback)."""
    rbac = getattr(request.app.state, "rbac_manager", None)
    if rbac is not None:
        return rbac
    rbac = await get_rbac_manager()
    request.app.state.rbac_manager = rbac
    if rbac is None:
        raise HTTPException(status_code=503, detail="RBAC backend unavailable.")
    return rbac


async def _audit(
    request: Request,
    account: dict,
    action: str,
    *,
    resource_type: str,
    resource_id: Optional[str],
    detail: Optional[dict] = None,
) -> None:
    audit_logger: Optional[AuditLogger] = getattr(
        request.app.state, "audit_logger", None
    )
    if audit_logger is None or not audit_logger.enabled:
        return
    client = request.client
    await audit_logger.record(
        action=action,
        username=account.get("username"),
        role=account.get("role"),
        resource_type=resource_type,
        resource_id=resource_id,
        ip=client.host if client else None,
        user_agent=request.headers.get("user-agent"),
        detail=detail,
    )


def create_admin_routes(api_key: Optional[str] = None) -> APIRouter:
    router = APIRouter(tags=["admin"])
    auth = get_combined_auth_dependency(api_key)
    admin_auth = [Depends(auth), Depends(require_admin)]

    # ── Users ─────────────────────────────────────────────────────────────

    @router.get("/admin/users", dependencies=admin_auth)
    async def list_users(request: Request):
        rbac = await _get_rbac(request)
        return await rbac.list_users()

    @router.post(
        "/admin/users", response_model=AdminResponse, dependencies=admin_auth
    )
    async def create_user(
        req: UserCreateRequest,
        request: Request,
        account: dict = Depends(require_admin),
    ):
        rbac = await _get_rbac(request)
        username = _validate_username(req.username)
        role = _validate_role(req.role)
        if await rbac.get_user(username) is not None:
            raise HTTPException(
                status_code=409, detail=f"User '{username}' already exists."
            )
        try:
            await rbac.create_user(
                username, hash_password(req.password), role, enabled=req.enabled
            )
        except Exception as exc:
            logger.error(f"Admin: failed to create user {username}: {exc}")
            raise HTTPException(status_code=500, detail="Failed to create user.")
        await _audit(
            request,
            account,
            "user_manage",
            resource_type="user",
            resource_id=username,
            detail={"op": "create", "role": role, "enabled": req.enabled},
        )
        return AdminResponse(message=f"User '{username}' created.")

    @router.patch(
        "/admin/users/{username}",
        response_model=AdminResponse,
        dependencies=admin_auth,
    )
    async def update_user(
        username: str,
        req: UserUpdateRequest,
        request: Request,
        account: dict = Depends(require_admin),
    ):
        rbac = await _get_rbac(request)
        username = _validate_username(username)
        if await rbac.get_user(username) is None:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
        # Protect the last admin: never allow disabling your own admin account
        # or demoting it (locks the deployment out).
        if username == account.get("username"):
            if req.enabled is False or (req.role is not None and req.role != "admin"):
                raise HTTPException(
                    status_code=400,
                    detail="Cannot disable or demote your own admin account.",
                )
        await rbac.update_user(
            username,
            password_hash=hash_password(req.password) if req.password else None,
            role=_validate_role(req.role) if req.role else None,
            enabled=req.enabled,
        )
        await _audit(
            request,
            account,
            "user_manage",
            resource_type="user",
            resource_id=username,
            detail={"op": "update", "role": req.role, "enabled": req.enabled},
        )
        return AdminResponse(message=f"User '{username}' updated.")

    @router.delete(
        "/admin/users/{username}",
        response_model=AdminResponse,
        dependencies=admin_auth,
    )
    async def delete_user(
        username: str,
        request: Request,
        account: dict = Depends(require_admin),
    ):
        rbac = await _get_rbac(request)
        username = _validate_username(username)
        if username == account.get("username"):
            raise HTTPException(status_code=400, detail="Cannot delete your own account.")
        if await rbac.get_user(username) is None:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
        await rbac.delete_user(username)
        await _audit(
            request,
            account,
            "user_manage",
            resource_type="user",
            resource_id=username,
            detail={"op": "delete"},
        )
        return AdminResponse(message=f"User '{username}' deleted.")

    # ── Workspace permissions ─────────────────────────────────────────────

    @router.get("/admin/users/{username}/permissions", dependencies=admin_auth)
    async def list_permissions(username: str, request: Request):
        rbac = await _get_rbac(request)
        username = _validate_username(username)
        if await rbac.get_user(username) is None:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
        perms = await rbac.get_permissions(username)
        return [
            {"workspace": w, "access_level": lvl} for w, lvl in sorted(perms.items())
        ]

    @router.put(
        "/admin/users/{username}/permissions/{workspace}",
        response_model=AdminResponse,
        dependencies=admin_auth,
    )
    async def set_permission(
        username: str,
        workspace: str,
        req: PermissionSetRequest,
        request: Request,
        account: dict = Depends(require_admin),
    ):
        rbac = await _get_rbac(request)
        username = _validate_username(username)
        if await rbac.get_user(username) is None:
            raise HTTPException(status_code=404, detail=f"User '{username}' not found.")
        # 'default' maps to the default workspace ('') for API friendliness.
        if workspace == "default":
            workspace = ""
        if workspace == "*":
            raise HTTPException(
                status_code=400,
                detail="Use 'default' for the default-workspace grant; '*' is reserved.",
            )
        access_level = _validate_access_level(req.access_level)
        await rbac.set_permission(username, workspace, access_level)
        await _audit(
            request,
            account,
            "permission_manage",
            resource_type="workspace_permission",
            resource_id=f"{username}:{workspace or 'default'}",
            detail={"op": "set", "access_level": access_level},
        )
        return AdminResponse(
            message=(
                f"Permission for '{username}' on '{workspace or 'default'}' "
                f"set to {access_level}."
            )
        )

    @router.delete(
        "/admin/users/{username}/permissions/{workspace}",
        response_model=AdminResponse,
        dependencies=admin_auth,
    )
    async def delete_permission(
        username: str,
        workspace: str,
        request: Request,
        account: dict = Depends(require_admin),
    ):
        rbac = await _get_rbac(request)
        username = _validate_username(username)
        if workspace == "default":
            workspace = ""
        if workspace == "*":
            raise HTTPException(
                status_code=400, detail="Cannot revoke the wildcard grant through this route."
            )
        await rbac.delete_permission(username, workspace)
        await _audit(
            request,
            account,
            "permission_manage",
            resource_type="workspace_permission",
            resource_id=f"{username}:{workspace or 'default'}",
            detail={"op": "delete"},
        )
        return AdminResponse(
            message=(
                f"Permission revoked for '{username}' on '{workspace or 'default'}'."
            )
        )

    # ── Audit query ───────────────────────────────────────────────────────

    @router.get("/audit/logs", dependencies=admin_auth)
    async def query_audit_logs(
        request: Request,
        username: Optional[str] = Query(None, description="Filter by actor"),
        workspace: Optional[str] = Query(None, description="Filter by workspace"),
        action: Optional[str] = Query(None, description="Filter by action name"),
        status: Optional[str] = Query(None, description="Filter by status"),
        start: Optional[str] = Query(None, description="ISO timestamp (inclusive)"),
        end: Optional[str] = Query(None, description="ISO timestamp (inclusive)"),
        limit: int = Query(100, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ):
        audit_logger: Optional[AuditLogger] = getattr(
            request.app.state, "audit_logger", None
        )
        if audit_logger is None or not audit_logger.enabled:
            raise HTTPException(status_code=503, detail="Audit logging is disabled.")
        try:
            return await audit_logger.query_logs(
                username=username,
                workspace=workspace,
                action=action,
                status=status,
                start=start,
                end=end,
                limit=limit,
                offset=offset,
            )
        except Exception as exc:
            logger.error(f"Admin: audit query failed: {exc}")
            raise HTTPException(status_code=500, detail="Audit query failed.")

    return router
