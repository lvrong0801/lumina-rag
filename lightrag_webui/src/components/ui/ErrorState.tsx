import { AlertTriangle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardDescription, CardTitle } from '@/components/ui/Card'
import Button from '@/components/ui/Button'

interface ErrorStateProps extends React.ComponentPropsWithoutRef<typeof Card> {
  title: string
  description?: string
  onRetry?: () => void
  retryLabel?: string
  destructive?: boolean
}

export default function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = 'Retry',
  destructive = true,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <Card
      className={cn(
        'flex h-full min-h-0 w-full flex-col items-center justify-center space-y-4 rounded-none border-0 bg-transparent p-8',
        className
      )}
      {...props}
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <div className={cn(
          'rounded-full border-2 p-4',
          destructive ? 'border-destructive/30 bg-destructive/10' : 'border-muted/30 bg-muted/10'
        )}>
          <AlertTriangle className={cn(
            'size-8',
            destructive ? 'text-destructive' : 'text-muted-foreground'
          )} aria-hidden="true" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          {description && (
            <CardDescription className="text-sm text-muted-foreground">{description}</CardDescription>
          )}
        </div>
      </div>
      {onRetry && (
        <Button
          variant={destructive ? 'destructive' : 'outline'}
          size="sm"
          onClick={onRetry}
          className="gap-2"
        >
          <RefreshCw className="size-4" />
          {retryLabel}
        </Button>
      )}
    </Card>
  )
}

export { ErrorState }
