/**
 * AdminUserPanel — user & workspace-permission administration.
 *
 * CRUD flows all run through dialogs (create / edit / change password /
 * delete confirm / workspace grants) instead of inline forms. Only admins can
 * reach it (canManageUsers); the server enforces the same gate.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import {
  Loader2, Plus, Trash2, KeyRound, LockKeyhole,
  Pencil, Search, Eye, EyeOff,
} from 'lucide-react'

import Button from '@/components/ui/Button'
import Checkbox from '@/components/ui/Checkbox'
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
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listUserPermissions,
  setUserPermission,
  deleteUserPermission,
  listWorkspaces,
  type AdminUser,
  type AdminWorkspacePermission,
  type WorkspaceInfo,
} from '@/api/lightrag'
import { cn } from '@/lib/utils'

const ROLE_KEYS = ['admin', 'manager', 'viewer'] as const
const LEVEL_KEYS = ['read', 'write', 'admin'] as const

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-primary/10 text-primary',
  manager: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  viewer: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
}

const toLabel = (name: string) => (name === '' ? 'default' : name)

const formatDate = (iso?: string | null) => {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const UserAvatar = ({ username }: { username: string }) => (
  <span
    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold uppercase text-primary"
    aria-hidden="true"
  >
    {username.slice(0, 1).toUpperCase() || '?'}
  </span>
)

export default function AdminUserPanel() {
  const { t } = useTranslation()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  // Grantable namespaces (non-default only — the default workspace has an
  // empty server name and can't sit in a path parameter).
  const [grantableWs, setGrantableWs] = useState<WorkspaceInfo[]>([])

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [newRole, setNewRole] = useState('viewer')
  const [selectedWs, setSelectedWs] = useState<string[]>([])
  const [newGrantLevel, setNewGrantLevel] = useState('write')

  // Edit dialog
  const [editUser, setEditUser] = useState<AdminUser | null>(null)
  const [editRole, setEditRole] = useState('viewer')
  const [editEnabled, setEditEnabled] = useState(true)
  const [editBusy, setEditBusy] = useState(false)

  // Delete confirm dialog
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Permission sub-dialog
  const [permUser, setPermUser] = useState<AdminUser | null>(null)
  const [permissions, setPermissions] = useState<AdminWorkspacePermission[]>([])
  const [permLoading, setPermLoading] = useState(false)
  const [newPermWs, setNewPermWs] = useState('')
  const [newPermLevel, setNewPermLevel] = useState('read')
  const [permBusy, setPermBusy] = useState(false)

  // Change-password sub-dialog
  const [pwUser, setPwUser] = useState<AdminUser | null>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwVisible, setPwVisible] = useState(false)
  const [pwBusy, setPwBusy] = useState(false)

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true)
      setUsers(await listUsers())
    } catch (err) {
      console.error('[AdminUserPanel] load users failed:', err)
      toast.error(t('admin.loadUsersError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void loadUsers(), 0)
    return () => clearTimeout(timer)
  }, [loadUsers])

  useEffect(() => {
    let cancelled = false
    listWorkspaces()
      .then((data) => {
        if (cancelled) return
        setGrantableWs((data ?? []).filter((w) => !w.is_default && w.name !== ''))
      })
      .catch((err) => console.error('[AdminUserPanel] load workspaces failed:', err))
    return () => { cancelled = true }
  }, [])

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.username.toLowerCase().includes(q))
  }, [users, query])

  const resetCreateForm = () => {
    setNewUsername('')
    setNewPassword('')
    setShowPassword(false)
    setNewRole('viewer')
    setSelectedWs([])
    setNewGrantLevel('write')
  }

  const openCreate = () => {
    resetCreateForm()
    setCreateOpen(true)
  }

  const toggleWs = (name: string) => {
    setSelectedWs((prev) =>
      prev.includes(name) ? prev.filter((w) => w !== name) : [...prev, name]
    )
  }

  const loadPermissions = useCallback(async (user: AdminUser) => {
    setPermLoading(true)
    try {
      setPermissions(await listUserPermissions(user.username))
    } catch (err) {
      console.error('[AdminUserPanel] load permissions failed:', err)
      toast.error(t('admin.loadPermsError'))
    } finally {
      setPermLoading(false)
    }
  }, [t])

  const handleCreate = async () => {
    const username = newUsername.trim()
    if (!username || !newPassword) {
      toast.error(t('admin.required'))
      return
    }
    try {
      setCreating(true)
      await createUser({ username, password: newPassword, role: newRole })
      // Grants only matter for non-admin roles — admins bypass workspace
      // checks, so granting them rows would be noise.
      const failed: string[] = []
      if (newRole !== 'admin') {
        for (const ws of selectedWs) {
          try {
            await setUserPermission(username, ws, newGrantLevel)
          } catch (err) {
            console.error('[AdminUserPanel] seed grant failed:', ws, err)
            failed.push(toLabel(ws))
          }
        }
      }
      toast.success(t('admin.createSuccess', { username }))
      if (failed.length > 0) {
        toast.error(t('admin.grantPartialError', { names: failed.join(', ') }))
      }
      setCreateOpen(false)
      resetCreateForm()
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserPanel] create failed:', err)
      toast.error(t('admin.createError'))
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (user: AdminUser) => {
    setEditUser(user)
    setEditRole(user.role)
    setEditEnabled(user.enabled)
  }

  const handleEdit = async () => {
    if (!editUser) return
    const patch: { role?: string; enabled?: boolean } = {}
    if (editRole !== editUser.role) patch.role = editRole
    if (editEnabled !== editUser.enabled) patch.enabled = editEnabled
    if (Object.keys(patch).length === 0) {
      setEditUser(null)
      return
    }
    try {
      setEditBusy(true)
      await updateUser(editUser.username, patch)
      toast.success(t('admin.updateSuccess', { username: editUser.username }))
      setEditUser(null)
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserPanel] edit failed:', err)
      toast.error(t('admin.updateError'))
    } finally {
      setEditBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await deleteUser(deleteTarget.username)
      toast.success(t('admin.deleteSuccess', { username: deleteTarget.username }))
      setDeleteTarget(null)
      await loadUsers()
    } catch (err) {
      console.error('[AdminUserPanel] delete failed:', err)
      toast.error(t('admin.deleteError'))
    } finally {
      setDeleting(false)
    }
  }

  const openChangePassword = (user: AdminUser) => {
    setPwUser(user)
    setPwValue('')
    setPwVisible(false)
  }

  const handleChangePassword = async () => {
    if (!pwUser) return
    if (!pwValue) {
      toast.error(t('admin.required'))
      return
    }
    try {
      setPwBusy(true)
      await updateUser(pwUser.username, { password: pwValue })
      toast.success(t('admin.passwordSuccess', { username: pwUser.username }))
      setPwUser(null)
    } catch (err) {
      console.error('[AdminUserPanel] change password failed:', err)
      toast.error(t('admin.passwordError'))
    } finally {
      setPwBusy(false)
    }
  }

  const openPermissions = async (user: AdminUser) => {
    setPermUser(user)
    setNewPermWs('')
    setNewPermLevel('read')
    await loadPermissions(user)
  }

  const handleAddPermission = async () => {
    if (!permUser || !newPermWs) return
    try {
      setPermBusy(true)
      await setUserPermission(permUser.username, newPermWs, newPermLevel)
      toast.success(t('admin.grantSuccess', { name: toLabel(newPermWs), level: newPermLevel }))
      setNewPermWs('')
      await loadPermissions(permUser)
    } catch (err) {
      console.error('[AdminUserPanel] set permission failed:', err)
      toast.error(t('admin.grantError'))
    } finally {
      setPermBusy(false)
    }
  }

  const handleDeletePermission = async (workspace: string) => {
    if (!permUser) return
    try {
      setPermBusy(true)
      await deleteUserPermission(permUser.username, workspace)
      toast.success(t('admin.revokeSuccess', { name: toLabel(workspace) }))
      await loadPermissions(permUser)
    } catch (err) {
      console.error('[AdminUserPanel] delete permission failed:', err)
      toast.error(t('admin.revokeError'))
    } finally {
      setPermBusy(false)
    }
  }

  // Workspaces without a grant yet — the Select only offers these so a grant
  // is always a fresh row (an existing grant must be revoked first).
  const grantableForPermUser = useMemo(() => {
    const granted = new Set(permissions.map((p) => p.workspace))
    return grantableWs.filter((w) => !granted.has(w.name))
  }, [grantableWs, permissions])

  return (
    <>
      <div className="space-y-4">
        {/* Header: title + search + primary action */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('admin.title')}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('admin.description')}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="w-52 pl-8"
                placeholder={t('admin.searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> {t('admin.createUser')}
            </Button>
          </div>
        </div>

        {/* Users table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.colUsername')}</TableHead>
                <TableHead>{t('admin.colRole')}</TableHead>
                <TableHead>{t('admin.colStatus')}</TableHead>
                <TableHead>{t('admin.colCreatedAt')}</TableHead>
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
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-gray-500">
                    {query ? t('admin.noMatch') : t('admin.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                filteredUsers.map((user) => (
                  <TableRow key={user.username}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <UserAvatar username={user.username} />
                        <span className="font-medium">{user.username}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={user.role as any} showIcon={false}>
                        {user.role}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={user.enabled ? 'completed' : 'failed'}>
                        {user.enabled ? t('admin.enabled') : t('admin.disabled')}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(user.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline" size="sm"
                          onClick={() => openPermissions(user)}
                          tooltip={t('admin.permTooltip')}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => openEdit(user)}
                          tooltip={t('admin.editUser')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => openChangePassword(user)}
                          tooltip={t('admin.changePassword')}
                        >
                          <LockKeyhole className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => setDeleteTarget(user)}
                          tooltip={t('admin.deleteUser')}
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

      {/* Create user dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('admin.createUser')}</DialogTitle>
            <DialogDescription>{t('admin.createDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="new-username">
                {t('admin.usernameLabel')}
              </label>
              <Input
                id="new-username"
                placeholder={t('admin.usernamePlaceholder')}
                value={newUsername}
                autoFocus
                onChange={(e) => setNewUsername(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('admin.usernameRule')}</p>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium" htmlFor="new-password">
                {t('admin.passwordLabel')}
              </label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={t('admin.passwordPlaceholder')}
                  value={newPassword}
                  className="pr-9"
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('admin.hidePassword') : t('admin.showPassword')}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">{t('admin.roleLabel')}</label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_KEYS.map((role) => (
                    <SelectItem key={role} value={role}>
                      <span className={cn('mr-2 rounded px-1.5 py-0.5 text-xs', ROLE_STYLES[role])}>
                        {role}
                      </span>
                      {t(`admin.roleDesc.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newRole !== 'admin' && (
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">{t('admin.grantsLabel')}</label>
                <div className="max-h-40 overflow-auto rounded-md border">
                  {grantableWs.length === 0 ? (
                    <p className="px-3 py-2.5 text-sm text-muted-foreground">
                      {t('admin.noWorkspaces')}
                    </p>
                  ) : (
                    grantableWs.map((ws) => (
                      <label
                        key={ws.name}
                        className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-accent"
                      >
                        <Checkbox
                          checked={selectedWs.includes(ws.name)}
                          onCheckedChange={() => toggleWs(ws.name)}
                        />
                        {toLabel(ws.name)}
                      </label>
                    ))
                  )}
                </div>
                {selectedWs.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {t('admin.grantLevelLabel')}
                    </span>
                    <div className="w-28">
                      <Select value={newGrantLevel} onValueChange={setNewGrantLevel}>
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LEVEL_KEYS.map((lvl) => (
                            <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t('admin.wsSelectDesc')}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit user dialog */}
      <Dialog open={editUser !== null} onOpenChange={(o) => { if (!o) setEditUser(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('admin.editTitle', { username: editUser?.username ?? '' })}</DialogTitle>
            <DialogDescription>{t('admin.editDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">{t('admin.roleLabel')}</label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_KEYS.map((role) => (
                    <SelectItem key={role} value={role}>
                      <span className={cn('mr-2 rounded px-1.5 py-0.5 text-xs', ROLE_STYLES[role])}>
                        {role}
                      </span>
                      {t(`admin.roleDesc.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={editEnabled} onCheckedChange={(v) => setEditEnabled(v === true)} />
              {t('admin.enableLabel')}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)} disabled={editBusy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleEdit} disabled={editBusy}>
              {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete user confirm dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('admin.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('admin.deleteDesc', { username: deleteTarget?.username ?? '' })}
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

      {/* Workspace-permission sub-dialog */}
      <Dialog open={permUser !== null} onOpenChange={(o) => { if (!o) setPermUser(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('admin.permTitle', { username: permUser?.username ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {permUser?.role === 'admin' ? t('admin.permAdminBypass') : t('admin.permDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="min-w-[140px] flex-1">
                <Select value={newPermWs} onValueChange={setNewPermWs}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('admin.wsSelectPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {grantableForPermUser.length === 0 ? (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">
                        {t('admin.noWorkspaces')}
                      </div>
                    ) : (
                      grantableForPermUser.map((ws) => (
                        <SelectItem key={ws.name} value={ws.name}>
                          {toLabel(ws.name)}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[100px]">
                <Select value={newPermLevel} onValueChange={setNewPermLevel}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVEL_KEYS.map((lvl) => (
                      <SelectItem key={lvl} value={lvl}>{lvl}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAddPermission} disabled={permBusy || !newPermWs}>
                {t('admin.grant')}
              </Button>
            </div>

            <div className="max-h-48 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('admin.colWorkspace')}</TableHead>
                    <TableHead>{t('admin.colLevel')}</TableHead>
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
                        {t('admin.noGrants')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    permissions.map((perm) => (
                      <TableRow key={perm.workspace}>
                        <TableCell className="font-medium">{toLabel(perm.workspace)}</TableCell>
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
                            tooltip={t('admin.revoke')}
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

      {/* Change-password sub-dialog */}
      <Dialog open={pwUser !== null} onOpenChange={(o) => { if (!o) setPwUser(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t('admin.changePasswordTitle', { username: pwUser?.username ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Input
              type={pwVisible ? 'text' : 'password'}
              placeholder={t('admin.newPasswordPlaceholder')}
              value={pwValue}
              autoFocus
              className="pr-9"
              onChange={(e) => setPwValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleChangePassword() }}
            />
            <button
              type="button"
              tabIndex={-1}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setPwVisible((v) => !v)}
              aria-label={pwVisible ? t('admin.hidePassword') : t('admin.showPassword')}
            >
              {pwVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwUser(null)} disabled={pwBusy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleChangePassword} disabled={pwBusy}>
              {pwBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
