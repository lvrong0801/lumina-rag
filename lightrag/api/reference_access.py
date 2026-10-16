"""
Reference-level access filtering for query responses.

Filters the ``references`` / ``chunks`` lists produced by RAG queries before
they reach the client, enforcing two rules (in addition to the workspace-level
authorization already performed by the routing layer):

1. **Soft-deleted documents are never cited.** A DELETED doc_status row no
   longer resolves through ``get_doc_by_file_basename`` (which skips
   ``deleted`` rows), so its references disappear immediately after the soft
   delete and come back after a restore.

2. **Owner-isolated documents are visible only to their owner, role=admin
   users, and workspace admins** (a grant with ``access_level='admin'`` on the
   workspace, or the ``'*'`` wildcard). A document becomes owner-isolated when
   it is uploaded with an authenticated account: the username is recorded as
   ``metadata.owner`` on the doc_status row. Documents without an owner
   (scan-discovered files, SDK inserts) are shared and inherit the workspace
   grants.

The filter is active only when ``RBAC_ENFORCE=true`` (the RBAC manager's
``enforce`` flag); otherwise references pass through untouched, preserving
legacy single-tenant behaviour.

Reference ids are renumbered to a contiguous ``1..N`` sequence after filtering
so clients never see gaps, and chunk ``reference_id`` values are aligned with
the renumbered reference list.
"""
import os
from typing import Any, Optional

from lightrag.utils import logger

WILDCARD = "*"


async def _resolve_doc_by_path(
    rag: Any, file_path: str, cache: dict[str, Any]
) -> Optional[tuple[str, dict[str, Any]]]:
    """Memoized doc_status lookup by canonical basename.

    One query-time cache shared across the references and chunks passes; no
    cross-query caching, so a soft-delete or restore is visible on the very
    next query.
    """
    if not file_path:
        return None
    basename = os.path.basename(file_path.replace("\\", "/"))
    if not basename:
        return None
    if basename not in cache:
        try:
            cache[basename] = await rag.doc_status.get_doc_by_file_basename(
                basename
            )
        except Exception as e:  # fail-open: an unreadable store never 500s a query
            logger.warning(
                f"reference filter: doc_status lookup failed for "
                f"'{basename}': {e}"
            )
            cache[basename] = None
    return cache[basename]


def _can_view_private(
    account: dict[str, Any],
    perms: dict[str, str],
    workspace: str,
    owner: str,
) -> bool:
    """Whether ``account`` may cite an owner-isolated document."""
    if account.get("is_service_admin"):
        return True
    if account.get("role") == "admin":
        return True
    if account.get("username") and owner == account.get("username"):
        return True
    # Workspace-admin grant (access_level 'admin') on the workspace or the
    # wildcard sees every owner-isolated document in this workspace.
    return perms.get(workspace) == "admin" or perms.get(WILDCARD) == "admin"


