import * as React from 'react'
import { cn } from '@/lib/utils'

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  maxHeight?: number | string
  className?: string
  children: React.ReactNode
}

export default function ScrollArea({
  maxHeight = 400,
  className,
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      className={cn('overflow-y-auto', className)}
      style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
      {...props}
    >
      <div className="relative">
        {children}
      </div>
    </div>
  )
}

export { ScrollArea }
