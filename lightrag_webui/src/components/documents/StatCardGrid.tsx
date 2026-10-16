import * as React from 'react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/Card'
import { StatCard } from '@/components/ui/StatCard'
import { FilesIcon, CheckCircle2Icon, HardDriveIcon, ClockIcon } from 'lucide-react'

interface StatCardGridProps extends React.ComponentPropsWithoutRef<typeof Card> {
  /** Total documents count */
  total: number
  /** Parsed/completed document count */
  parsed: number
  /** Storage space used, human readable. */
  size: string
  /** Last updated timestamp (pre-formatted string). */
  updatedAt?: string | null
  /** Optional loading state fallback (skeleton). */
  loading?: boolean
}

export default function StatCardStrip({
  total,
  parsed,
  size,
  updatedAt,
  loading = false,
  className,
  ...props
}: StatCardGridProps) {
  const formatTotal = (n: number) => n.toLocaleString()
  const formatTrend = (value: number, total: number | undefined) => (total ?? 0) === 0 ? 0 : Math.round((value / (total ?? 1)) * 100)

  const parsedPct = formatTrend(parsed, total)

  return (
    <Card className={cn('grid grid-cols-2 gap-4 sm:grid-cols-4', className)} {...props}>
      <CardContent className="p-4 col-span-1">
        <StatCard
          title="Total Documents"
          value={loading ? '—' : formatTotal(total)}
          icon={FilesIcon}
          loading={loading}
        />
      </CardContent>
      <CardContent className="p-4 col-span-1">
        <StatCard
          title="Parsed"
          value={loading ? '—' : `${formatTotal(parsed)} (${parsedPct}%)`}
          trend={loading ? 0 : parsedPct}
          trendLabel="of total"
          icon={CheckCircle2Icon}
          loading={loading}
        />
      </CardContent>
      <CardContent className="p-4 col-span-1">
        <StatCard
          title="Storage Used"
          value={loading ? '—' : size}
          icon={HardDriveIcon}
          loading={loading}
        />
      </CardContent>
      <CardContent className="p-4 col-span-1">
        <StatCard
          title="Last Updated"
          value={loading ? '—' : updatedAt || '—'}
          icon={ClockIcon}
          loading={loading}
        />
      </CardContent>
    </Card>
  )
}
