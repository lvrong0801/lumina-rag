/**
 * WorkspaceSelector
 *
 * Renders a dropdown to switch workspaces plus two icon-buttons to
 * create / delete named workspaces.
 *
 * Rules
 * -----
 * - Default workspace is stored as "" on the server and displayed as "default".
 * - The frontend stores the current workspace in Zustand (persisted to localStorage).
 * - Every axios request automatically attaches the LIGHTRAG-WORKSPACE header via
 *   the interceptor in src/api/lightrag.ts, so nothing extra is needed here.
 */
import React, { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2, FolderOpen, Loader2 } from 'lucide-react'

import Button from '@/components/ui/Button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog'
import Input from '@/components/ui/Input'

import { listWorkspaces, createWorkspace, deleteWorkspace } from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/state'
import { useWorkspaceAccess } from '@/stores/workspaceAccess'
import { canManageWorkspaces } from '@/lib/rbac'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceInfo {
  name: string       // "" means default workspace
  is_default: boolean
  access_level?: string
}

interface WorkspaceSelectorProps {
  /** Called after the active workspace changes so the parent can refresh data. */
  onWorkspaceChange?: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a server workspace name to the label shown in the UI. */
const toLabel = (name: string) => (name === '' ? 'default' : name)

/** Convert a UI value back to a server workspace name. */
const toServer = (value: string) => (value === 'default' ? '' : value)

/** The value used in the <Select> for the default workspace. */
const DEFAULT_VALUE = 'default'

const NAME_RE = /^[a-zA-Z0-9_-]+$/

// ─── Component ────────────────────────────────────────────────────────────────

const WorkspaceSelector: React.FC<WorkspaceSelectorProps> = ({ onWorkspaceChange }) => {
  const currentWorkspace = useSettingsStore.use.currentWorkspace()
  const setCurrentWorkspace = useSettingsStore.use.setCurrentWorkspace()
  const setLevels = useWorkspaceAccess.use.setLevels()
  const { role } = useAuthStore()
  const canManage = canManageWorkspaces(role)

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loadingList, setLoadingList] = useState(false)

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // Delete dialog state
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // ── Data fetching ────────────────────────────────────────────────────────

  const fetchWorkspaces = useCallback(async () => {
    try {
      setLoadingList(true)
      const data = await listWorkspaces()
      // Defensive: some test backends / early responses answer non-arrays.
      const list = Array.isArray(data) ? data : []
      setWorkspaces(list)
      // Mirror the access levels so write-affordance decisions (upload /
      // clear / delete buttons) can be made elsewhere without re-fetching.
      const levels: Record<string, string> = {}
      for (const ws of list) {
        if (ws.access_level) levels[ws.name] = ws.access_level
      }
      setLevels(levels)
    } catch (err) {
      console.error('[WorkspaceSelector] Failed to load workspaces:', err)
      toast.error('Failed to load workspaces')
    } finally {
      setLoadingList(false)
    }
  }, [setLevels])

  useEffect(() => {
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void fetchWorkspaces(), 0)
    return () => clearTimeout(timer)
  }, [fetchWorkspaces])

  // ── Select change ────────────────────────────────────────────────────────

  const handleSelect = (value: string) => {
    const serverName = toServer(value)
    setCurrentWorkspace(serverName)
    onWorkspaceChange?.()
  }

  // The value used in <Select> for the current selection
  const selectValue = currentWorkspace === '' ? DEFAULT_VALUE : currentWorkspace

  // ── Create workspace ─────────────────────────────────────────────────────

  const handleCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed) {
      toast.error('Workspace name cannot be empty.')
      return
    }
    if (!NAME_RE.test(trimmed)) {
      toast.error('Name may only contain letters, digits, underscores or hyphens.')
      return
    }
    try {
      setCreating(true)
      await createWorkspace(trimmed)
      toast.success(`Workspace "${trimmed}" created.`)
      setNewName('')
      setCreateOpen(false)
      await fetchWorkspaces()
      // Automatically switch to the new workspace
      setCurrentWorkspace(trimmed)
      onWorkspaceChange?.()
    } catch (err) {
      console.error('[WorkspaceSelector] Create failed:', err)
      toast.error('Failed to create workspace.')
    } finally {
      setCreating(false)
    }
  }

  // ── Delete workspace ─────────────────────────────────────────────────────

  const handleDelete = async () => {
    try {
      setDeleting(true)
      await deleteWorkspace(currentWorkspace)
      toast.success(`Workspace "${toLabel(currentWorkspace)}" deleted.`)
      setDeleteOpen(false)
      // Fall back to default workspace
      setCurrentWorkspace('')
      await fetchWorkspaces()
      onWorkspaceChange?.()
    } catch (err) {
      console.error('[WorkspaceSelector] Delete failed:', err)
      toast.error('Failed to delete workspace.')
    } finally {
      setDeleting(false)
    }
  }

  const isDefault = currentWorkspace === ''

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex items-center gap-1 min-w-0">
      {/* Workspace selector — shrinkable so a long workspace name doesn't push the header wider */}
      <Select value={selectValue} onValueChange={handleSelect} disabled={loadingList}>
        <SelectTrigger className="h-8 w-[160px] max-w-[240px] text-sm">
          <div className="flex items-center gap-1.5 min-w-0">
            {loadingList
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            }
            <SelectValue />
          </div>
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((ws) => (
            <SelectItem key={ws.name === '' ? '__default__' : ws.name}
              value={ws.name === '' ? DEFAULT_VALUE : ws.name}>
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate font-medium">{toLabel(ws.name)}</span>
                {ws.access_level === 'read' && (
                  <span className="shrink-0 rounded bg-amber-100 px-1 text-[10px] leading-3 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    read
                  </span>
                )}
                {ws.access_level === 'write' && (
                  <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] leading-3 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                    write
                  </span>
                )}
                {ws.access_level === 'admin' && (
                  <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] leading-3 text-primary">
                    admin
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Create workspace — admin gate; hidden for viewers/managers */}
      {canManage && (
        <>
          <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) setNewName('') }}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0" tooltip="New workspace">
                <Plus className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
                <DialogDescription>
                  Letters, digits, underscores and hyphens only.
                </DialogDescription>
              </DialogHeader>
              <Input
                placeholder="workspace-name"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Delete workspace (disabled for default) */}
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline" size="sm" className="h-8 w-8 p-0"
                disabled={isDefault}
                tooltip={isDefault ? 'Cannot delete default workspace' : `Delete "${toLabel(currentWorkspace)}"`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Delete workspace</DialogTitle>
                <DialogDescription>
                  All data in workspace <strong>{toLabel(currentWorkspace)}</strong> will be permanently deleted.
                  This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}

export default WorkspaceSelector

