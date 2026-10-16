import { cn } from '@/lib/utils'
import { Card, CardDescription, CardTitle } from '@/components/ui/Card'
import type { LucideIcon } from 'lucide-react'
import { FilesIcon } from 'lucide-react'

interface EmptyStateProps extends React.ComponentPropsWithoutRef<typeof Card> {
  title: string
  description?: string
  icon?: LucideIcon
  action?: React.ReactNode
}

export default function EmptyState({
  title,
  description,
  icon: Icon = FilesIcon,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <Card
      className={cn(
        'flex h-full min-h-0 w-full flex-col items-center justify-center space-y-4 rounded-none border-0 bg-transparent p-8',
        className
      )}
      {...props}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="rounded-full border-2 border-dashed border-muted-foreground/20 p-4">
          <Icon className="size-8 text-muted-foreground/50" aria-hidden="true" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          {description && (
            <CardDescription className="text-sm text-muted-foreground">{description}</CardDescription>
          )}
        </div>
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </Card>
  )
}

export { EmptyState }
