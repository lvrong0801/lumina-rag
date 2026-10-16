import { useState, useCallback, useEffect } from 'react'
import Button from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter
} from '@/components/ui/Dialog'
import Input from '@/components/ui/Input'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import {
  getRecycleBinDocuments,
  restoreDocuments,
  purgeDocuments
} from '@/api/lightrag'
import type { DocStatusResponse } from '@/api/lightrag'

import { Trash2Icon, RotateCcwIcon, AlertTriangleIcon, RefreshCwIcon, FileX2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// Simple Label component (mirrors DeleteDocumentsDialog)
const Label = ({
  htmlFor,
  className,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label
    htmlFor={htmlFor}
    className={className}
    {...props}
  >
    {children}
  </label>
)

interface RecycleBinDialogProps {
  onDocumentsChanged?: () => Promise<void> | void
}

export default function RecycleBinDialog({ onDocumentsChanged }: RecycleBinDialogProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [docs, setDocs] = useState<DocStatusResponse[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [isLoading, setIsLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [isRestoring, setIsRestoring] = useState(false)
  const [confirmPurgeText, setConfirmPurgeText] = useState('')
  const [isPurging, setIsPurging] = useState(false)

  const loadRecycleBin = useCallback(
    async (pageToLoad: number) => {
      setIsLoading(true)
      try {
        const response = await getRecycleBinDocuments(pageToLoad, pageSize)
        setDocs(response.documents ?? [])
        setTotalCount(response.pagination?.total_count ?? 0)
        setPage(response.pagination?.page ?? pageToLoad)
        setSelectedIds([])
      } catch (err) {
        toast.error(t('documentPanel.recycleBin.loadError', { error: errorMessage(err) }))
      } finally {
        setIsLoading(false)
      }
    },
    [pageSize, t]
  )

  // Load once when opened. The async fetch is a side effect; the synchronous
  // setState inside loadRecycleBin is tolerated the same way DocumentManager
  // treats its paginated fetch.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadRecycleBin(1)
    }
  }, [open, loadRecycleBin])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(newOpen)
      if (!newOpen) {
        setConfirmPurgeText('')
        setIsRestoring(false)
        setIsPurging(false)
      }
    },
    []
  )

  const toggleSelect = useCallback((docId: string) => {
    setSelectedIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    )
  }, [])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.length === docs.length ? [] : docs.map((doc) => doc.id)
    )
  }, [docs])

  const notifyChanged = useCallback(() => {
    Promise.resolve(onDocumentsChanged?.()).catch(() => undefined)
  }, [onDocumentsChanged])

  const handleRestore = useCallback(async () => {
    if (selectedIds.length === 0 || isRestoring) return
    setIsRestoring(true)
    try {
      const result = await restoreDocuments(selectedIds)
      if (result.restored_docs.length > 0) {
        toast.success(
          t('documentPanel.recycleBin.restoreSuccess', { count: result.restored_docs.length })
        )
        notifyChanged()
      }
      if (result.failed_docs.length > 0) {
        toast.warning(
          t('documentPanel.recycleBin.restorePartial', { count: result.failed_docs.length })
        )
      }
      await loadRecycleBin(page)
    } catch (err) {
      toast.error(t('documentPanel.recycleBin.restoreError', { error: errorMessage(err) }))
    } finally {
      setIsRestoring(false)
    }
  }, [selectedIds, isRestoring, loadRecycleBin, page, t, notifyChanged])

  const handlePurge = useCallback(async () => {
    if (selectedIds.length === 0 || isPurging) return
    if (confirmPurgeText.toLowerCase() !== 'yes') return
    setIsPurging(true)
    try {
      const result = await purgeDocuments(selectedIds)
      if (result.status === 'deletion_started') {
        toast.success(t('documentPanel.recycleBin.purgeStarted', { count: selectedIds.length }))
        notifyChanged()
      } else if (result.status === 'busy') {
        toast.error(t('documentPanel.recycleBin.purgeBusy'))
        return
      } else {
        toast.error(t('documentPanel.recycleBin.purgeFailed', { message: result.message }))
        return
      }
      setConfirmPurgeText('')
      await loadRecycleBin(page)
    } catch (err) {
      toast.error(t('documentPanel.recycleBin.purgeError', { error: errorMessage(err) }))
    } finally {
      setIsPurging(false)
    }
  }, [selectedIds, isPurging, confirmPurgeText, loadRecycleBin, page, t, notifyChanged])

  const allSelected = docs.length > 0 && selectedIds.length === docs.length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          side="bottom"
          tooltip={t('documentPanel.recycleBin.tooltip')}
          size="sm"
        >
          <Trash2Icon /> {t('documentPanel.recycleBin.button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-bold">
            <Trash2Icon className="h-5 w-5" />
            {t('documentPanel.recycleBin.title')}
          </DialogTitle>
          <DialogDescription className="pt-2">
            {t('documentPanel.recycleBin.description', { count: totalCount })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-between items-center gap-2 mb-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadRecycleBin(page)}
            disabled={isLoading}
          >
            <RefreshCwIcon /> {t('documentPanel.recycleBin.refresh')}
          </Button>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                disabled={isLoading || docs.length === 0}
                className="h-4 w-4 rounded border-gray-300"
              />
              {t('documentPanel.recycleBin.selectAll')}
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRestore}
              disabled={selectedIds.length === 0 || isRestoring}
            >
              <RotateCcwIcon /> {t('documentPanel.recycleBin.restoreButton', { count: selectedIds.length })}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmPurgeText('yes')}
              disabled={selectedIds.length === 0}
            >
              <FileX2Icon /> {t('documentPanel.recycleBin.purgeButton', { count: selectedIds.length })}
            </Button>
          </div>
        </div>

        {docs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            {isLoading ? t('documentPanel.recycleBin.loading') : t('documentPanel.recycleBin.empty')}
          </div>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={isLoading}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('documentPanel.recycleBin.columnName')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('documentPanel.recycleBin.columnDeletedAt')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('documentPanel.recycleBin.columnDeletedBy')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-t">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(doc.id)}
                        onChange={() => toggleSelect(doc.id)}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                    </td>
                    <td className="px-3 py-2 break-all">{doc.file_path || doc.id}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {typeof doc.metadata?.deleted_at === 'string'
                        ? new Date(doc.metadata.deleted_at).toLocaleString()
                        : '-'}
                    </td>
                    <td className="px-3 py-2">{doc.metadata?.deleted_by ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalCount > pageSize && (
          <div className="flex items-center justify-between pt-3">
            <span className="text-sm text-muted-foreground">
              {t('documentPanel.recycleBin.pageInfo', {
                page,
                totalPages: Math.ceil(totalCount / pageSize)
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadRecycleBin(page - 1)}
                disabled={page <= 1 || isLoading}
              >
                {t('documentPanel.recycleBin.prevPage')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadRecycleBin(page + 1)}
                disabled={page >= Math.ceil(totalCount / pageSize) || isLoading}
              >
                {t('documentPanel.recycleBin.nextPage')}
              </Button>
            </div>
          </div>
        )}

        {/* Purge confirmation */}
        {confirmPurgeText.toLowerCase() === 'yes' && (
          <div className="mt-3 p-4 border border-red-300 dark:border-red-700 rounded-md bg-red-50 dark:bg-red-950/40 space-y-3">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold text-sm">
              <AlertTriangleIcon className="h-4 w-4" />
              {t('documentPanel.recycleBin.purgeWarningTitle')}
            </div>
            <div className="text-sm text-muted-foreground">
              {t('documentPanel.recycleBin.purgeWarningBody')}
            </div>
            <div className="space-y-2">
              <Label htmlFor="purge-confirm" className="text-sm font-medium">
                {t('documentPanel.recycleBin.purgeConfirmPrompt')}
              </Label>
              <Input
                id="purge-confirm"
                value={confirmPurgeText}
                onChange={(e) => setConfirmPurgeText(e.target.value)}
                placeholder={t('documentPanel.recycleBin.purgeConfirmPlaceholder')}
                className="w-full"
                disabled={isPurging}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmPurgeText('')}
                disabled={isPurging}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={handlePurge}
                disabled={confirmPurgeText.toLowerCase() !== 'yes' || isPurging}
              >
                {isPurging ? t('documentPanel.recycleBin.purging') : t('documentPanel.recycleBin.purgeConfirmButton')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
