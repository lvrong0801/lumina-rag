/**
 * AdminPage — 系统管理 page (admin-only sidebar tab).
 *
 * Sub-tabs, modelled on the cogent-rag reference layout:
 *   偏好设置  — language + theme (same settings as the sidebar popover)
 *   用户管理  — AdminUserPanel (/admin/users)
 *   角色划分  — role/permission matrix with live member counts
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  SettingsIcon,
  UsersIcon,
  ShieldCheckIcon,
  LockIcon,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/Table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import AdminUserPanel from '@/components/admin/AdminUserPanel'

import { listUsers, type AdminUser } from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/state'
import { canManageUsers } from '@/lib/rbac'
import { cn } from '@/lib/utils'

// ─── Preferences sub-tab ────────────────────────────────────────────────────
function PreferencesPanel() {
  const { t } = useTranslation()
  const language = useSettingsStore.use.language()
  const setLanguage = useSettingsStore.use.setLanguage()
  const theme = useSettingsStore.use.theme()
  const setTheme = useSettingsStore.use.setTheme()

  return (
    <div className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            {t('settings.language')}
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {language.toUpperCase()}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={language} onValueChange={(v) => setLanguage(v as any)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh">中文</SelectItem>
              <SelectItem value="fr">Français</SelectItem>
              <SelectItem value="ar">العربية</SelectItem>
              <SelectItem value="zh_TW">繁體中文</SelectItem>
              <SelectItem value="ru">Русский</SelectItem>
              <SelectItem value="ja">日本語</SelectItem>
              <SelectItem value="de">Deutsch</SelectItem>
              <SelectItem value="uk">Українська</SelectItem>
              <SelectItem value="ko">한국어</SelectItem>
              <SelectItem value="vi">Tiếng Việt</SelectItem>
              <SelectItem value="id">Bahasa Indonesia</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            {t('settings.theme')}
            <span className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-normal',
              theme === 'dark'
                ? 'bg-slate-800 text-slate-200'
                : theme === 'light'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-muted text-muted-foreground'
            )}>
              {theme === 'dark' ? '● Dark' : theme === 'light' ? '○ Light' : '◐ System'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={theme} onValueChange={(v) => setTheme(v as any)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t('settings.light')}</SelectItem>
              <SelectItem value="dark">{t('settings.dark')}</SelectItem>
              <SelectItem value="system">{t('settings.system')}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Roles sub-tab ───────────────────────────────────────────────────────────
const ROLE_ORDER = ['admin', 'manager', 'viewer', 'guest'] as const

const ROLE_STYLES: Record<string, string> = {
  admin: 'bg-primary/10 text-primary',
  manager: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  viewer: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  guest: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
}

function RolesPanel() {
  const { t } = useTranslation()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setUsers(await listUsers())
    } catch (err) {
      console.error('[AdminPage/Roles] load users failed:', err)
      toast.error(t('admin.loadUsersError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load])

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('adminPage.roles.globalTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">{t('adminPage.roles.role')}</TableHead>
                <TableHead>{t('adminPage.roles.description')}</TableHead>
                <TableHead className="w-20 text-right">{t('adminPage.roles.members')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLE_ORDER.map((role) => (
                <TableRow key={role}>
                  <TableCell>
                    <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', ROLE_STYLES[role])}>
                      {role}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t(`adminPage.roles.desc.${role}`)}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {loading ? '…' : users.filter((u) => u.role === role).length}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('adminPage.roles.accessTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">{t('adminPage.roles.level')}</TableHead>
                <TableHead>{t('adminPage.roles.description')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(['read', 'write', 'admin'] as const).map((level) => (
                <TableRow key={level}>
                  <TableCell>
                    <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', ROLE_STYLES[level === 'read' ? 'guest' : level === 'write' ? 'manager' : 'admin'])}>
                      {level}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t(`adminPage.roles.accessDesc.${level}`)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const { t } = useTranslation()
  const { role } = useAuthStore()

  if (!canManageUsers(role)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <LockIcon className="h-10 w-10 opacity-40" aria-hidden="true" />
        <p className="text-sm">{t('adminPage.forbidden')}</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1400px] p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">{t('adminPage.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('adminPage.subtitle')}</p>
        </div>
        <Tabs defaultValue="preferences" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="preferences" className="gap-1.5">
              <SettingsIcon className="size-4" />{t('adminPage.tabs.preferences')}
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-1.5">
              <UsersIcon className="size-4" />{t('adminPage.tabs.users')}
            </TabsTrigger>
            <TabsTrigger value="roles" className="gap-1.5">
              <ShieldCheckIcon className="size-4" />{t('adminPage.tabs.roles')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="preferences" className="h-auto min-h-0">
            <PreferencesPanel />
          </TabsContent>
          <TabsContent value="users" className="h-auto min-h-0">
            <AdminUserPanel />
          </TabsContent>
          <TabsContent value="roles" className="h-auto min-h-0">
            <RolesPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
