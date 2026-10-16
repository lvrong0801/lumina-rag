"""Unit tests for reference/chunk access filtering (P1 owner isolation).

Covers the two filtering rules (soft-delete invisibility + owner isolation)
and the renumbering contract, independent of HTTP routing.
"""

import pytest

from lightrag.api.reference_access import filter_references_and_chunks


class _FakeDocStatus:
    """basename -> (doc_id, doc_data); a missing basename means the row is
    soft-deleted (get_doc_by_file_basename skips DELETED rows) or unknown."""

    def __init__(self, docs: dict):
        self._docs = docs

    async def get_doc_by_file_basename(self, basename: str):
        return self._docs.get(basename)


class _FakeRag:
    def __init__(self, docs: dict):
        self.doc_status = _FakeDocStatus(docs)


class _FakeRBAC:
    def __init__(self, enforce: bool = True, perms: dict | None = None):
        self.enforce = enforce
        self._perms = perms or {}

    async def get_permissions(self, username: str):
        return self._perms.get(username, {})


def _ref(reference_id: str, file_path: str) -> dict:
    return {"reference_id": reference_id, "file_path": file_path}


def _chunk(reference_id: str, file_path: str) -> dict:
    return {"content": "c", "file_path": file_path, "chunk_id": "x", "reference_id": reference_id}


def _doc(owner: str | None) -> dict:
    metadata = {"owner": owner} if owner else {}
    return {"status": "processed", "metadata": metadata}


# shared doc store: two public-ish docs + one owner-isolated doc + one soft-deleted
_DOCS = {
    "shared.pdf": ("doc-shared", _doc(None)),
    "private.pdf": ("doc-private", _doc("alice")),
    # "deleted.pdf" intentionally absent -> behaves as soft-deleted
}


@pytest.mark.asyncio
async def test_passthrough_without_rbac_manager():
    rag = _FakeRag(dict(_DOCS))
    refs = [_ref("1", "shared.pdf"), _ref("2", "private.pdf")]
    chunks = [_chunk("1", "shared.pdf")]
    out_refs, out_chunks = await filter_references_and_chunks(
        refs, chunks, rag=rag, account={"username": "bob"}, workspace="ws",
        rbac_manager=None,
    )
    assert out_refs == refs
    assert out_chunks == chunks


@pytest.mark.asyncio
async def test_passthrough_when_rbac_not_enforced():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC(enforce=False)
    refs = [_ref("1", "shared.pdf")]
    out_refs, out_chunks = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob"}, workspace="ws",
        rbac_manager=rbac,
    )
    assert out_refs == refs


@pytest.mark.asyncio
async def test_soft_deleted_reference_is_removed():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [_ref("1", "shared.pdf"), _ref("2", "deleted.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob"}, workspace="ws",
        rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["shared.pdf"]


@pytest.mark.asyncio
async def test_owner_isolation_blocks_non_owner():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC(perms={"bob": {"ws": "read"}})
    refs = [_ref("1", "shared.pdf"), _ref("2", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob", "role": "viewer"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["shared.pdf"]


@pytest.mark.asyncio
async def test_owner_sees_own_document():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [_ref("1", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "alice", "role": "viewer"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["private.pdf"]


@pytest.mark.asyncio
async def test_admin_sees_owner_isolated_document():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [_ref("1", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "root", "role": "admin"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["private.pdf"]


@pytest.mark.asyncio
async def test_workspace_admin_grant_sees_owner_isolated_document():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC(perms={"mgr": {"ws": "admin"}})
    refs = [_ref("1", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "mgr", "role": "manager"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["private.pdf"]


@pytest.mark.asyncio
async def test_wildcard_admin_grant_sees_owner_isolated_document():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC(perms={"mgr": {"*": "admin"}})
    refs = [_ref("1", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "mgr", "role": "manager"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["private.pdf"]


@pytest.mark.asyncio
async def test_service_admin_bypasses_owner_isolation():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [_ref("1", "private.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"is_service_admin": True},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["private.pdf"]


@pytest.mark.asyncio
async def test_reference_ids_renumbered_contiguously():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [
        _ref("1", "deleted.pdf"),  # dropped
        _ref("2", "private.pdf"),  # dropped for bob
        _ref("3", "shared.pdf"),   # kept
    ]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob", "role": "viewer"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["reference_id"] for r in out_refs] == ["1"]


@pytest.mark.asyncio
async def test_chunks_filtered_and_aligned_with_renumbered_references():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [
        _ref("7", "deleted.pdf"),
        _ref("8", "shared.pdf"),
        _ref("9", "private.pdf"),
    ]
    chunks = [
        _chunk("7", "deleted.pdf"),   # dropped with its file
        _chunk("8", "shared.pdf"),    # kept, renumbered to 1
        _chunk("9", "private.pdf"),   # dropped for bob
    ]
    out_refs, out_chunks = await filter_references_and_chunks(
        refs, chunks, rag=rag, account={"username": "bob", "role": "viewer"},
        workspace="ws", rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["shared.pdf"]
    assert [r["reference_id"] for r in out_refs] == ["1"]
    assert len(out_chunks) == 1
    assert out_chunks[0]["file_path"] == "shared.pdf"
    assert out_chunks[0]["reference_id"] == "1"


@pytest.mark.asyncio
async def test_empty_file_path_reference_is_dropped():
    rag = _FakeRag(dict(_DOCS))
    rbac = _FakeRBAC()
    refs = [_ref("1", ""), _ref("2", "shared.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob"}, workspace="ws",
        rbac_manager=rbac,
    )
    assert [r["file_path"] for r in out_refs] == ["shared.pdf"]


@pytest.mark.asyncio
async def test_doc_status_lookup_failure_fails_open():
    class _BoomDocStatus:
        async def get_doc_by_file_basename(self, basename):
            raise RuntimeError("store down")

    rag = _FakeRag(dict(_DOCS))
    rag.doc_status = _BoomDocStatus()
    rbac = _FakeRBAC()
    refs = [_ref("1", "shared.pdf")]
    out_refs, _ = await filter_references_and_chunks(
        refs, [], rag=rag, account={"username": "bob"}, workspace="ws",
        rbac_manager=rbac,
    )
    # Fail-open: the reference is dropped rather than 500-ing the query.
    assert out_refs == []
