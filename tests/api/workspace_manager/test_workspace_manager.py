"""WorkspaceManager instance lifecycle tests: LRU capacity eviction, idle
reclamation and busy protection, plus the delete path.

``get_namespace_data`` (pipeline_status) is monkeypatched so busy-ness is
controllable without a real shared-storage backend.
"""
import asyncio
import sys

import pytest

import lightrag.kg.shared_storage as shared_storage

# Import-time argparse guard (see tests/api/audit/test_audit.py note).
_original_argv = sys.argv[:]
sys.argv = [sys.argv[0]]
from lightrag.api.workspace_manager import WorkspaceManager

sys.argv = _original_argv


class FakeArgs:
    def __init__(self, tmp_path):
        self.working_dir = str(tmp_path / "working")
        self.input_dir = str(tmp_path / "input")
        self.workspace = ""


class FakeRag:
    def __init__(self, working_dir, workspace):
        self.working_dir = working_dir
        self.workspace = workspace
        self.finalized = False

    async def initialize_storages(self):
        pass

    async def check_and_migrate_data(self):
        pass

    async def finalize_storages(self):
        self.finalized = True


@pytest.fixture
def manager(tmp_path):
    created = []

    def factory(working_dir, workspace):
        rag = FakeRag(working_dir, workspace)
        created.append(rag)
        return rag

    return WorkspaceManager(
        FakeArgs(tmp_path), factory, max_instances=2, idle_timeout_seconds=60
    )


async def _set_busy(monkeypatch, busy: bool):
    async def fake_get_namespace_data(namespace, workspace=None):
        return {"busy": busy, "scanning": False, "destructive_busy": False}

    monkeypatch.setattr(shared_storage, "get_namespace_data", fake_get_namespace_data)


# ── Basic lifecycle ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_instance_creates_and_reuses(manager: WorkspaceManager):
    first = await manager.get_instance("docs")
    assert first.workspace == "docs"
    assert await manager.get_instance("docs") is first  # cached


@pytest.mark.asyncio
async def test_default_workspace_is_rejected(manager: WorkspaceManager):
    with pytest.raises(ValueError):
        await manager.get_instance("")
    with pytest.raises(ValueError):
        await manager.get_instance(manager.default_workspace)


@pytest.mark.asyncio
async def test_list_workspaces_union(manager: WorkspaceManager, tmp_path):
    await manager.get_instance("alpha")
    await manager.get_instance("beta")
    names = await manager.list_workspaces()
    assert "" in names  # default workspace
    assert "alpha" in names
    assert "beta" in names


# ── LRU capacity eviction ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_capacity_evicts_least_recently_used(
    manager: WorkspaceManager, monkeypatch
):
    await _set_busy(monkeypatch, False)
    a = await manager.get_instance("a")
    await manager.get_instance("b")
    await asyncio.sleep(0.01)
    await manager.get_instance("c")  # capacity 2 -> evicts LRU ("a")
    assert "a" not in manager.instances
    assert set(manager.instances) == {"b", "c"}
    assert a.finalized is True
    assert "a" not in manager._last_used


@pytest.mark.asyncio
async def test_capacity_refuses_when_all_busy(
    manager: WorkspaceManager, monkeypatch
):
    await _set_busy(monkeypatch, True)
    await manager.get_instance("a")
    await manager.get_instance("b")
    with pytest.raises(ValueError):
        await manager.get_instance("c")  # both busy -> nothing to evict


# ── Idle reclamation ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reclaim_idle_instances(tmp_path, monkeypatch):
    await _set_busy(monkeypatch, False)
    m = WorkspaceManager(
        FakeArgs(tmp_path),
        lambda wd, ws: FakeRag(wd, ws),
        max_instances=8,
        idle_timeout_seconds=0.05,
    )
    idle = await m.get_instance("idle-ws")
    await asyncio.sleep(0.06)
    busy_ws = await m.get_instance("busy-ws")
    await m.reclaim_idle_instances()
    # idle-ws was last used before the timeout; busy-ws was just touched.
    assert "idle-ws" not in m.instances
    assert "busy-ws" in m.instances
    assert idle.finalized is True


@pytest.mark.asyncio
async def test_reclaim_skips_busy_instances(manager: WorkspaceManager, monkeypatch):
    await _set_busy(monkeypatch, True)
    await manager.get_instance("a")
    await asyncio.sleep(0.01)
    await manager.get_instance("b")
    manager.idle_timeout_seconds = 0.001
    evicted = await manager.reclaim_idle_instances()
    assert evicted == []
    assert set(manager.instances) == {"a", "b"}


# ── Delete ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_workspace_removes_instance_and_files(
    manager: WorkspaceManager, tmp_path
):
    rag = await manager.get_instance("gone")
    wd = manager._working_dir("gone")
    assert (tmp_path / "working" / "gone").exists()
    await manager.delete_workspace("gone")
    assert "gone" not in manager.instances
    assert "gone" not in manager._last_used
    assert rag.finalized is True
    assert not (tmp_path / "working" / "gone").exists()


@pytest.mark.asyncio
async def test_delete_default_workspace_rejected(manager: WorkspaceManager):
    with pytest.raises(ValueError):
        await manager.delete_workspace("")
