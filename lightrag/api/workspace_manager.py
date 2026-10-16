"""
WorkspaceManager: manages LightRAG instances for named workspaces.

The default workspace (``args.workspace``, empty string when unset) is created
eagerly by the server and resolved by ``get_rag_dependency`` /
``get_doc_manager_dependency`` without going through this manager. This manager
owns only *named* workspaces, created lazily on demand via ``rag_factory``.

Every workspace name passes through :func:`lightrag.utils.validate_workspace`
before it is joined to a directory, so a name can never contain a path separator
or a relative-path reference (``.`` / ``..``). This keeps every
``working_dir / workspace`` join inside ``working_dir`` even for names supplied
over the API.

Memory bound (multi-tenant): live instances are capped at ``max_instances``
and evicted when idle for ``idle_timeout_seconds``. An instance is "idle" when
its workspace pipeline status is not busy; eviction finalizes storages, so a
pipeline running in the background must never be torn down under it. The
server starts a periodic reclaim task (see ``reclaim_idle_instances``).
"""
import asyncio
import shutil
import time
from pathlib import Path
from typing import Dict, List, Optional

from lightrag import LightRAG
from lightrag.utils import canonical_workspace_name, logger
from lightrag.api.routers.document_routes import DocumentManager
from lightrag.kg.shared_storage import get_namespace_lock

# LightRAG's own internal directories under ``working_dir`` that must never be
# reported as workspaces when discovered from disk.
_INTERNAL_DIRS = {"scan_spool", "named", "unnamed"}


