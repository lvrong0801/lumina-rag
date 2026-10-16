import { cn } from '@/lib/utils'
import { LoaderIcon } from 'lucide-react'

interface LoadingSpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string
  size?: 'sm' | 'md' | 'lg'
}

export default function LoadingSpinner({
  label = 'Loading...',
  size = 'md',
  className,
  ...props
}: LoadingSpinnerProps) {
  const sizeClass = {
    sm: 'size-4',
    md: 'size-6',
    lg: 'size-8'
  }[size]

  return (
    <div className={cn('flex items-center justify-center gap-2', className)} {...props}>
      <LoaderIcon className={cn('animate-spin', sizeClass)} aria-hidden="true" />
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  )
}

export { LoadingSpinner }
