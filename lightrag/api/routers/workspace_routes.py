"""
Workspace REST routes.

GET    /workspaces          -> list workspaces visible to the caller
POST   /workspaces          -> create a workspace (admin)
DELETE /workspaces/{name}   -> delete a workspace (admin, lock-guarded)

Authorization (RBAC_ENFORCE): ``list`` returns only the workspaces the caller
may use (admins and X-API-Key service callers see all); ``create``/``delete``
require an admin identity. ``delete`` additionally takes a distributed lock on
``workspace_mgmt:<name>`` so two workers cannot race the same physical removal.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from lightrag.utils import canonical_workspace_name, logger
from lightrag.api.locks import distributed_lock
from lightrag.api.utils_api import (
    get_combined_auth_dependency,
    get_current_account,
)
from lightrag.api.audit import AuditLogger
from lightrag.api.rbac import WILDCARD, RBACManager, get_rbac_manager
from lightrag.api.workspace_manager import WorkspaceManager
from lightrag.api.workspace_meta import get_workspace_meta_manager
from lightrag.api.routers.admin_routes import require_admin


class WorkspaceInfo(BaseModel):
    name: str
    is_default: bool
    access_level: str = "admin"  # read | write | admin (admin grants default)
    owner: Optional[str] = None
    description: str = ""
    status: str = "active"  # active | archived


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    description: str = Field(default="", max_length=500)


class UpdateWorkspaceRequest(BaseModel):
    description: Optional[str] = Field(default=None, max_length=500)
    status: Optional[str] = Field(default=None, pattern="^(active|archived)$")


class WorkspaceResponse(BaseModel):
    status: str
    message: str


def _validate_name(name: str) -> str:
    """Validate a workspace name supplied over the API.

    Accepts any single path component (letters, digits, dots, underscores,
    hyphens, ...) and rejects separators and relative-path references, matching
    the core :func:`lightrag.utils.validate_workspace` used by storage and
    ``DocumentManager``. The DELETE path parameter is validated here as well,
    which is what closes the path-traversal hole in the old implementation.

    Returns the canonical (backend-safe) workspace name — hyphens converted
    to underscores — so downstream namespaces match what storage keys will
    use.
    """
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name must not be empty.")
    if len(name) > 50:
        raise HTTPException(
            status_code=400, detail="Workspace name is too long (max 50 characters)."
        )
    try:
        return canonical_workspace_name(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def create_workspace_routes(
    workspace_manager: WorkspaceManager,
    api_key: Optional[str] = None,
) -> APIRouter:
    router = APIRouter(prefix="/workspaces", tags=["workspaces"])
    auth = get_combined_auth_dependency(api_key)
    admin_auth = [Depends(auth), Depends(require_admin)]

    async def _audit(
        action: str,
        account: dict,
        request: Request,
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
            workspace=resource_id if resource_type == "workspace" else None,
            resource_type=resource_type,
            resource_id=resource_id,
            ip=client.host if client else None,
            user_agent=request.headers.get("user-agent"),
            detail=detail,
        )

    @router.get("", response_model=List[WorkspaceInfo], dependencies=[Depends(auth)])
    async def list_workspaces(account: dict | None = Depends(get_current_account)):
        """List workspaces visible to the caller.

        With RBAC enforced, non-admin callers see only their granted
        workspaces (each with its access_level); admins and service callers
        see everything. Metadata (owner/description/status) is merged from
        ``LIGHTRAG_WORKSPACES`` when available; non-admin callers do not see
        the owner.
        """
        names = await workspace_manager.list_workspaces()
        default = workspace_manager.default_workspace

        meta = await get_workspace_meta_manager()
        meta_by_name: dict = {}
        if meta is not None:
            try:
                meta_by_name = {m["name"]: m for m in await meta.list_all()}
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(f"Workspaces: metadata listing failed: {exc}")

        account = account or {}
        rbac = await get_rbac_manager()
        is_admin = bool(account.get("is_service_admin")) or account.get("role") == "admin"
        if rbac is not None and rbac.enforce:
            if is_admin:
                return [
                    WorkspaceInfo(
                        name=n,
                        is_default=(n == default),
                        owner=(meta_by_name.get(n) or {}).get("owner"),
                        description=(meta_by_name.get(n) or {}).get("description", ""),
                        status=(meta_by_name.get(n) or {}).get("status", "active"),
                    )
                    for n in names
                ]
            # Non-admin: filter to granted workspaces, wildcard grant included.
            perms = await rbac.get_permissions(account.get("username") or "")
            granted = set(perms.keys())
            visible = [n for n in names if n in granted or WILDCARD in granted]
            result = []
            for n in visible:
                level = (
                    perms.get(n)
                    or perms.get(WILDCARD)
                    or "read"
                )
                result.append(
                    WorkspaceInfo(
                        name=n,
                        is_default=(n == default),
                        access_level=level,
                        description=(meta_by_name.get(n) or {}).get("description", ""),
                        status=(meta_by_name.get(n) or {}).get("status", "active"),
                    )
                )
            return result
        return [
            WorkspaceInfo(
                name=n,
                is_default=(n == default),
                owner=(meta_by_name.get(n) or {}).get("owner"),
                description=(meta_by_name.get(n) or {}).get("description", ""),
                status=(meta_by_name.get(n) or {}).get("status", "active"),
            )
            for n in names
        ]

    @router.post("", response_model=WorkspaceResponse, dependencies=admin_auth)
    async def create_workspace(req: CreateWorkspaceRequest, request: Request,
                               account: dict = Depends(require_admin)):
        """Create a new named workspace (admin)."""
        name = _validate_name(req.name)
        if name == workspace_manager.default_workspace:
            raise HTTPException(
                status_code=400,
                detail="Workspace name conflicts with the default workspace.",
            )
        try:
            await workspace_manager.get_instance(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        # Record persistent metadata (owner = creating admin). Best effort:
        # the workspace directory already exists; a missing metadata row only
        # degrades list display and the archive gate.
        meta = await get_workspace_meta_manager()
        if meta is not None:
            try:
                await meta.create(
                    name,
                    owner=account.get("username"),
                    description=req.description,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(f"Workspaces: metadata write failed for '{name}': {exc}")
        await _audit(
            "workspace_create",
            account,
            request,
            resource_type="workspace",
            resource_id=name,
            detail={"description": req.description},
        )
        return WorkspaceResponse(
            status="success",
            message=f"Workspace '{name}' created successfully.",
        )

    @router.patch(
        "/{name}", response_model=WorkspaceResponse, dependencies=admin_auth
    )
    async def update_workspace(name: str, req: UpdateWorkspaceRequest,
                               request: Request, account: dict = Depends(require_admin)):
        """Update workspace metadata: description and/or archive status (admin)."""
        name = _validate_name(name)
        meta = await get_workspace_meta_manager()
        if meta is None:
            raise HTTPException(
                status_code=503,
                detail="Workspace metadata unavailable (PostgreSQL required).",
            )
        try:
            await meta.update(
                name,
                description=req.description,
                status=req.status,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        await _audit(
            "workspace_update",
            account,
            request,
            resource_type="workspace",
            resource_id=name,
            detail={"description": req.description, "status": req.status},
        )
        return WorkspaceResponse(
            status="success",
            message=f"Workspace '{name}' updated successfully.",
        )

    @router.delete("/{name}", response_model=WorkspaceResponse, dependencies=admin_auth)
    async def delete_workspace(name: str, request: Request,
                               account: dict = Depends(require_admin)):
        """Delete a named workspace and all its data (admin).

        Lock-guarded across workers: a concurrent delete of the same workspace
        returns 409 instead of racing the physical removal.
        """
        name = _validate_name(name)
        if name == workspace_manager.default_workspace:
            raise HTTPException(status_code=400, detail="Cannot delete the default workspace.")
        lock = distributed_lock("workspace_mgmt", name)
        if not await lock.acquire():
            raise HTTPException(
                status_code=409,
                detail=f"Another operation is managing workspace '{name}'. Try again later.",
            )
        try:
            await workspace_manager.delete_workspace(name)
            # Drop the metadata row only after the physical removal succeeded,
            # so a failed directory delete leaves the row for retry.
            meta = await get_workspace_meta_manager()
            if meta is not None:
                try:
                    await meta.delete(name)
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning(f"Workspaces: metadata delete failed for '{name}': {exc}")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        finally:
            await lock.release()
        await _audit(
            "workspace_delete",
            account,
            request,
            resource_type="workspace",
            resource_id=name,
        )
        return WorkspaceResponse(
            status="success",
            message=f"Workspace '{name}' deleted successfully.",
        )

    return router