class WorkspaceManager:
    """Manages LightRAG instances for named workspaces (default handled by server)."""

    def __init__(
        self,
        args,
        rag_factory,
        max_instances: int = 4,
        idle_timeout_seconds: int = 300,
    ):
        self.args = args
        self.rag_factory = rag_factory
        # The server eagerly creates and owns this workspace. The manager must
        # never lazily create an instance that would collide with it.
        self.default_workspace = getattr(args, "workspace", "") or ""
        self.instances: Dict[str, LightRAG] = {}
        self.doc_managers: Dict[str, DocumentManager] = {}
        self._instances_lock = asyncio.Lock()
        self._doc_managers_lock = asyncio.Lock()
        # monotonic last-use timestamps for eviction decisions
        self._last_used: Dict[str, float] = {}
        self.max_instances = max(1, max_instances)
        self.idle_timeout_seconds = max(0, idle_timeout_seconds)
        Path(self.args.working_dir).mkdir(parents=True, exist_ok=True)
        Path(self.args.input_dir).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _validated(workspace: str) -> str:
        """Return a non-empty, single-component workspace name or raise."""
        name = (workspace or "").strip()
        if not name:
            raise ValueError("Workspace name must not be empty.")
        return canonical_workspace_name(name)

    def _working_dir(self, workspace: str) -> str:
        return str(Path(self.args.working_dir) / self._validated(workspace))

    def _input_dir(self, workspace: str) -> str:
        return str(Path(self.args.input_dir) / self._validated(workspace))

    async def _create_instance(self, workspace: str) -> LightRAG:
        working_dir = self._working_dir(workspace)
        Path(working_dir).mkdir(parents=True, exist_ok=True)
        rag = self.rag_factory(working_dir, workspace)
        await rag.initialize_storages()
        await rag.check_and_migrate_data()
        logger.info(f"LightRAG ready for workspace: '{workspace}'")
        return rag

    # ── Reclaim helpers ────────────────────────────────────────────────────

    async def _is_pipeline_busy(self, workspace: str) -> bool:
        """Conservative busy probe: refuse to evict while the workspace's
        pipeline status says work is in flight. Any error counts as busy."""
        try:
            from lightrag.kg.shared_storage import get_namespace_data

            status = await get_namespace_data("pipeline_status", workspace=workspace)
            snapshot = status.copy() if hasattr(status, "copy") else dict(status or {})
            return bool(
                snapshot.get("busy", False)
                or snapshot.get("scanning", False)
                or snapshot.get("destructive_busy", False)
            )
        except Exception:
            return True

    async def _finalize_instance(self, workspace: str, rag: Optional[LightRAG]) -> None:
        if rag is not None:
            try:
                await rag.finalize_storages()
            except Exception as exc:
                logger.error(
                    f"Error finalizing workspace '{workspace}' instance: {exc}"
                )

    async def _evict_one_lru(self) -> bool:
        """Drop the least-recently-used instance whose pipeline is idle.

        Caller must already hold ``self._instances_lock`` (get_instance does:
        it evicts inside its own critical section, so taking the lock here
        would deadlock on asyncio.Lock re-entry). Returns True if one was
        evicted."""
        candidates = sorted(
            ((self._last_used.get(w, 0.0), w) for w in self.instances),
            key=lambda x: x[0],
        )
        for _, workspace in candidates:
            if not await self._is_pipeline_busy(workspace):
                rag = self.instances.pop(workspace, None)
                self._last_used.pop(workspace, None)
                async with self._doc_managers_lock:
                    self.doc_managers.pop(workspace, None)
                await self._finalize_instance(workspace, rag)
                logger.info(
                    f"Workspace '{workspace}' evicted (capacity {self.max_instances})"
                )
                return True
        return False

    async def reclaim_idle_instances(self) -> List[str]:
        """Evict instances idle longer than ``idle_timeout_seconds`` whose
        pipeline is not busy. Returns the evicted workspace names.

        Called periodically by the server's reclaim background task and at
        shutdown; safe to call concurrently with request traffic (eviction is
        serialized under the instances lock and skips busy workspaces).
        """
        reclaimed: List[str] = []
        now = time.monotonic()
        async with self._instances_lock:
            idle_candidates = [
                w
                for w in self.instances
                if now - self._last_used.get(w, 0.0) >= self.idle_timeout_seconds
            ]
            targets: List[str] = []
            for w in idle_candidates:
                if not await self._is_pipeline_busy(w):
                    targets.append(w)
            for w in targets:
                rag = self.instances.pop(w, None)
                self._last_used.pop(w, None)
                async with self._doc_managers_lock:
                    self.doc_managers.pop(w, None)
                await self._finalize_instance(w, rag)
                reclaimed.append(w)
        if reclaimed:
            logger.info(
                f"WorkspaceManager: reclaimed idle workspace instance(s): {reclaimed}"
            )
        return reclaimed

    async def evict_workspace(self, workspace: str) -> bool:
        """Evict a specific workspace's live instance if its pipeline is idle
        (used by health/ready diagnostics and admin workflows)."""
        workspace = self._validated(workspace or "")
        async with self._instances_lock:
            if workspace not in self.instances:
                return False
            if await self._is_pipeline_busy(workspace):
                return False
            rag = self.instances.pop(workspace, None)
            self._last_used.pop(workspace, None)
            async with self._doc_managers_lock:
                self.doc_managers.pop(workspace, None)
            await self._finalize_instance(workspace, rag)
            return True

    @property
    def live_instance_count(self) -> int:
        return len(self.instances)

    # ── Instance access ────────────────────────────────────────────────────

    async def get_instance(self, workspace: Optional[str] = None) -> LightRAG:
        workspace = self._validated(workspace or "")
        if workspace == self.default_workspace:
            raise ValueError(
                f"Workspace '{workspace}' is the server's default workspace."
            )
        async with self._instances_lock:
            now = time.monotonic()
            if workspace not in self.instances:
                if len(self.instances) >= self.max_instances:
                    # Capacity reached: try to evict an idle LRU instance; only
                    # refuse when nothing can be evicted (all busy).
                    evicted = await self._evict_one_lru()
                    if not evicted:
                        raise ValueError(
                            f"Too many active workspaces (limit {self.max_instances}) "
                            "and no idle instance to evict. Try again later."
                        )
                self.instances[workspace] = await self._create_instance(workspace)
            self._last_used[workspace] = now
            return self.instances[workspace]

    async def get_doc_manager(self, workspace: Optional[str] = None) -> DocumentManager:
        workspace = self._validated(workspace or "")
        if workspace == self.default_workspace:
            raise ValueError(
                f"Workspace '{workspace}' is the server's default workspace."
            )
        async with self._doc_managers_lock:
            if workspace not in self.doc_managers:
                input_dir = self._input_dir(workspace)
                Path(input_dir).mkdir(parents=True, exist_ok=True)
                self.doc_managers[workspace] = DocumentManager(
                    input_dir, workspace=workspace
                )
            self._last_used[workspace] = time.monotonic()
            return self.doc_managers[workspace]

    async def list_workspaces(self) -> List[str]:
        """Return the default workspace plus every named workspace.

        Named workspaces are the union of live instances and directories
        discovered under ``working_dir``, excluding LightRAG's internal
        directories and hidden entries.
        """
        names: set = {self.default_workspace}
        async with self._instances_lock:
            names.update(self.instances.keys())
        async with self._doc_managers_lock:
            names.update(self.doc_managers.keys())
        base = Path(self.args.working_dir)
        if base.exists():
            for item in base.iterdir():
                if (
                    item.is_dir()
                    and not item.name.startswith((".", "__"))
                    and item.name not in _INTERNAL_DIRS
                ):
                    names.add(item.name)
        return sorted(names)

    async def delete_workspace(self, workspace: str) -> None:
        workspace = self._validated(workspace or "")
        if workspace == self.default_workspace:
            raise ValueError("Cannot delete the default workspace.")

        async with self._instances_lock:
            instance = self.instances.pop(workspace, None)
            self._last_used.pop(workspace, None)
        async with self._doc_managers_lock:
            self.doc_managers.pop(workspace, None)

        # Finalize outside the lock: finalize_storages may block on IO.
        await self._finalize_instance(workspace, instance)

        for directory in (self._working_dir(workspace), self._input_dir(workspace)):
            path = Path(directory)
            if path.exists():
                shutil.rmtree(path)

    async def finalize_all(self) -> None:
        async with self._instances_lock:
            instances = list(self.instances.values())
            self.instances.clear()
            self._last_used.clear()
        async with self._doc_managers_lock:
            self.doc_managers.clear()
        for rag in instances:
            try:
                await rag.finalize_storages()
            except Exception as exc:
                logger.error(f"Error finalizing workspace instance: {exc}")