async def filter_references_and_chunks(
    references: Optional[list[dict[str, Any]]],
    chunks: Optional[list[dict[str, Any]]],
    *,
    rag: Any,
    account: Optional[dict[str, Any]],
    workspace: str,
    rbac_manager: Optional[Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Filter references/chunks by document access; renumber ids.

    ``rbac_manager`` is the process-wide RBAC manager (``None`` when
    PostgreSQL is unavailable). When it is absent or ``enforce`` is False the
    lists are returned untouched.
    """
    refs = references or []
    if not refs:
        return refs, chunks or []

    # Soft-delete exclusion is UNCONDITIONAL: a soft-deleted document must
    # never be cited, whether or not RBAC is enforced. Owner isolation is the
    # only part gated on RBAC_ENFORCE (legacy single-tenant deployments keep
    # sharing every live document).
    enforce_owner = rbac_manager is not None and rbac_manager.enforce

    account = account or {}
    perms: dict[str, str] = {}
    username = account.get("username")
    if enforce_owner and username:
        try:
            perms = (await rbac_manager.get_permissions(username)) or {}
        except Exception as e:
            logger.warning(f"reference filter: permission lookup failed for "
                          f"'{username}': {e}")
            perms = {}

    cache: dict[str, Any] = {}
    kept_refs: list[dict[str, Any]] = []
    for ref in refs:
        file_path = ref.get("file_path", "")
        doc = await _resolve_doc_by_path(rag, file_path, cache)
        if doc is None:
            # Soft-deleted or unknown source: never cite it.
            continue
        if enforce_owner:
            _doc_id, doc_data = doc
            owner = (doc_data.get("metadata") or {}).get("owner") or None
            if owner and not _can_view_private(account, perms, workspace, owner):
                continue
        kept_refs.append(ref)

    # Renumber references 1..N and build the file_path -> new id alignment map.
    fp_to_new_id: dict[str, str] = {}
    for idx, ref in enumerate(kept_refs, 1):
        new_id = str(idx)
        ref["reference_id"] = new_id
        fp_to_new_id[ref.get("file_path", "")] = new_id

    kept_chunks: list[dict[str, Any]] = []
    for chunk in chunks or []:
        file_path = chunk.get("file_path", "")
        doc = await _resolve_doc_by_path(rag, file_path, cache)
        if doc is None:
            continue
        if enforce_owner:
            _doc_id, doc_data = doc
            owner = (doc_data.get("metadata") or {}).get("owner") or None
            if owner and not _can_view_private(account, perms, workspace, owner):
                continue
        new_id = fp_to_new_id.get(file_path)
        if new_id is None:
            # A chunk whose file is not among the kept references (e.g. the
            # reference list omitted it): keep it only if its own reference id
            # still maps to a kept reference.
            new_id = fp_to_new_id.get(file_path, "")
        if new_id:
            chunk["reference_id"] = new_id
        kept_chunks.append(chunk)

    return kept_refs, kept_chunks


async def filter_entities_and_relations(
    entities: Optional[list[dict[str, Any]]],
    relationships: Optional[list[dict[str, Any]]],
    *,
    rag: Any,
    account: Optional[dict[str, Any]],
    workspace: str,
    rbac_manager: Optional[Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Filter /query/data entities/relationships by document access.

    Mirrors ``filter_references_and_chunks``: soft-delete exclusion is
    unconditional; owner isolation is gated on RBAC_ENFORCE. Entities with no
    source attribution (``unknown_source`` / empty ``file_path``) are kept — they
    are shared, source-less KG objects, not evidence of a deleted document.
    """
    ents = entities or []
    rels = relationships or []
    if not ents and not rels:
        return ents, rels

    enforce_owner = rbac_manager is not None and rbac_manager.enforce
    account = account or {}
    perms: dict[str, str] = {}
    username = account.get("username")
    if enforce_owner and username:
        try:
            perms = (await rbac_manager.get_permissions(username)) or {}
        except Exception as e:
            logger.warning(f"reference filter: permission lookup failed for "
                          f"'{username}': {e}")
            perms = {}

    cache: dict[str, Any] = {}

    async def _keep(item: dict[str, Any]) -> bool:
        file_path = (item.get("file_path") or "").strip() if isinstance(item, dict) else ""
        if not file_path or file_path == "unknown_source":
            return True  # source-less KG object: keep
        doc = await _resolve_doc_by_path(rag, file_path, cache)
        if doc is None:
            return False  # soft-deleted or missing source: drop
        if enforce_owner:
            _doc_id, doc_data = doc
            owner = (doc_data.get("metadata") or {}).get("owner") or None
            if owner and not _can_view_private(account, perms, workspace, owner):
                return False
        return True

    kept_ents: list[dict[str, Any]] = []
    for ent in ents:
        if isinstance(ent, dict) and await _keep(ent):
            kept_ents.append(ent)

    kept_rels: list[dict[str, Any]] = []
    for rel in rels:
        if isinstance(rel, dict) and await _keep(rel):
            kept_rels.append(rel)

    return kept_ents, kept_rels
