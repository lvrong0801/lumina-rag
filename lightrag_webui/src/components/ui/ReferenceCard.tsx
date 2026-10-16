import { cn } from '@/lib/utils'
import { FileTextIcon } from 'lucide-react'

interface ReferenceCardProps {
  /** Document title. */
  title: string
  /** File path / source ID. */
  filePath?: string
  /** Page number within the document (1-based). */
  page?: number | null
  /** Confidence score (0-1). */
  confidence?: number
  /** Snippet / citation text. */
  snippet?: string
  /** Called when the user clicks the reference link. */
  onClick?: () => void
  /** Additional className for custom styling. */
  className?: string
}

export default function ReferenceCard({
  title,
  filePath,
  page,
  confidence,
  snippet,
  onClick,
  className,
}: ReferenceCardProps) {
  const displayTitle = title || filePath?.split('/').pop() || 'Unknown source'
  const numericConfidence = confidence !== undefined ? Math.round(confidence * 100) : null

  return (
    <button
      type="button"
      role="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        'hover:bg-accent/40 hover:shadow-sm',
        className
      )}
      aria-label={displayTitle}
    >
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <FileTextIcon className="size-4" aria-hidden="true" />
      </div>

      <div className="flex-1 min-w-0">
        {/* Title row */}
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-sm leading-6">{displayTitle}</p>
          {page !== null && page !== undefined && (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              P.{page}
            </span>
          )}
          {numericConfidence !== null && (
            <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
              {numericConfidence}%
            </span>
          )}
        </div>

        {/* File path / additional info */}
        {filePath && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{filePath}</p>
        )}

        {/* Snippet */}
        {snippet && (
          <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{snippet}</p>
        )}
      </div>
    </button>
  )
}

export { ReferenceCard }
