/**
 * WorkspacePanel — 工作区（命名空间）管理，内联在系统管理页。
 *
 * Same /workspaces backend as the document page's WorkspaceSelector, but the
 * create/edit/delete affordances live here (admin-only via the page gate);
 * the selector on the document page is switch-only.
 *
 * "Edit" covers what PATCH /workspaces/{name} supports: description and the
 * active/archived status — renaming a workspace does not exist server-side.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Loader2, Plus, Pencil, Trash2 } from 'lucide-react'

import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table'
import StatusBadge from '@/components/ui/StatusBadge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'

import {
  listWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  type WorkspaceInfo,
} from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { errorMessage } from '@/lib/utils'

const NAME_RE = /^[a-zA-Z0-9_-]+$/

const toLabel = (name: string) => (name === '' ? 'default' : name)

export default function WorkspacePanel() {
  const { t } = useTranslation()
  const currentWorkspace = useSettingsStore.use.currentWorkspace()
  const setCurrentWorkspace = useSettingsStore.use.setCurrentWorkspace()

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(false)

  // Inline create form
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  // Edit dialog
  const [editTarget, setEditTarget] = useState<WorkspaceInfo | null>(null)
  const [editDesc, setEditDesc] = useState('')
  const [editStatus, setEditStatus] = useState('active')
  const [editing, setEditing] = useState(false)

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceInfo | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await listWorkspaces()
      setWorkspaces(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('[WorkspacePanel] load failed:', err)
      toast.error(t('workspaces.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error(t('workspaces.nameEmpty'))
      return
    }
    if (!NAME_RE.test(name)) {
      toast.error(t('workspaces.nameInvalid'))
      return
    }
    try {
      setCreating(true)
      await createWorkspace(name, newDesc.trim())
      toast.success(t('workspaces.createSuccess', { name }))
      setNewName('')
      setNewDesc('')
      await load()
    } catch (err) {
      console.error('[WorkspacePanel] create failed:', err)
      toast.error(t('workspaces.createError'))
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (ws: WorkspaceInfo) => {
    setEditTarget(ws)
    setEditDesc(ws.description ?? '')
    setEditStatus(ws.status ?? 'active')
  }

  const handleEdit = async () => {
    if (!editTarget) return
    try {
      setEditing(true)
      await updateWorkspace(editTarget.name, {
        description: editDesc.trim(),
        status: editStatus
      })
      toast.success(t('workspaces.updateSuccess', { name: toLabel(editTarget.name) }))
      setEditTarget(null)
      await load()
    } catch (err) {
      console.error('[WorkspacePanel] update failed:', err)
      toast.error(errorMessage(err) || t('workspaces.updateError'))
    } finally {
      setEditing(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await deleteWorkspace(deleteTarget.name)
      toast.success(t('workspaces.deleteSuccess', { name: toLabel(deleteTarget.name) }))
      setDeleteTarget(null)
      // Deleting the workspace the user is browsing must not leave a dangling
      // selection behind — the next request would carry a header for a gone
      // namespace. Fall back to default, same rule the old selector delete had.
      if (currentWorkspace === deleteTarget.name) setCurrentWorkspace('')
      await load()
    } catch (err) {
      console.error('[WorkspacePanel] delete failed:', err)
      toast.error(t('workspaces.deleteError'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Create workspace */}
      <div className="rounded-md border p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Plus className="h-4 w-4" /> {t('workspaces.new')}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1">
            <Input
              placeholder={t('workspaces.namePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="min-w-[200px] flex-[2]">
            <Input
              placeholder={t('workspaces.descPlaceholder')}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
            />
          </div>
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.create')}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('workspaces.createDesc')}</p>
      </div>

      {/* Workspaces table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('workspaces.colName')}</TableHead>
              <TableHead>{t('workspaces.colDesc')}</TableHead>
              <TableHead>{t('workspaces.colStatus')}</TableHead>
              <TableHead>{t('workspaces.colOwner')}</TableHead>
              <TableHead className="text-right">{t('admin.colActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : workspaces.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-gray-500">
                  {t('workspaces.empty')}
                </TableCell>
              </TableRow>
            ) : (
              workspaces.map((ws) => (
                <TableRow key={ws.name === '' ? '__default__' : ws.name}>
                  <TableCell className="font-medium">
                    {toLabel(ws.name)}
                    {ws.is_default && (
                      <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        default
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[320px]">
                    <span className="block truncate text-sm text-muted-foreground">
                      {ws.description || '-'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={ws.status === 'archived' ? 'failed' : 'completed'} showIcon={false}>
                      {ws.status === 'archived' ? t('workspaces.statusArchived') : t('workspaces.statusActive')}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {ws.owner || '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline" size="sm"
                        disabled={ws.is_default}
                        onClick={() => openEdit(ws)}
                        tooltip={ws.is_default ? t('workspaces.cannotEditDefault') : t('workspaces.editTooltip', { name: toLabel(ws.name) })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline" size="sm"
                        disabled={ws.is_default}
                        onClick={() => setDeleteTarget(ws)}
                        tooltip={ws.is_default ? t('workspaces.cannotDeleteDefault') : t('workspaces.deleteTooltip', { name: toLabel(ws.name) })}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Edit dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(o) => { if (!o) setEditTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('workspaces.editTitle', { name: toLabel(editTarget?.name ?? '') })}</DialogTitle>
            <DialogDescription>{t('workspaces.editDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t('workspaces.descPlaceholder')}
              value={editDesc}
              autoFocus
              onChange={(e) => setEditDesc(e.target.value)}
            />
            <Select value={editStatus} onValueChange={setEditStatus}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t('workspaces.statusActive')}</SelectItem>
                <SelectItem value="archived">{t('workspaces.statusArchived')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editing}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleEdit} disabled={editing}>
              {editing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('workspaces.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('workspaces.deleteDesc', { name: toLabel(deleteTarget?.name ?? '') })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
