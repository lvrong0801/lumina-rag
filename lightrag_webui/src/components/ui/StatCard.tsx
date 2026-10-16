import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/Card'
import type { LucideIcon } from 'lucide-react'
import { TrendingDown, TrendingUp } from 'lucide-react'

interface StatCardProps extends React.ComponentPropsWithoutRef<typeof Card> {
  title: string
  value?: string | number
  icon?: LucideIcon
  trend?: number | null
  trendLabel?: string
  loading?: boolean
}

export default function StatCard({
  title,
  value,
  icon: Icon,
  trend,
  trendLabel,
  loading = false,
  className,
  ...props
}: StatCardProps) {
  return (
    <Card className={cn('p-6', loading && 'animate-pulse', className)} {...props}>
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <CardContent className="m-0 p-0">
            <div className="text-2xl font-bold tracking-tight">
              {loading ? (
                <span className="inline-block h-8 w-20 rounded bg-muted" />
              ) : (
                value
              )}
            </div>
          </CardContent>
          {trend !== null && trend !== undefined && (
            <div className="flex items-center gap-1 text-xs">
              {trend > 0 ? (
                <TrendingUp className="size-3 text-success" />
              ) : (
                <TrendingDown className="size-3 text-destructive" />
              )}
              <span className={trend > 0 ? 'text-success' : 'text-destructive'}>
                {Math.abs(trend)}%
              </span>
              {trendLabel && (
                <span className="text-muted-foreground">{trendLabel}</span>
              )}
            </div>
          )}
        </div>
        {Icon && (
          <div className="rounded-lg bg-muted/50 p-3">
            <Icon className="size-5 text-muted-foreground" />
          </div>
        )}
      </div>
    </Card>
  )
}

export { StatCard }
