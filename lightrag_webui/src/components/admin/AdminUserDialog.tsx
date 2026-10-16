/**
 * AdminUserDialog — user & workspace-permission administration.
 *
 * Backed by the /admin/users endpoints (RBAC). Only reachable for admins
 * (canManageUsers); the server enforces the same gate independently.
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, KeyRound, ShieldCheck } from 'lucide-react'

import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
// Removed unused Badge import (replaced by StatusBadge)
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
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listUserPermissions,
  setUserPermission,
  deleteUserPermission,
  type AdminUser,
  type AdminWorkspacePermission,
} from '@/api/lightrag'

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-primary/10 text-primary',
  manager: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  viewer: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  guest: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const toLabel = (name: string) => (name === '' ? 'default' : name)

export default function AdminUserDialog({ open, onOpenChange }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)

  // Create form
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('viewer')

  // Permission sub-dialog
  const [permUser, setPermUser] = useState<AdminUser | null>(null)
  const [permissions, setPermissions] = useState<AdminWorkspacePermission[]>([])
  const [permLoading, setPermLoading] = useState(false)
  const [newPermWs, setNewPermWs] = useState('')
  const [newPermLevel, setNewPermLevel] = useState('read')
  const [permBusy, setPermBusy] = useState(false)

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true)
      setUsers(await listUsers())
    } catch (err) {
      console.error('[AdminUserDialog] load users failed:', err)
      toast.error('Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void loadUsers(), 0)
    return () => clearTimeout(timer)
  }, [open, loadUsers])

  const loadPermissions = useCallback(async (user: AdminUser) => {
    setPermLoading(true)
    try {
      setPermissions(await listUserPermissions(user.username))
    } catch (err) {
      console.error('[AdminUserDialog] load permissions failed:', err)
      toast.error('Failed to load permissions')
    } finally {
      setPermLoading(false)
    }
  }, [])

  const handleCreate = async () => {
    const username = newUsername.trim()
    if (!username || !newPassword) {
      toast.error('Username and password are required.')
      return
    }
    try {
      setCreating(true)
      await createUser({ username, password: newPassword, role: newRole })
      toast.success(`User "${username}" created.`)
      setNewUsername('')
      setNewPassword('')
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserDialog] create failed:', err)
      toast.error('Failed to create user.')
    } finally {
      setCreating(false)
    }
  }

  const handleUpdate = async (user: AdminUser, patch: { role?: string; enabled?: boolean }) => {
    try {
      await updateUser(user.username, patch)
      toast.success(`User "${user.username}" updated.`)
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserDialog] update failed:', err)
      toast.error('Failed to update user.')
    }
  }

  const handleDelete = async (user: AdminUser) => {
    try {
      await deleteUser(user.username)
      toast.success(`User "${user.username}" deleted.`)
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserDialog] delete failed:', err)
      toast.error('Failed to delete user.')
    }
  }

  const openPermissions = async (user: AdminUser) => {
    setPermUser(user)
    await loadPermissions(user)
  }

  const handleAddPermission = async () => {
    if (!permUser) return
    const ws = newPermWs.trim() === '' ? '' : newPermWs.trim()
    try {
      setPermBusy(true)
      await setUserPermission(permUser.username, ws, newPermLevel)
      toast.success(`Granted ${newPermLevel} on "${toLabel(ws)}".`)
      setNewPermWs('')
      await loadPermissions(permUser)
    } catch (err) {
      console.error('[AdminUserDialog] set permission failed:', err)
      toast.error('Failed to set permission.')
    } finally {
      setPermBusy(false)
    }
  }

  const handleDeletePermission = async (workspace: string) => {
    if (!permUser) return
    try {
      setPermBusy(true)
      await deleteUserPermission(permUser.username, workspace)
      toast.success(`Revoked permission on "${toLabel(workspace)}".`)
      await loadPermissions(permUser)
    } catch (err) {
      console.error('[AdminUserDialog] delete permission failed:', err)
      toast.error('Failed to revoke permission.')
    } finally {
      setPermBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>User Administration</DialogTitle>
            <DialogDescription>
              Manage accounts, roles and workspace grants. Admins manage
              everything; managers/viewers are read-mostly by role.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Create user */}
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Plus className="h-4 w-4" /> Create user
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[140px] flex-1">
                  <Input
                    placeholder="username"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                </div>
                <div className="min-w-[140px] flex-1">
                  <Input
                    type="password"
                    placeholder="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                  />
                </div>
                <div className="w-[120px]">
                  <Select value={newRole} onValueChange={setNewRole}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">admin</SelectItem>
                      <SelectItem value="manager">manager</SelectItem>
                      <SelectItem value="viewer">viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
                </Button>
              </div>
            </div>

            {/* Users table */}
            <div className="max-h-72 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center">
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : users.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-sm text-gray-500">
                        No users yet — create the first one above (or via AUTH_ACCOUNTS / INIT_ADMIN_*).
                      </TableCell>
                    </TableRow>
                  ) : (
                    users.map((user) => (
                      <TableRow key={user.username}>
                        <TableCell className="font-medium">{user.username}</TableCell>
                        <TableCell>
                          <StatusBadge status={user.role as any} showIcon={false}>
                            {user.role}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={user.enabled ? 'completed' : 'failed'}>
                            {user.enabled ? 'enabled' : 'disabled'}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="outline" size="sm"
                              onClick={() => openPermissions(user)}
                              tooltip="Workspace permissions"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline" size="sm"
                              onClick={() => handleUpdate(user, { enabled: !user.enabled })}
                              tooltip={user.enabled ? 'Disable' : 'Enable'}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="outline" size="sm"
                              onClick={() => handleDelete(user)}
                              tooltip="Delete user"
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
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Workspace-permission sub-dialog */}
      <Dialog open={permUser !== null} onOpenChange={(o) => { if (!o) setPermUser(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Permissions for {permUser ? `"${permUser.username}"` : ''}
            </DialogTitle>
            <DialogDescription>
              Workspace grants: read / write / admin. Empty workspace name
              means the default workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[120px] flex-1">
                <Input
                  placeholder="workspace (empty = default)"
                  value={newPermWs}
                  onChange={(e) => setNewPermWs(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddPermission() }}
                />
              </div>
              <div className="w-[100px]">
                <Select value={newPermLevel} onValueChange={setNewPermLevel}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">read</SelectItem>
                    <SelectItem value="write">write</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAddPermission} disabled={permBusy}>
                Grant
              </Button>
            </div>

            <div className="max-h-48 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Level</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {permLoading ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-4 text-center">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : permissions.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-4 text-center text-sm text-gray-500">
                        No workspace grants.
                      </TableCell>
                    </TableRow>
                  ) : (
                    permissions.map((perm) => (
                      <TableRow key={perm.workspace}>
                        <TableCell>{toLabel(perm.workspace)}</TableCell>
                        <TableCell>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${ROLE_STYLES[perm.access_level] ?? ''}`}>
                            {perm.access_level}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => handleDeletePermission(perm.workspace)}
                            disabled={permBusy}
                            tooltip="Revoke"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-500" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
