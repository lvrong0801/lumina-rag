/**
 * Dashboard — overview page modelled on the cogent-rag reference layout:
 * stat cards → system configuration → system health → recent documents.
 * All data comes from our own backend (/health + /documents/paginated,
 * loaded by useDashboardData); strings go through i18next (zh-first).
 */
import { useTranslation } from 'react-i18next'
import {
  FileText,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Clock,
  RefreshCw,
  Activity,
  Brain,
  Database,
  ArrowRight,
  Server,
  Cpu,
  HardDrive,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import Badge from '@/components/ui/Badge'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useSettingsStore } from '@/stores/settings'
import type { DocStatusResponse } from '@/api/lightrag'

// ─── Stat Card ───────────────────────────────────────────────
interface StatCardProps {
  title: string
  value: number
  icon: React.ReactNode
  description?: string
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info'
}

const variantStyles = {
  default: 'bg-muted/50 text-muted-foreground',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'bg-primary/10 text-primary',
}

function StatCard({ title, value, icon, description, variant = 'default' }: StatCardProps) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold tracking-tight">{value.toLocaleString()}</p>
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <div className={`rounded-xl p-3 ${variantStyles[variant]}`}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Status Badge ────────────────────────────────────────────
function DocStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const key = status === 'processed' ? 'completed' : status
  const known = ['completed', 'preprocessed', 'parsing', 'analyzing', 'processing', 'pending', 'failed']
  const label = known.includes(key)
    ? t(`documentPanel.documentManager.status.${key}`)
    : status
  const variant =
    status === 'processed' ? 'default'
      : status === 'failed' ? 'destructive'
        : ['pending', 'preprocessed'].includes(status) ? 'outline'
          : 'secondary'
  return <Badge variant={variant} className="px-2 py-0 text-[11px]">{label}</Badge>
}

