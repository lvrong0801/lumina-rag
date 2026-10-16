import { cva, type VariantProps } from 'class-variance-authority'
import { CheckCircle2, Clock, FileX, Loader2, Package } from 'lucide-react'
import { cn } from '@/lib/utils'

const statusBadgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      status: {
        completed: 'bg-success/10 text-success',
        parsing: 'bg-info/10 text-info',
        analyzing: 'bg-warning/10 text-warning',
        processing: 'bg-warning/10 text-warning',
        failed: 'bg-destructive/10 text-destructive',
        recycled: 'bg-muted/80 text-muted-foreground',
        guest: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
        admin: 'bg-primary/10 text-primary',
        manager: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
        viewer: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300'
      }
    },
    defaultVariants: {
      status: 'completed'
    }
  }
)

const statusIconMap = {
  completed: CheckCircle2,
  parsing: Loader2,
  analyzing: Clock,
  processing: Clock,
  failed: FileX,
  recycled: Package,
  guest: Package,
  admin: Package,
  manager: Package,
  viewer: Package
}

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
  VariantProps<typeof statusBadgeVariants> {
  showIcon?: boolean
}

export default function StatusBadge({
  status,
  children,
  showIcon = true,
  className,
  ...props
}: StatusBadgeProps) {
  const Icon = status ? statusIconMap[status as keyof typeof statusIconMap] : Package
  return (
    <div className={cn(statusBadgeVariants({ status }), className)} {...props}>
      {showIcon && Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {children}
    </div>
  )
}

export { StatusBadge }
