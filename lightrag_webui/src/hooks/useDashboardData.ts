import { useState, useEffect, useCallback, useRef } from 'react'
import {
  checkHealth,
  getDocumentsPaginated,
  type LightragStatus,
  type DocStatusResponse,
} from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'

export interface DashboardData {
  health: LightragStatus | null
  healthError: string | null
  statusCounts: Record<string, number>
  recentDocuments: DocStatusResponse[]
  totalDocuments: number
  isLoading: boolean
  isRefreshing: boolean
  lastUpdated: Date | null
  refresh: () => Promise<void>
}

/**
 * Loads everything the dashboard needs: /health plus the first page of
 * documents (whose response body carries both the doc rows and the global
 * status_counts). Re-fetches on workspace switch and every 30 s.
 */
export function useDashboardData(): DashboardData {
  const currentWorkspace = useSettingsStore.use.currentWorkspace()
  const [health, setHealth] = useState<LightragStatus | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [recentDocuments, setRecentDocuments] = useState<DocStatusResponse[]>([])
  const [totalDocuments, setTotalDocuments] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const isMountedRef = useRef(true)

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setIsRefreshing(true)
    } else {
      setIsLoading(true)
    }

    const [healthResult, docsResult] = await Promise.allSettled([
      checkHealth(),
      getDocumentsPaginated({
        page: 1,
        page_size: 10, // minimum allowed by the backend
        status_filter: null,
        sort_field: 'updated_at',
        sort_direction: 'desc',
      }),
    ])

    if (!isMountedRef.current) return

    if (healthResult.status === 'fulfilled') {
      const data = healthResult.value
      if (data.status === 'healthy') {
        setHealth(data as LightragStatus)
        setHealthError(null)
      } else {
        setHealth(null)
        setHealthError((data as any).message || 'Unknown error')
      }
    } else {
      setHealth(null)
      setHealthError(healthResult.reason?.message || 'Failed to check health')
    }

    if (docsResult.status === 'fulfilled') {
      setRecentDocuments(docsResult.value.documents || [])
      setTotalDocuments(docsResult.value.pagination?.total_count || 0)
      setStatusCounts(docsResult.value.status_counts || {})
    }

    setLastUpdated(new Date())
    setIsLoading(false)
    setIsRefreshing(false)
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    // Defer past the synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void fetchData(), 0)

    const interval = setInterval(() => {
      if (isMountedRef.current) {
        void fetchData(true)
      }
    }, 30000)

    return () => {
      isMountedRef.current = false
      clearTimeout(timer)
      clearInterval(interval)
    }
    // Workspace switch re-fetches: doc stats are workspace-scoped.
  }, [fetchData, currentWorkspace])

  const refresh = useCallback(async () => {
    await fetchData(true)
  }, [fetchData])

  return {
    health,
    healthError,
    statusCounts,
    recentDocuments,
    totalDocuments,
    isLoading,
    isRefreshing,
    lastUpdated,
    refresh,
  }
}