// ─── Config Item ─────────────────────────────────────────────
function ConfigItem({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-b-0 border-border/50">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-sm font-medium truncate">{value || '—'}</p>
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────
const count = (counts: Record<string, number>, ...keys: string[]) =>
  keys.reduce((sum, k) => sum + (counts[k] || 0), 0)

const displayFileName = (doc: DocStatusResponse, maxLength = 40): string => {
  if (!doc.file_path || doc.file_path.trim() === '') return doc.id
  const fileName = doc.file_path.split('/').pop() || doc.id
  return fileName.length > maxLength ? `${fileName.slice(0, maxLength)}…` : fileName
}

// ─── Dashboard Page ──────────────────────────────────────────
export default function Dashboard() {
  const { t } = useTranslation()
  const setCurrentTab = useSettingsStore.use.setCurrentTab()
  const currentWorkspace = useSettingsStore.use.currentWorkspace()
  const {
    health,
    healthError,
    statusCounts,
    recentDocuments,
    totalDocuments,
    isLoading,
    isRefreshing,
    lastUpdated,
    refresh,
  } = useDashboardData()

  // Our status model (api/lightrag.ts DocStatus) — tolerate uppercase keys.
  const completed = count(statusCounts, 'processed', 'PROCESSED')
  const inFlight = count(
    statusCounts,
    'parsing', 'PARSING', 'analyzing', 'ANALYZING',
    'processing', 'PROCESSING', 'pending', 'PENDING',
    'preprocessed', 'PREPROCESSED'
  )
  const failed = count(statusCounts, 'failed', 'FAILED')

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="space-y-3 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('dashboard.loading')}</p>
        </div>
      </div>
    )
  }

  const config = health?.configuration
  // The badge must mirror what the WorkspaceSelector actually applies: a
  // non-empty client selection wins, '' falls back to the server default.
  const activeWorkspace = currentWorkspace || config?.workspace || 'default'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('dashboard.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.subtitle')}</p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground">
                {t('dashboard.lastUpdated', { time: lastUpdated.toLocaleTimeString() })}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {t('dashboard.refresh')}
            </Button>
          </div>
        </div>

        {/* Health Error Banner */}
        {healthError && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="flex items-center gap-3 p-4">
              <AlertTriangle className="h-5 w-5 flex-shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">{t('dashboard.healthError')}</p>
                <p className="text-xs text-destructive/80">{healthError}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <StatCard
            title={t('dashboard.stats.total')}
            value={totalDocuments}
            icon={<FileText className="h-5 w-5" />}
            variant="info"
          />
          <StatCard
            title={t('dashboard.stats.completed')}
            value={completed}
            icon={<CheckCircle2 className="h-5 w-5" />}
            variant="success"
          />
          <StatCard
            title={t('dashboard.stats.processing')}
            value={inFlight}
            icon={<Loader2 className="h-5 w-5" />}
            variant="warning"
          />
          <StatCard
            title={t('dashboard.stats.failed')}
            value={failed}
            icon={<AlertTriangle className="h-5 w-5" />}
            variant="danger"
          />
          <StatCard
            title={t('dashboard.stats.pipeline')}
            value={health?.pipeline_busy ? 1 : 0}
            icon={<Activity className="h-5 w-5" />}
            description={health?.pipeline_busy ? t('dashboard.stats.pipelineBusy') : t('dashboard.stats.pipelineIdle')}
            variant={health?.pipeline_busy ? 'warning' : 'default'}
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* System Configuration - Left 2 columns */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4" />
                {t('dashboard.systemConfig.title')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('dashboard.systemConfig.llm')}
                  </h4>
                  <ConfigItem icon={<Brain className="h-4 w-4" />} label={t('dashboard.systemConfig.model')} value={config?.llm_model} />
                  <ConfigItem icon={<Cpu className="h-4 w-4" />} label={t('dashboard.systemConfig.binding')} value={config?.llm_binding} />

                  <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('dashboard.systemConfig.embedding')}
                  </h4>
                  <ConfigItem icon={<Brain className="h-4 w-4" />} label={t('dashboard.systemConfig.model')} value={config?.embedding_model} />
                  <ConfigItem icon={<Cpu className="h-4 w-4" />} label={t('dashboard.systemConfig.binding')} value={config?.embedding_binding} />
                </div>
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('dashboard.systemConfig.storage')}
                  </h4>
                  <ConfigItem icon={<HardDrive className="h-4 w-4" />} label={t('dashboard.systemConfig.kvStorage')} value={config?.kv_storage} />
                  <ConfigItem icon={<Database className="h-4 w-4" />} label={t('dashboard.systemConfig.graphStorage')} value={config?.graph_storage} />
                  <ConfigItem icon={<HardDrive className="h-4 w-4" />} label={t('dashboard.systemConfig.vectorStorage')} value={config?.vector_storage} />

                  {config?.enable_rerank && (
                    <>
                      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('dashboard.systemConfig.reranker')}
                      </h4>
                      <ConfigItem icon={<Brain className="h-4 w-4" />} label={t('dashboard.systemConfig.model')} value={config?.rerank_model} />
                    </>
                  )}

                  {(health?.core_version || health?.api_version) && (
                    <>
                      <h4 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('dashboard.systemConfig.version')}
                      </h4>
                      <ConfigItem
                        icon={<Activity className="h-4 w-4" />}
                        label="Core / API"
                        value={`${health.core_version || '—'} / ${health.api_version || '—'}`}
                      />
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* System Health - Right column */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4" />
                {t('dashboard.health.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                <span className="text-sm font-medium">{t('dashboard.health.status')}</span>
                {health ? (
                  <Badge variant="default" className="bg-emerald-500 hover:bg-emerald-500">
                    {t('dashboard.health.healthy')}
                  </Badge>
                ) : (
                  <Badge variant="destructive">{t('dashboard.health.unhealthy')}</Badge>
                )}
              </div>

              <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                <span className="text-sm font-medium">{t('dashboard.health.pipeline')}</span>
                <Badge variant={health?.pipeline_busy ? 'secondary' : 'outline'}>
                  {health?.pipeline_busy ? t('dashboard.stats.pipelineBusy') : t('dashboard.stats.pipelineIdle')}
                </Badge>
              </div>

              {(config?.workspace !== undefined || currentWorkspace !== '') && (
                <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                  <span className="text-sm font-medium">{t('dashboard.health.workspace')}</span>
                  <span className="max-w-[140px] truncate font-mono text-sm text-muted-foreground">
                    {activeWorkspace}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Documents */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" />
              {t('dashboard.recentDocs.title')}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setCurrentTab('documents')} className="text-xs">
              {t('dashboard.recentDocs.viewAll')}
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            {recentDocuments.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                <FileText className="mx-auto mb-3 h-10 w-10 opacity-30" />
                <p className="text-sm">{t('dashboard.recentDocs.empty')}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2 font-medium">{t('documentPanel.documentManager.columns.fileName')}</th>
                      <th className="pb-2 font-medium">{t('documentPanel.documentManager.columns.status')}</th>
                      <th className="pb-2 text-right font-medium">{t('documentPanel.documentManager.columns.length')}</th>
                      <th className="pb-2 text-right font-medium">{t('documentPanel.documentManager.columns.chunks')}</th>
                      <th className="pb-2 text-right font-medium">{t('documentPanel.documentManager.columns.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentDocuments.map((doc) => (
                      <tr key={doc.id} className="border-b transition-colors last:border-b-0 hover:bg-muted/30">
                        <td className="max-w-[300px] truncate py-2.5 pr-4 font-medium">
                          {displayFileName(doc)}
                        </td>
                        <td className="py-2.5 pr-4">
                          <DocStatusBadge status={doc.status} />
                        </td>
                        <td className="py-2.5 pr-4 text-right text-muted-foreground">
                          {doc.content_length?.toLocaleString() || '—'}
                        </td>
                        <td className="py-2.5 pr-4 text-right text-muted-foreground">
                          {doc.chunks_count ?? '—'}
                        </td>
                        <td className="whitespace-nowrap py-2.5 text-right text-muted-foreground">
                          {new Date(doc.updated_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
