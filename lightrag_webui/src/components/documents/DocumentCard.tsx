import Button from '@/components/ui/Button'
import Checkbox from '@/components/ui/Checkbox'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  CalendarIcon,
  Eye,
  FileTextIcon,
  Trash2Icon
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { DocStatus } from '@/api/lightrag'

type DocStatusResponseType = {
  id: string
  file_path?: string
  created_at: string
  updated_at: string
  status: DocStatus
  summary?: string
}

interface DocumentCardProps {
  doc: DocStatusResponseType
  selected: boolean
  onSelect: (docId: string, checked: boolean) => void
  showFileName?: boolean
  className?: string
  canWrite?: boolean
  onDelete?: (docId: string) => void
  onView?: (docId: string) => void
}

export default function DocumentCard({
  doc,
  selected,
  onSelect,
  showFileName = false,
  className,
  canWrite = true,
  onDelete,
  onView
}: DocumentCardProps) {
  useTranslation()

  const fileName = doc.file_path ? (doc.file_path.split('/').pop() || doc.file_path) : '—'
  const createdDate = new Date(doc.created_at).toLocaleDateString()
  const updatedDate = new Date(doc.updated_at).toLocaleDateString()

  return (
    <Card className={cn('relative hover:shadow-md transition-shadow', className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
        <div className="flex items-center gap-3">
          <Checkbox
            id={`doc-card-${doc.id}`}
            checked={selected}
            onCheckedChange={(checked) => onSelect(doc.id, !!checked)}
            disabled={!canWrite}
          />
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <FileTextIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="flex flex-col">
            <CardTitle className="max-w-[16rem] truncate text-sm font-medium">
              {showFileName ? fileName : `doc-${doc.id}`}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{createdDate}</p>
          </div>
        </div>
        <StatusBadge status={(doc.status as any) === 'pending' ? null : doc.status as Extract<DocStatus, 'failed' | 'parsing' | 'analyzing' | 'processing' | 'completed' | 'recycled'>} />
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* Summary preview */}
        <div className="line-clamp-2 text-xs text-muted-foreground">
          {doc.summary || 'No summary available.'}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <CalendarIcon className="size-3" aria-hidden="true" />
              {updatedDate}
            </span>
            <span>—</span>
          </div>
          <div className="flex items-center gap-1">
            {onView && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="view file"
                onClick={() => onView(doc.id)}
              >
                <Eye className="size-4" aria-hidden="true" />
              </Button>
            )}
            {canWrite && onDelete && (
              <Button
                variant="destructive"
                size="icon"
                aria-label="remove selected file"
                onClick={() => onDelete(doc.id)}
              >
                <Trash2Icon className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
