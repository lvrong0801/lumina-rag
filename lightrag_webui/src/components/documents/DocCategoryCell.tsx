import { useState, useEffect } from 'react'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/Select'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { listCategories, assignDocumentCategory } from '@/api/lightrag'
import type { DocStatusResponse } from '@/api/lightrag'
import { canWrite } from '@/lib/rbac'
import { useAuthStore } from '@/stores/state'

export default function DocCategoryCell({ doc, onChange }: { doc: DocStatusResponse, onChange?: () => void }) {
  const { role } = useAuthStore()
  const { t } = useTranslation()
  const [cats, setCats] = useState<string[]>([])
  const current = doc.metadata?.category || ''
  const docVersion = doc.metadata?.version || undefined

  useEffect(() => {
    // Categories are version-scoped: offer only the ones in THIS document's
    // version (undefined → the backend resolves the doc's version).
    listCategories(docVersion).then(d => setCats(d.categories.map(c => c.name))).catch(() => {})
  }, [docVersion])

  const handleChange = async (value: string) => {
    try {
      await assignDocumentCategory(doc.id, value)
      toast.success(value ? t('workspaces.moved', { name: value }) : t('workspaces.moveRemoved'))
      onChange?.()
    } catch (e: any) {
      toast.error(e.message || t('workspaces.moveError'))
    }
  }

  if (!canWrite(role)) {
    return <span className="text-xs text-muted-foreground">{current || '-'}</span>
  }

  return (
    <Select value={current || '__uncat__'} onValueChange={(v) => handleChange(v === '__uncat__' ? '' : v)}>
      <SelectTrigger className="h-7 text-xs w-28">
        <SelectValue placeholder={t('categories.uncategorized')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__uncat__">{t('categories.uncategorized')}</SelectItem>
        {cats.map(c => (
          <SelectItem key={c} value={c}>{c}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
