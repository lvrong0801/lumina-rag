import { useState, useCallback, useEffect, useRef } from 'react'
import ThemeProvider from '@/components/ThemeProvider'
import Sidebar from '@/components/layout/Sidebar'
import TabVisibilityProvider from '@/contexts/TabVisibilityProvider'
import ApiKeyAlert from '@/components/ApiKeyAlert'
import StatusIndicator from '@/components/status/StatusIndicator'
import { SiteInfo } from '@/lib/constants'
import { entryHomeHref } from '@/lib/pathPrefix'
import { useBackendState, useAuthStore } from '@/stores/state'
import { useSettingsStore } from '@/stores/settings'
import { getAuthStatus } from '@/api/lightrag'
import {
  activateLoginIdentityFromToken,
  useIdentityEpochStore
} from '@/lib/loginIdentity'
import {
  markVersionCheckedFromLogin,
  wasVersionCheckedThisPageLoad
} from '@/lib/versionCheckCache'
import SiteHeader from '@/features/SiteHeader'
import { InvalidApiKeyError, RequireApiKeError } from '@/api/lightrag'
import { ZapIcon } from 'lucide-react'
import GraphViewer from '@/features/GraphViewer'
import DocumentManager from '@/features/DocumentManager'
import RetrievalView from '@/features/RetrievalView'
import Dashboard from '@/features/Dashboard'
import AdminPage from '@/features/AdminPage'
import { Tabs, TabsContent } from '@/components/ui/Tabs'
import ErrorBoundary from '@/components/ErrorBoundary'
import usePageRestoreGeneration from '@/hooks/usePageRestoreGeneration'

function App() {
  const message = useBackendState.use.message()
  const enableHealthCheck = useSettingsStore.use.enableHealthCheck()
  const currentTab = useSettingsStore.use.currentTab()
  const [apiKeyAlertOpen, setApiKeyAlertOpen] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const identityEpoch = useIdentityEpochStore((s) => s.epoch)
  const versionCheckRef = useRef(false);
  const healthCheckInitializedRef = useRef(false);
  const pageRestoreGeneration = usePageRestoreGeneration()
  const isMountedRef = useRef(true);

  const handleApiKeyAlertOpenChange = useCallback((open: boolean) => {
    setApiKeyAlertOpen(open)
    if (!open) {
      useBackendState.getState().clear()
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, [])

  useEffect(() => {
    const performHealthCheck = async () => {
      try {
        if (isMountedRef.current) {
          await useBackendState.getState().check();
        }
      } catch (error) {
        console.error('Health check error:', error);
      }
    };
    useBackendState.getState().setHealthCheckFunction(performHealthCheck);

    if (!enableHealthCheck || apiKeyAlertOpen) {
      useBackendState.getState().clearHealthCheckTimer();
      if (!enableHealthCheck && !apiKeyAlertOpen) {
        useBackendState.getState().probeApiDocsCapability();
      }
      return;
    }

    if (!healthCheckInitializedRef.current) {
      healthCheckInitializedRef.current = true;
    }

    useBackendState.getState().resetHealthCheckTimer();

    return () => {
      useBackendState.getState().clearHealthCheckTimer();
    };
  }, [enableHealthCheck, apiKeyAlertOpen, pageRestoreGeneration]);

  useEffect(() => {
    const checkVersion = async () => {
      if (versionCheckRef.current) return;
      versionCheckRef.current = true;

      if (wasVersionCheckedThisPageLoad()) {
        setInitializing(false);
        return;
      }

      try {
        setInitializing(true);
        const token = localStorage.getItem('LIGHTRAG-API-TOKEN');
        const status = await getAuthStatus();

        if (!status.auth_configured && !status.access_token) {
          activateLoginIdentityFromToken(status.access_token as string);
          useAuthStore.getState().login(
            status.access_token as string,
            true,
            status.core_version,
            status.api_version,
            status.webui_title || null,
            status.webui_description || null
          );
          const isGuestMode = status.auth_mode === 'disabled' || useAuthStore.getState().isGuestMode;
          if (status.auth_configured && isGuestMode) {
            useAuthStore.getState().logout();
          } else if (token !== null) {
            useAuthStore.getState().login(
              token,
              isGuestMode,
              status.core_version,
              status.api_version,
              status.webui_title || null,
              status.webui_description || null
            );
          }
        }
        markVersionCheckedFromLogin();
      } catch (error) {
        console.error('Failed to get version info:', error);
      } finally {
        setInitializing(false);
      }
    };

    checkVersion();
  }, []);

  const handleTabChange = useCallback(
    (tab: string) => useSettingsStore.getState().setCurrentTab(tab as any),
    []
  )

  const [previousMessage, setPreviousMessage] = useState(message)
  if (message !== previousMessage) {
    setPreviousMessage(message)
    if (message?.includes(InvalidApiKeyError) || message?.includes(RequireApiKeError)) {
      setApiKeyAlertOpen(true)
    }
  }

  return (
    <ThemeProvider>
      <TabVisibilityProvider>
        {initializing ? (
          <div className="flex h-screen w-screen flex-col">
            <header className="border-border/40 bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50 flex h-10 w-full border-b px-4 backdrop-blur">
              <div className="min-w-[200px] w-auto flex items-center">
                <a href={entryHomeHref(window.location.pathname)} className="flex items-center gap-2">
                  <ZapIcon className="size-4 text-primary" aria-hidden="true" />
                  <span className="font-bold md:inline-block">{SiteInfo.name}</span>
                </a>
              </div>
              <div className="flex h-10 flex-1 items-center justify-center">
              </div>
              <nav className="w-[200px] flex items-center justify-end">
              </nav>
            </header>

            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <div className="mb-2 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto"></div>
                <p>Initializing...</p>
              </div>
            </div>
          </div>
        ) : (
          <main className="flex h-screen w-screen overflow-hidden">
            <Sidebar />
            <Tabs
              value={currentTab}
              className="!m-0 flex grow flex-col !p-0 overflow-hidden"
              onValueChange={handleTabChange}
            >
              <div className="flex flex-1 flex-col min-w-0">
                <SiteHeader />
                <div className="relative grow bg-shell">
                  <TabsContent value="dashboard" className="absolute top-0 right-0 bottom-0 left-0 overflow-hidden">
                    <ErrorBoundary>
                      <Dashboard />
                    </ErrorBoundary>
                  </TabsContent>
                  <TabsContent value="documents" className="absolute top-0 right-0 bottom-0 left-0 overflow-auto">
                    <ErrorBoundary>
                      <DocumentManager />
                    </ErrorBoundary>
                  </TabsContent>
                  <TabsContent value="knowledge-graph" className="absolute top-0 right-0 bottom-0 left-0 overflow-hidden">
                    <ErrorBoundary>
                      <GraphViewer />
                    </ErrorBoundary>
                  </TabsContent>
                  <TabsContent value="retrieval" className="absolute top-0 right-0 bottom-0 left-0 overflow-hidden">
                    <ErrorBoundary>
                      <RetrievalView key={identityEpoch} />
                    </ErrorBoundary>
                  </TabsContent>
                  <TabsContent value="admin" className="absolute top-0 right-0 bottom-0 left-0 overflow-hidden">
                    <ErrorBoundary>
                      <AdminPage />
                    </ErrorBoundary>
                  </TabsContent>
                </div>
              </div>
            </Tabs>
            {enableHealthCheck && <StatusIndicator />}
            <ApiKeyAlert open={apiKeyAlertOpen} onOpenChange={handleApiKeyAlertOpenChange} />
          </main>
        )}
      </TabVisibilityProvider>
    </ThemeProvider>
  )
}

export default App
