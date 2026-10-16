import { useState } from 'react'
import { ChevronDownIcon, ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
// Removed unused CollapsiblePanel import
import ReferenceCard from '@/components/ui/ReferenceCard'
import { ScrollArea } from '@/components/ui/ScrollArea'

interface ReferenceItem {
  title: string
  file_path?: string
  page?: number | null
  confidence?: number
  snippet?: string
}

interface ReferencesPanelProps {
  references: ReferenceItem[]
  /** Whether the panel starts collapsed. */
  defaultCollapsed?: boolean
  className?: string
}

export default function ReferencesPanel({
  references,
  defaultCollapsed = false,
  className,
}: ReferencesPanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  if (!references || references.length === 0) return null

  return (
    <div className={cn('mt-2', className)}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className={cn(
          'flex w-full items-center justify-between rounded-lg border border-muted/40 bg-muted/30 px-3 py-2 text-left text-sm transition-colors',
          'hover:bg-accent hover:text-accent-foreground'
        )}
      >
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ExternalLinkIcon className="size-3.5 rotate-90" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-3.5 rotate-0" aria-hidden="true" />
          )}
          <span className="font-medium">
            {references.length} Reference{references.length > 1 ? 's' : ''}
          </span>
        </div>
      </button>

      {!collapsed && (
        <ScrollArea maxHeight={320} className="mt-1 rounded-lg border bg-background">
          <div className="flex flex-col gap-2 p-2">
            {references.map((ref, idx) => (
              <ReferenceCard
                key={`${ref.file_path || ref.title}-${idx}`}
                title={ref.title}
                filePath={ref.file_path}
                page={ref.page}
                confidence={ref.confidence}
                snippet={ref.snippet}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
