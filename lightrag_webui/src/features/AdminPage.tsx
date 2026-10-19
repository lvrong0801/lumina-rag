/**
 * AdminPage — 系统管理 page (admin-only sidebar tab).
 *
 * Sub-tabs:
 *   偏好设置  — language + theme (same settings as the sidebar popover)
 *   用户管理  — AdminUserPanel (/admin/users), incl. role assignment
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SettingsIcon,
  UsersIcon,
  LockIcon,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs'
import AdminUserPanel from '@/components/admin/AdminUserPanel'

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

// ─── Page ────────────────────────────────────────────────────────────────────
export default function AdminPage() {
  const { t } = useTranslation()
  const { role } = useAuthStore()
  const [subTab, setSubTab] = useState<'preferences' | 'users'>('preferences')

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
        {/* Content is rendered conditionally instead of nested TabsContent:
            a force-mounted nested panel could re-show itself while the outer
            (inactive) panel is hidden, and inactive panels keep layout space. */}
        <Tabs value={subTab} onValueChange={(v) => setSubTab(v as typeof subTab)} className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="preferences" className="gap-1.5">
              <SettingsIcon className="size-4" />{t('adminPage.tabs.preferences')}
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-1.5">
              <UsersIcon className="size-4" />{t('adminPage.tabs.users')}
            </TabsTrigger>
          </TabsList>
          {subTab === 'preferences' ? <PreferencesPanel /> : <AdminUserPanel />}
        </Tabs>
      </div>
    </div>
  )
}
