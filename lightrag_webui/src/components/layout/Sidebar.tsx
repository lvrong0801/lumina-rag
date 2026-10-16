import { useState } from 'react'
import {
  FileTextIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  SettingsIcon,
  UsersIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ZapIcon
} from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/state'
import { useTranslation } from 'react-i18next'
import { entryHomeHref } from '@/lib/pathPrefix'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import Button from '@/components/ui/Button'
import AdminUserDialog from '@/components/admin/AdminUserDialog'
import { canManageUsers } from '@/lib/rbac'
import { cn } from '@/lib/utils'

/** Navigation tab definitions for the sidebar. */
const TABS = [
  { value: 'documents', icon: FileTextIcon, labelKey: 'header.documents' },
  { value: 'retrieval', icon: MessageSquareTextIcon, labelKey: 'header.retrieval' },
  { value: 'knowledge-graph', icon: NetworkIcon, labelKey: 'header.knowledgeGraph' }
]

export default function Sidebar() {
  const { t } = useTranslation()
  const { role } = useAuthStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)

  const language = useSettingsStore.use.language()
  const setLanguage = useSettingsStore.use.setLanguage()
  const theme = useSettingsStore.use.theme()
  const setTheme = useSettingsStore.use.setTheme()
  const currentTab = useSettingsStore.use.currentTab()
  const collapsed = useSettingsStore.use.sidebarCollapsed()
  const setSidebarCollapsed = useSettingsStore.use.setSidebarCollapsed()

  const collapseLabel = collapsed ? t('header.expandSidebar') : t('header.collapseSidebar')

  return (
    <TooltipProvider>
      <aside
        className={cn(
          'hidden md:flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
          'transition-[width] duration-200 overflow-hidden',
          collapsed ? 'w-14' : 'w-56'
        )}
      >
        {/* Brand + collapse toggle */}
        <div
          className={cn(
            'flex h-12 shrink-0 items-center border-b',
            collapsed ? 'justify-center px-0' : 'justify-between gap-2 px-4'
          )}
        >
          {!collapsed && (
            <a href={entryHomeHref(window.location.pathname)} className="flex min-w-0 items-center gap-2">
              <ZapIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <span className="truncate text-base font-semibold tracking-tight">LightRAG</span>
            </a>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => setSidebarCollapsed(!collapsed)}
            tooltip={collapseLabel}
            side="right"
            aria-label={collapseLabel}
          >
            {collapsed
              ? <PanelLeftOpenIcon className="size-4" aria-hidden="true" />
              : <PanelLeftCloseIcon className="size-4" aria-hidden="true" />}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
          <ul className="flex flex-col gap-1">
            {TABS.map(({ value, icon: Icon, labelKey }) => {
              const item = (
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    currentTab === value
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    collapsed && 'justify-center px-0'
                  )}
                  aria-label={collapsed ? t(labelKey) : undefined}
                  onClick={() => useSettingsStore.getState().setCurrentTab(value as any)}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{t(labelKey)}</span>}
                </button>
              )
              return (
                <li key={value}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{item}</TooltipTrigger>
                      <TooltipContent side="right">{t(labelKey)}</TooltipContent>
                    </Tooltip>
                  ) : (
                    item
                  )}
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Bottom settings */}
        <div className="shrink-0 border-t p-2">
          <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
            {(() => {
              const settingsTrigger = (
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                      collapsed && 'justify-center px-0'
                    )}
                    aria-label={collapsed ? t('header.appSettings') : undefined}
                  >
                    <SettingsIcon className="size-4 shrink-0" aria-hidden="true" />
                    {!collapsed && <span>{t('header.appSettings')}</span>}
                  </button>
                </PopoverTrigger>
              )
              return collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>{settingsTrigger}</TooltipTrigger>
                  <TooltipContent side="right">{t('header.appSettings')}</TooltipContent>
                </Tooltip>
              ) : (
                settingsTrigger
              )
            })()}
            <PopoverContent side="right" align="end" className="w-60">
              <div className="flex flex-col gap-4">
                {/* Language */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">{t('settings.language')}</label>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {language.toUpperCase()}
                    </span>
                  </div>
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
                </div>

                {/* Theme */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">{t('settings.theme')}</label>
                    <span className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                      theme === 'dark'
                        ? 'bg-slate-800 text-slate-200'
                        : theme === 'light'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-muted text-muted-foreground'
                    )}>
                      {theme === 'dark' ? '● Dark' : theme === 'light' ? '○ Light' : '◐ System'}
                    </span>
                  </div>
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
                </div>

                {/* User administration (admin only) */}
                {canManageUsers(role) && (
                  <>
                    <div className="border-t -mx-2" />
                    <button
                      type="button"
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
                      onClick={() => {
                        setSettingsOpen(false)
                        setAdminOpen(true)
                      }}
                    >
                      <UsersIcon className="size-4" aria-hidden="true" />
                      <span>{t('header.userAdmin', 'User administration')}</span>
                    </button>
                  </>
                )}
              </div>
            </PopoverContent>
          </Popover>

          <AdminUserDialog open={adminOpen} onOpenChange={setAdminOpen} />
        </div>
      </aside>
    </TooltipProvider>
  )
}
