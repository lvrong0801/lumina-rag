import { useState, useCallback, useEffect } from 'react'
import { FileRejection } from 'react-dropzone'
import Button from '@/components/ui/Button'
import NumberInput from '@/components/ui/NumberInput'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/Select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/Dialog'
import Checkbox from '@/components/ui/Checkbox'
import FileUploader from '@/components/ui/FileUploader'
import { toast } from 'sonner'
import { supportedFileTypes } from '@/lib/constants'
import {
  deriveUploaderInputs,
  flattenAcceptExtensions,
  formatFileTypesLabel,
  normalizeSupportedFileTypes,
  type FileTypesState
} from '@/lib/fileTypes'
import { errorMessage, cn } from '@/lib/utils'
import {
  getSupportedFileTypes,
  getDocumentsPaginated,
  uploadDocument,
  checkHealth,
  type DocStatusResponse,
  type LightragParserEngine,
  type LightragStatus,
  type UploadDocumentOptions,
  type UploadMode
} from '@/api/lightrag'

import { UploadIcon, Settings2, ChevronDown, ChevronUp, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const SUMMARY_LANGUAGES = ['Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian']

// Engines offered in the advanced-settings parse-engine selector. The 'default'
// option keeps the server's own routing (filename hint / LIGHTRAG_PARSER rules
// / suffix defaults); picking an engine pins it for the whole batch. Available
// engines the server reports that are NOT listed here (e.g. future engines)
// are still appended dynamically in the dialog.
const PARSE_ENGINE_CHOICES = ['docling', 'pymupdf4llm'] as const

const PARSE_ENGINE_DISPLAY_NAMES: Record<string, string> = {
  docling: 'Docling',
  pymupdf4llm: 'PyMuPDF4LLM'
}

interface UploadDocumentsDialogProps {
  onDocumentsUploaded?: () => Promise<void>
  /**
   * Fired once per batch as soon as the first file is accepted by the server.
   * Lets the parent start its activity probe as early as possible (rather
   * than waiting for the whole sequential batch to finish).
   */
  onUploadBatchAccepted?: () => void
}

const UPLOAD_MODES: UploadMode[] = ['new', 'overwrite', 'incremental']

export default function UploadDocumentsDialog({
  onDocumentsUploaded,
  onUploadBatchAccepted
}: UploadDocumentsDialogProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [progresses, setProgresses] = useState<Record<string, number>>({})
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({})
  const [fileTypes, setFileTypes] = useState<FileTypesState>({ status: 'idle' })
  const [mode, setMode] = useState<UploadMode>('new')
  const [targetDocIds, setTargetDocIds] = useState<string[]>([])
  const [targetDocs, setTargetDocs] = useState<DocStatusResponse[]>([])
  const [targetDocsLoading, setTargetDocsLoading] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Server-side defaults surfaced as placeholders / labels in the advanced
  // settings panel; fetched once per dialog open from /health.
  const [serverDefaults, setServerDefaults] = useState<{
    chunkTokenSize?: number
    chunkOverlapTokenSize?: number
    summaryLanguage?: string
    vlmProcessEnable?: boolean
  } | null>(null)

  // Advanced settings — undefined / 'default' means "keep the server default":
  // the field is then omitted from the upload form entirely.
  const [chunkSize, setChunkSize] = useState<number | undefined>(undefined)
  const [chunkOverlap, setChunkOverlap] = useState<number | undefined>(undefined)
  const [enableMultimodal, setEnableMultimodal] = useState<string>('default')
  const [summaryLanguage, setSummaryLanguage] = useState<string>('default')
  const [parseEngine, setParseEngine] = useState<string>('default')
  // Engine availability matrix from /health; empty until fetched (options then
  // stay enabled optimistically — the server still validates synchronously).
  const [parserEngines, setParserEngines] = useState<LightragParserEngine[]>([])

  // Fetch the live allowlist + engine capability matrix while the dialog is
  // open. `loading` is entered synchronously in onOpenChange (not here) so
  // the very first open render already has the uploader disabled.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    getSupportedFileTypes(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        const data = normalizeSupportedFileTypes(res)
        setFileTypes(data ? { status: 'ready', data } : { status: 'fallback' })
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        // Old backend (404) or transient failure: fall back to the static
        // allowlist and let the server judge hinted filenames.
        console.warn('Failed to fetch supported file types:', errorMessage(err))
        setFileTypes({ status: 'fallback' })
      })
    return () => controller.abort()
  }, [open])

  // Fetch existing documents for the overwrite/incremental target picker.
  useEffect(() => {
    if (!open || mode === 'new') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTargetDocs([])
      return
    }
    const controller = new AbortController()
    setTargetDocsLoading(true)
    getDocumentsPaginated({
      page: 1,
      page_size: 200,
      sort_field: 'updated_at',
      sort_direction: 'desc',
      status_filter: 'processed'
    })
      .then((res) => {
        if (controller.signal.aborted) return
        setTargetDocs(res.documents)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.warn('Failed to fetch documents for target picker:', errorMessage(err))
        setTargetDocs([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setTargetDocsLoading(false)
      })
    return () => controller.abort()
  }, [open, mode])

  // Fetch server defaults while the dialog is open so the advanced-settings
  // placeholders reflect the actual runtime configuration (env overrides the
  // built-in defaults). Failures are non-fatal — fields fall back to generic
  // placeholders and an omitted value still means "server default".
  useEffect(() => {
    if (!open) return
    let cancelled = false
    checkHealth()
      .then((res) => {
        if (cancelled || res.status !== 'healthy') return
        const cfg = (res as LightragStatus).configuration
        setServerDefaults({
          chunkTokenSize: cfg.chunk_token_size,
          chunkOverlapTokenSize: cfg.chunk_overlap_token_size,
          summaryLanguage: cfg.summary_language,
          vlmProcessEnable: cfg.vlm_process_enable
        })
        setParserEngines(cfg.parser_engines ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('Failed to fetch server defaults for upload dialog:', err)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const resetAdvancedOptions = useCallback(() => {
    setChunkSize(undefined)
    setChunkOverlap(undefined)
    setEnableMultimodal('default')
    setSummaryLanguage('default')
    setParseEngine('default')
  }, [])

  const handleModeChange = useCallback((next: UploadMode) => {
    setMode(next)
    setTargetDocIds([])
  }, [])

  const toggleTarget = useCallback((id: string, checked: boolean) => {
    setTargetDocIds((prev) =>
      checked ? [...prev, id] : prev.filter((x) => x !== id)
    )
  }, [])

  const handleRejectedFiles = useCallback(
    (rejectedFiles: FileRejection[]) => {
      // Process rejected files and add them to fileErrors
      rejectedFiles.forEach(({ file, errors }) => {
        // Get the first error message
        let errorMsg = errors[0]?.message || t('documentPanel.uploadDocuments.fileUploader.fileRejected', { name: file.name })

        // Simplify error message for unsupported file types
        if (errorMsg.includes('file-invalid-type')) {
          errorMsg = t('documentPanel.uploadDocuments.fileUploader.unsupportedType')
        }

        // Set progress to 100% to display error message
        setProgresses((pre) => ({
          ...pre,
          [file.name]: 100
        }))

        // Add error message to fileErrors
        setFileErrors(prev => ({
          ...prev,
          [file.name]: errorMsg
        }))
      })
    },
    [setProgresses, setFileErrors, t]
  )

  const handleDocumentsUpload = useCallback(
    async (filesToUpload: File[]) => {
      if (mode !== 'new' && targetDocIds.length === 0) {
        toast.error(t('documentPanel.uploadDocuments.target.required'))
        return
      }
      setIsUploading(true)
      let hasSuccessfulUpload = false

      // Only clear errors for files that are being uploaded, keep errors for rejected files
      setFileErrors(prev => {
        const newErrors = { ...prev };
        filesToUpload.forEach(file => {
          delete newErrors[file.name];
        });
        return newErrors;
      });

      // Show uploading toast
      const toastId = toast.loading(t('documentPanel.uploadDocuments.batch.uploading'))

      try {
        // Track errors locally to ensure we have the final state
        const uploadErrors: Record<string, string> = {}
        let batchProbeTriggered = false

        // Advanced settings apply to every file in this batch; unset fields
        // stay omitted so the server keeps its defaults.
        const uploadOptions: UploadDocumentOptions = { mode, targetDocIds }
        if (chunkSize !== undefined) uploadOptions.chunkSize = chunkSize
        if (chunkOverlap !== undefined) uploadOptions.chunkOverlapSize = chunkOverlap
        if (enableMultimodal !== 'default') uploadOptions.enableMultimodal = enableMultimodal === 'true'
        if (summaryLanguage !== 'default') uploadOptions.summaryLanguage = summaryLanguage
        if (parseEngine !== 'default') uploadOptions.parseEngine = parseEngine

        // Create a collator that supports Chinese sorting
        const collator = new Intl.Collator(['zh-CN', 'en'], {
          sensitivity: 'accent',  // consider basic characters, accents, and case
          numeric: true           // enable numeric sorting, e.g., "File 10" will be after "File 2"
        });
        const sortedFiles = [...filesToUpload].sort((a, b) =>
          collator.compare(a.name, b.name)
        );

        // Upload files in sequence, not parallel
        for (const file of sortedFiles) {
          try {
            // Initialize upload progress
            setProgresses((pre) => ({
              ...pre,
              [file.name]: 0
            }))

            const result = await uploadDocument(
              file,
              (percentCompleted: number) => {
                console.debug(t('documentPanel.uploadDocuments.single.uploading', { name: file.name, percent: percentCompleted }))
                setProgresses((pre) => ({
                  ...pre,
                  [file.name]: percentCompleted
                }))
              },
              uploadOptions
            )

            if (result.status !== 'success') {
              uploadErrors[file.name] = result.message
              setFileErrors(prev => ({
                ...prev,
                [file.name]: result.message
              }))
            } else {
              // Mark that we had at least one successful upload
              hasSuccessfulUpload = true
              if (!batchProbeTriggered) {
                batchProbeTriggered = true
                onUploadBatchAccepted?.()
              }
            }
          } catch (err) {
            console.error(`Upload failed for ${file.name}:`, err)

            // Handle HTTP errors, including 400 errors
            let errorMsg = errorMessage(err)
            const duplicateFileMsg = t('documentPanel.uploadDocuments.fileUploader.duplicateFile')

            // If it's an axios error with response data, try to extract more detailed error info
            if (err && typeof err === 'object' && 'response' in err) {
              const axiosError = err as { response?: { status: number, data?: { detail?: string } } }
              const status = axiosError.response?.status
              const detail = axiosError.response?.data?.detail
              if (status === 409) {
                // Server now rejects same-name uploads with HTTP 409 instead of
                // returning a 200 ``status="duplicated"`` payload.  Map the most
                // common cases (existing record / file in INPUT dir) back to the
                // dedicated "duplicate file" UI affordance, and surface other
                // 409 reasons (pipeline busy / scanning) verbatim from the
                // server detail so users can tell why they were rejected.
                if (
                  typeof detail === 'string' &&
                  (/already contains/i.test(detail) || /Status:/i.test(detail))
                ) {
                  errorMsg = duplicateFileMsg
                } else {
                  errorMsg = detail || errorMsg
                }
              } else if (status === 400 || status === 404 || status === 413 || status === 429 || status === 503) {
                // 400 invalid request, 404 target document missing, 413 body/file
                // too large, 429 pipeline at capacity, 503 document storage
                // unavailable. Each detail is written to be shown verbatim.
                errorMsg = detail || errorMsg
              }

              // Set progress to 100% to display error message
              setProgresses((pre) => ({
                ...pre,
                [file.name]: 100
              }))
            }

            // Record error message in both local tracking and state
            uploadErrors[file.name] = errorMsg
            setFileErrors(prev => ({
              ...prev,
              [file.name]: errorMsg
            }))
          }
        }

        // Check if any files failed to upload using our local tracking
        const hasErrors = Object.keys(uploadErrors).length > 0

        // Update toast status
        if (hasErrors) {
          toast.error(t('documentPanel.uploadDocuments.batch.error'), { id: toastId })
        } else {
          toast.success(t('documentPanel.uploadDocuments.batch.success'), { id: toastId })
        }

        // Only update if at least one file was uploaded successfully
        if (hasSuccessfulUpload) {
          // Refresh document list
          if (onDocumentsUploaded) {
            onDocumentsUploaded().catch(err => {
              console.error('Error refreshing documents:', err)
            })
          }
          // Close the dialog and reset transient upload state
          setProgresses({})
          setFileErrors({})
          setTargetDocIds([])
          resetAdvancedOptions()
          setShowAdvanced(false)
          setOpen(false)
        }
      } catch (err) {
        console.error('Unexpected error during upload:', err)
        toast.error(t('documentPanel.uploadDocuments.generalError', { error: errorMessage(err) }), { id: toastId })
      } finally {
        setIsUploading(false)
      }
    },
    [setIsUploading, setProgresses, setFileErrors, t, onDocumentsUploaded, onUploadBatchAccepted, mode, targetDocIds, chunkSize, chunkOverlap, enableMultimodal, summaryLanguage, parseEngine, resetAdvancedOptions]
  )

  const uploaderInputs = deriveUploaderInputs(fileTypes)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (isUploading) {
          return
        }
        if (nextOpen) {
          // Enter loading synchronously so the first open render already has
          // the uploader disabled — no window where a hinted file could start
          // uploading before the capability matrix arrives.
          setFileTypes({ status: 'loading' })
        } else {
          setProgresses({})
          setFileErrors({})
          setFileTypes({ status: 'idle' })
          resetAdvancedOptions()
          setShowAdvanced(false)
          setServerDefaults(null)
        }
        setOpen(nextOpen)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="default" side="bottom" tooltip={t('documentPanel.uploadDocuments.tooltip')} size="sm">
          <UploadIcon /> {t('documentPanel.uploadDocuments.button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('documentPanel.uploadDocuments.title')}</DialogTitle>
          {/* sr-only: the dropzone already carries the visual "drag or click"
              instruction; the description stays for assistive tech. */}
          <DialogDescription className="sr-only">
            {t('documentPanel.uploadDocuments.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Upload mode selector */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t('documentPanel.uploadDocuments.mode.label')}</span>
            <div className="flex gap-2">
              {UPLOAD_MODES.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={mode === m ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleModeChange(m)}
                >
                  {t(`documentPanel.uploadDocuments.mode.${m}`)}
                </Button>
              ))}
            </div>
          </div>
          {mode === 'overwrite' && (
            <p className="text-muted-foreground text-xs">{t('documentPanel.uploadDocuments.mode.overwriteHint')}</p>
          )}
          {mode === 'incremental' && (
            <p className="text-muted-foreground text-xs">{t('documentPanel.uploadDocuments.mode.incrementalHint')}</p>
          )}
        </div>

        {/* Target document picker (overwrite / incremental) */}
        {mode !== 'new' && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {mode === 'overwrite'
                ? t('documentPanel.uploadDocuments.target.placeholderOverwrite')
                : t('documentPanel.uploadDocuments.target.placeholderIncremental')}
            </span>
            <div className="max-h-48 overflow-y-auto rounded-md border p-2">
              {targetDocsLoading && (
                <div className="text-muted-foreground px-2 py-1 text-sm">
                  {t('documentPanel.uploadDocuments.target.loading')}
                </div>
              )}
              {!targetDocsLoading && targetDocs.length === 0 && (
                <div className="text-muted-foreground px-2 py-1 text-sm">
                  {t('documentPanel.uploadDocuments.target.empty')}
                </div>
              )}
              {targetDocs.map((doc) => (
                <label
                  key={doc.id}
                  className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
                >
                  <Checkbox
                    checked={targetDocIds.includes(doc.id)}
                    onCheckedChange={(checked) =>
                      toggleTarget(doc.id, checked === true)
                    }
                  />
                  <span className="truncate">{doc.file_path}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <FileUploader
          maxFileCount={mode === 'new' ? Infinity : 1}
          maxSize={200 * 1024 * 1024}
          description={t('documentPanel.uploadDocuments.fileTypes', {
            types: formatFileTypesLabel(
              uploaderInputs.acceptedExtensions ?? flattenAcceptExtensions(supportedFileTypes)
            )
          })}
          onUpload={handleDocumentsUpload}
          onReject={handleRejectedFiles}
          progresses={progresses}
          fileErrors={fileErrors}
          disabled={isUploading || uploaderInputs.disabled}
          acceptedExtensions={uploaderInputs.acceptedExtensions}
          engineCapabilities={uploaderInputs.engineCapabilities}
        />

        {/* Advanced settings — per-document processing overrides.
            'default' / empty means the field is omitted and the server keeps
            its configured default. */}
        <div className="overflow-hidden rounded-lg border">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="bg-muted/40 hover:bg-muted/70 flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium transition-colors"
          >
            <span className="text-muted-foreground flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              {t('documentPanel.uploadDocuments.advancedSettings.title')}
            </span>
            {showAdvanced
              ? <ChevronUp className="text-muted-foreground h-4 w-4" />
              : <ChevronDown className="text-muted-foreground h-4 w-4" />}
          </button>

          <div className={cn('transition-all duration-200', showAdvanced ? 'block' : 'hidden')}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t p-4">

              {/* Chunk Size */}
              <div className="space-y-1.5">
                <label className="text-foreground text-xs font-medium">
                  {t('documentPanel.uploadDocuments.advancedSettings.chunkSize')}
                </label>
                <NumberInput
                  min={100}
                  max={4000}
                  stepper={100}
                  className="pr-10"
                  placeholder={
                    serverDefaults?.chunkTokenSize !== undefined
                      ? `${t('documentPanel.uploadDocuments.advancedSettings.serverDefault')} ${serverDefaults.chunkTokenSize}`
                      : t('documentPanel.uploadDocuments.advancedSettings.chunkSizePlaceholder')
                  }
                  value={chunkSize}
                  onValueChange={setChunkSize}
                  suffix=" tokens"
                />
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('documentPanel.uploadDocuments.advancedSettings.chunkSizeHint')}
                </p>
              </div>

              {/* Chunk Overlap */}
              <div className="space-y-1.5">
                <label className="text-foreground text-xs font-medium">
                  {t('documentPanel.uploadDocuments.advancedSettings.chunkOverlap')}
                </label>
                <NumberInput
                  min={0}
                  max={500}
                  stepper={50}
                  className="pr-10"
                  placeholder={
                    serverDefaults?.chunkOverlapTokenSize !== undefined
                      ? `${t('documentPanel.uploadDocuments.advancedSettings.serverDefault')} ${serverDefaults.chunkOverlapTokenSize}`
                      : t('documentPanel.uploadDocuments.advancedSettings.chunkOverlapPlaceholder')
                  }
                  value={chunkOverlap}
                  onValueChange={setChunkOverlap}
                  suffix=" tokens"
                />
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('documentPanel.uploadDocuments.advancedSettings.chunkOverlapHint')}
                </p>
              </div>

              {/* Summary Language */}
              <div className="space-y-1.5">
                <label className="text-foreground text-xs font-medium">
                  {t('documentPanel.uploadDocuments.advancedSettings.summaryLanguage')}
                </label>
                <Select value={summaryLanguage} onValueChange={setSummaryLanguage}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {serverDefaults?.summaryLanguage
                        ? `${t('documentPanel.uploadDocuments.advancedSettings.serverDefault')} (${serverDefaults.summaryLanguage})`
                        : t('documentPanel.uploadDocuments.advancedSettings.serverDefault')}
                    </SelectItem>
                    {SUMMARY_LANGUAGES.map((lang) => (
                      <SelectItem key={lang} value={lang}>{lang}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('documentPanel.uploadDocuments.advancedSettings.summaryLanguageHint')}
                </p>
              </div>

              {/* Multimodal */}
              <div className="space-y-1.5">
                <label className="text-foreground text-xs font-medium">
                  {t('documentPanel.uploadDocuments.advancedSettings.multimodal')}
                </label>
                <Select value={enableMultimodal} onValueChange={setEnableMultimodal}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {(() => {
                        const serverDefault = t('documentPanel.uploadDocuments.advancedSettings.serverDefault')
                        if (serverDefaults?.vlmProcessEnable === undefined) return serverDefault
                        const modeLabel = serverDefaults.vlmProcessEnable
                          ? t('documentPanel.uploadDocuments.advancedSettings.multimodalOn')
                          : t('documentPanel.uploadDocuments.advancedSettings.multimodalOff')
                        return `${serverDefault} (${modeLabel})`
                      })()}
                    </SelectItem>
                    <SelectItem value="true">
                      {t('documentPanel.uploadDocuments.advancedSettings.multimodalOn')}
                    </SelectItem>
                    <SelectItem value="false">
                      {t('documentPanel.uploadDocuments.advancedSettings.multimodalOff')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('documentPanel.uploadDocuments.advancedSettings.multimodalHint')}
                </p>
              </div>

              {/* Parse Engine */}
              <div className="space-y-1.5">
                <label className="text-foreground text-xs font-medium">
                  {t('documentPanel.uploadDocuments.advancedSettings.parseEngine')}
                </label>
                <Select value={parseEngine} onValueChange={setParseEngine}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {t('documentPanel.uploadDocuments.advancedSettings.parseEngineDefault')}
                    </SelectItem>
                    {(() => {
                      const engines = new Map(parserEngines.map((e) => [e.name, e]))
                      const choices = [
                        ...PARSE_ENGINE_CHOICES,
                        ...parserEngines
                          .map((e) => e.name)
                          .filter((n) => !(PARSE_ENGINE_CHOICES as readonly string[]).includes(n))
                      ]
                      return choices.map((name) => {
                        const info = engines.get(name)
                        const suffixScope = info?.suffixes?.length
                          ? `.${info.suffixes.join(' .')}`
                          : null
                        const unavailable = info !== undefined && !info.available
                        return (
                          <SelectItem key={name} value={name} disabled={unavailable}>
                            {PARSE_ENGINE_DISPLAY_NAMES[name] ?? name}
                            {suffixScope ? ` (${suffixScope})` : ''}
                            {unavailable ? ` · ${t('documentPanel.uploadDocuments.advancedSettings.parseEngineUnavailable')}` : ''}
                          </SelectItem>
                        )
                      })
                    })()}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Info className="h-3 w-3 shrink-0" />
                  {t('documentPanel.uploadDocuments.advancedSettings.parseEngineHint')}
                </p>
              </div>

              {/* Reset action fills the trailing cell so the panel is a
                  complete 2×3 grid. */}
              <div className="flex items-end justify-end pb-0.5">
                <button
                  type="button"
                  onClick={resetAdvancedOptions}
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition-colors"
                >
                  {t('documentPanel.uploadDocuments.advancedSettings.reset')}
                </button>
              </div>

            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
