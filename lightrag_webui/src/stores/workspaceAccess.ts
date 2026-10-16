/**
 * Workspace access-level mirror (read from GET /workspaces).
 *
 * The server filters the workspace list by RBAC and annotates each entry with
 * its access_level (read/write/admin) for non-admin callers. This store keeps
 * that mapping client-side so write-affordance decisions (upload / clear /
 * delete buttons) can be made anywhere, without re-fetching.
 */
import { create } from 'zustand'
import { createSelectors } from '@/lib/utils'

interface WorkspaceAccessState {
  /** workspace name ('' = default) -> access_level */
  levels: Record<string, string>
  setLevels: (levels: Record<string, string>) => void
  clear: () => void
}

const useWorkspaceAccessStoreBase = create<WorkspaceAccessState>()((set) => ({
  levels: {},
  setLevels: (levels) => set({ levels }),
  clear: () => set({ levels: {} }),
}))

export const useWorkspaceAccess = createSelectors(useWorkspaceAccessStoreBase)

/** Access level for a workspace name ('' = default workspace). */
export const workspaceAccessLevel = (name: string): string | undefined =>
  useWorkspaceAccessStoreBase.getState().levels[name]
