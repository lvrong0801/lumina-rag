import { cn } from '@/lib/utils'
import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'

interface CollapsiblePanelProps {
  children: React.ReactNode
  className?: string
  /** Width when expanded (default 280px). Set to 0 to fully hide when collapsed. */
  defaultWidth?: number
  collapsedWidth?: number
  /** Whether the panel starts collapsed. */
  defaultCollapsed?: boolean
  /** Side the panel slides from. */
  side?: 'left' | 'right'
  /** Optional toggle control in the header. */
  header?: React.ReactNode
  /** Called when collapse state changes. */
  onCollapseChange?: (collapsed: boolean) => void
}

export default function CollapsiblePanel({
  children,
  className,
  defaultWidth = 280,
  collapsedWidth = 40,
  defaultCollapsed = false,
  side = 'right',
  header,
  onCollapseChange
}: CollapsiblePanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  const toggle = () => {
    setCollapsed(!collapsed)
    onCollapseChange?.(!collapsed)
  }

  const width = collapsed ? collapsedWidth : defaultWidth

  return (
    <div
      className={cn(
        'relative shrink-0 transition-[width] duration-200 ease-in-out',
        side === 'right' ? 'border-l' : 'border-r',
        className
      )}
      style={{ width: `${width}px` }}
      data-collapsed={collapsed}
    >
      {/* Toggle button */}
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'absolute z-10 flex h-6 w-6 items-center justify-center rounded-full border bg-background shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground',
          side === 'right' ? 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2' : 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2'
        )}
        aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
        aria-expanded={!collapsed}
      >
        <ChevronDownIcon
          className={cn(
            'size-3.5 transition-transform duration-200',
            collapsed ? (side === 'right' ? 'rotate-90' : '-rotate-90') : (side === 'right' ? '-rotate-90' : 'rotate-90')
          )}
        />
      </button>

      {/* Header content */}
      {header && (
        <div className={cn(
          'flex h-10 items-center justify-between border-b px-3 text-sm font-medium',
          collapsed && 'items-center justify-center px-1'
        )}>
          {!collapsed && header}
        </div>
      )}

      {/* Panel content — hidden when collapsed */}
      {!collapsed && (
        <div className="h-[calc(100%-slot(space(header,0)))]">
          {children}
        </div>
      )}
    </div>
  )
}
