import Button from '@/components/ui/Button'
import { entryHomeHref } from '@/lib/pathPrefix'
import { SiteInfo, backendBaseUrl } from '@/lib/constants'
import { TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore, useBackendState } from '@/stores/state'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { navigationService } from '@/services/navigation'
import { canManageUsers } from '@/lib/rbac'
import { ZapIcon, LogOutIcon, BookOpenIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import TouchDescriptionPopover from '@/components/ui/TouchDescriptionPopover'

interface NavigationTabProps {
  value: string
  currentTab: string
  children: React.ReactNode
}

function NavigationTab({ value, currentTab, children }: NavigationTabProps) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'cursor-pointer px-2 py-1 transition-all',
        currentTab === value ? '!bg-primary !text-primary-foreground' : 'hover:bg-background/60'
      )}
    >
      {children}
    </TabsTrigger>
  )
}

// Narrow-viewport fallback: the sidebar (md:flex) owns navigation on desktop,
// but below md the aside is display:none and these tabs are the only switcher.
function TabsNavigation() {
  const currentTab = useSettingsStore.use.currentTab()
  const { role } = useAuthStore()
  const { t } = useTranslation()

  return (
    <div className="flex h-8 self-center md:hidden">
      <TabsList className="h-full gap-2">
        <NavigationTab value="dashboard" currentTab={currentTab}>
          {t('header.dashboard')}
        </NavigationTab>
        <NavigationTab value="documents" currentTab={currentTab}>
          {t('header.documents')}
        </NavigationTab>
        <NavigationTab value="knowledge-graph" currentTab={currentTab}>
          {t('header.knowledgeGraph')}
        </NavigationTab>
        <NavigationTab value="retrieval" currentTab={currentTab}>
          {t('header.retrieval')}
        </NavigationTab>
        {canManageUsers(role) && (
          <NavigationTab value="admin" currentTab={currentTab}>
            {t('header.admin')}
          </NavigationTab>
        )}
      </TabsList>
    </div>
  )
}

export default function SiteHeader() {
  const { t } = useTranslation()
  const { isGuestMode, username, role, webuiTitle, webuiDescription } = useAuthStore()
  const theme = useSettingsStore.use.theme()
  // Tri-state on purpose — 'unknown' (no successful /health yet) hides the
  // entry point rather than guessing; see apiDocsCapability in stores/state.ts.
  const apiDocsCapability = useBackendState.use.apiDocsCapability()
  // /docs renders Swagger UI itself; the theme query param keeps it visually
  // consistent with the WebUI ('system' falls back to the OS preference).
  const apiDocsUrl = `${backendBaseUrl}/docs?theme=${theme === 'system' ? 'auto' : theme}`

  const handleLogout = () => {
    navigationService.navigateToUnauthenticated();
  }

  return (
    <header className="border-border/40 bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50 flex h-12 w-full border-b px-4 backdrop-blur">
      <div className="min-w-[200px] w-auto flex items-center">
        {/* Document-relative brand link: under HashRouter the pathname always
            names this entry, so this resolves back to THIS entry — never a
            cross-entry jump, under any proxy prefix or the dev server's
            file-per-entry layout (see entryHomeHref). */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={entryHomeHref(window.location.pathname)} className="flex items-center">
                <ZapIcon className="mr-2 size-4 text-primary" aria-hidden="true" />
                <span className="font-bold md:inline-block">{SiteInfo.name}</span>
                {webuiTitle && (
                  <>
                    <span className="mx-1 text-xs text-gray-500 dark:text-gray-400" aria-hidden="true">|</span>
                    <span className="text-sm font-medium">{webuiTitle}</span>
                  </>
                )}
              </a>
            </TooltipTrigger>
            {webuiDescription && (
              <TooltipContent side="bottom">
                {webuiDescription}
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        <TouchDescriptionPopover description={webuiDescription} />
      </div>

      <div className="flex h-12 flex-1 items-center justify-center">
        <TabsNavigation />
        {isGuestMode && (
          <div className="ml-2 self-center px-2 py-1 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 rounded-md">
            {t('login.guestMode', 'Guest Mode')}
          </div>
        )}
      </div>

      <nav className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          {!isGuestMode && role && role !== 'guest' && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] leading-4',
                role === 'admin' && 'bg-primary/10 text-primary',
                role === 'manager' && 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
                role === 'viewer' && 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300'
              )}
              title={t('header.role', 'Role')}
            >
              {role}
            </span>
          )}
          {apiDocsCapability === 'available' && (
            <Button variant="ghost" size="icon" side="bottom" tooltip={t('header.apiDocs')}>
              <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer">
                <BookOpenIcon className="size-4" aria-hidden="true" />
              </a>
            </Button>
          )}
          {!isGuestMode && (
            <Button
              variant="ghost"
              size="icon"
              side="bottom"
              tooltip={`${t('header.logout')} (${username})`}
              onClick={handleLogout}
            >
              <LogOutIcon className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </nav>
    </header>
  )
}
