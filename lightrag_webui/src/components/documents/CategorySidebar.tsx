import { useState, useEffect, useCallback, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { FolderIcon, FolderPlusIcon, PencilIcon, TrashIcon, InboxIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, ChevronDownIcon, ChevronRightIcon, LayersIcon } from 'lucide-react'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/Dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger
} from '@/components/ui/DropdownMenu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import { toast } from 'sonner'
import {
  listVersions, createVersion, renameVersion, deleteVersion,
  createCategory, renameCategory, deleteCategory,
  type DocVersionInfo
} from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

export interface CategorySelection {
  version: string | null  // null = all versions
  category: string | null // null = whole version, "" = uncategorized in it
}

interface CategorySidebarProps {
  selection: CategorySelection
  onSelect: (selection: CategorySelection) => void
  refreshTrigger: number
}

export default function CategorySidebar({ selection, onSelect, refreshTrigger }: CategorySidebarProps) {
  const { t } = useTranslation()
  const collapsed = useSettingsStore.use.categorySidebarCollapsed()
  const setCollapsed = useSettingsStore.use.setCategorySidebarCollapsed()
  const expandedVersions = useSettingsStore.use.categorySidebarExpandedVersions()
  const toggleVersion = useSettingsStore.use.toggleCategorySidebarVersion()
  const [versions, setVersions] = useState<DocVersionInfo[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)

  const [showCreateVersion, setShowCreateVersion] = useState(false)
  const [newVersionName, setNewVersionName] = useState('')
  const [renameVersionTarget, setRenameVersionTarget] = useState<string | null>(null)
  const [renameVersionValue, setRenameVersionValue] = useState('')
  const [createCatVersion, setCreateCatVersion] = useState<string | null>(null)
  const [newCatName, setNewCatName] = useState('')
  const [renamingCat, setRenamingCat] = useState<{ version: string; name: string } | null>(null)
  const [renameCatValue, setRenameCatValue] = useState('')
  // Cursor-anchored right-click menu on a version node.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; version: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await listVersions()
      setVersions(res.versions)
      setTotalCount(res.total_count)
      setLatestVersion(res.latest_version)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => { load() }, [load, refreshTrigger])

  const handleCreateVersion = async () => {
    const name = newVersionName.trim()
    if (!name) return
    try {
      await createVersion(name)
      setShowCreateVersion(false)
      setNewVersionName('')
      load()
      toast.success(t('categories.versionCreated', { name }))
    } catch (e: any) {
      toast.error(e.message || t('categories.versionCreateError'))
    }
  }

  const handleRenameVersion = async (oldName: string) => {
    const newName = renameVersionValue.trim()
    if (!newName) return
    if (newName === oldName) {
      // Unchanged name: exit silently (IME Enter submits the unchanged text).
      setRenameVersionTarget(null)
      setRenameVersionValue('')
      return
    }
    try {
      await renameVersion(oldName, newName)
      if (selection.version === oldName) onSelect({ version: newName, category: selection.category })
      setRenameVersionTarget(null)
      setRenameVersionValue('')
      load()
      toast.success(t('categories.versionRenamed'))
    } catch (e: any) {
      toast.error(e.message || t('categories.versionRenameError'))
    }
  }

  const handleDeleteVersion = async (name: string) => {
    if (!confirm(t('categories.confirmDeleteVersion', { name }))) return
    try {
      await deleteVersion(name)
      if (selection.version === name) onSelect({ version: null, category: null })
      load()
      toast.success(t('categories.versionDeleted'))
    } catch (e: any) {
      toast.error(e.message || t('categories.versionDeleteError'))
    }
  }

  const handleCreateCategory = async (version: string) => {
    const name = newCatName.trim()
    if (!name) return
    try {
      await createCategory(name, version)
      setCreateCatVersion(null)
      setNewCatName('')
      if (!expandedVersions.includes(version)) toggleVersion(version)
      load()
      toast.success(t('categories.created', { name }))
    } catch (e: any) {
      toast.error(e.message || t('categories.createError'))
    }
  }

  const handleRenameCategory = async (version: string, oldName: string) => {
    const newName = renameCatValue.trim()
    if (!newName) return
    if (newName === oldName) {
      // Unchanged name: exit editing silently (IME Enter hits this path).
      setRenamingCat(null)
      setRenameCatValue('')
      return
    }
    try {
      await renameCategory(oldName, newName, version)
      setRenamingCat(null)
      setRenameCatValue('')
      if (selection.version === version && selection.category === oldName) {
        onSelect({ version, category: newName })
      }
      load()
      toast.success(t('categories.renamed'))
    } catch (e: any) {
      toast.error(e.message || t('categories.renameError'))
    }
  }

  const handleDeleteCategory = async (version: string, name: string) => {
    if (!confirm(t('categories.confirmDelete', { name }))) return
    try {
      await deleteCategory(name, version)
      if (selection.version === version && selection.category === name) {
        onSelect({ version, category: null })
      }
      load()
      toast.success(t('categories.deleted'))
    } catch (e: any) {
      toast.error(e.message || t('categories.deleteError'))
    }
  }

  if (collapsed) {
    const railLabel = (key: string, fallback: string) => t(key, fallback)
    const railButton = (
      active: boolean,
      label: string,
      onClick: () => void,
      icon: ReactNode
    ) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    )
    return (
      <TooltipProvider>
        <div className="w-10 shrink-0 rounded-lg border bg-card shadow-sm flex flex-col items-center gap-1 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setCollapsed(false)}
            tooltip={railLabel('categories.expand', 'Expand categories')}
            side="right"
            aria-label={railLabel('categories.expand', 'Expand categories')}
          >
            <PanelLeftOpenIcon className="size-4" />
          </Button>
          <div className="my-1 w-6 border-t" />
          {railButton(
            selection.version === null,
            t('categories.all', 'All'),
            () => onSelect({ version: null, category: null }),
            <FolderIcon className="size-4" />
          )}
          {railButton(
            selection.version !== null && selection.category === '',
            t('categories.uncategorized', 'Uncategorized'),
            () => onSelect({ version: latestVersion, category: '' }),
            <InboxIcon className="size-4" />
          )}
        </div>
      </TooltipProvider>
    )
  }

  return (
    <div className="w-44 shrink-0 rounded-lg border bg-card shadow-sm flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t('categories.title', 'Categories')}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setCollapsed(true)}
          tooltip={t('categories.collapse', 'Collapse categories')}
          side="right"
          aria-label={t('categories.collapse', 'Collapse categories')}
        >
          <PanelLeftCloseIcon className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {/* All documents across versions */}
        <button
          type="button"
          onClick={() => onSelect({ version: null, category: null })}
          className={cn(
            'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            selection.version === null
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent'
          )}
        >
          <FolderIcon className="size-4 shrink-0" />
          <span className="flex-1 text-left truncate">{t('categories.all', 'All')}</span>
          <span className="text-xs opacity-60">{totalCount}</span>
        </button>

        <div className="my-2 border-t" />

        {/* Version tree */}
        {versions.map((v) => {
          const expanded = expandedVersions.includes(v.name)
          return (
            <div key={v.name}>
              {/* Version node: click selects it, chevron expands, right-click opens the menu */}
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-md px-1 py-1.5 text-sm cursor-pointer transition-colors',
                  selection.version === v.name && selection.category === null
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-accent'
                )}
                onClick={() => onSelect({ version: v.name, category: null })}
                onContextMenu={(e: MouseEvent) => {
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, version: v.name })
                }}
              >
                <button
                  type="button"
                  className="p-0.5 rounded hover:bg-foreground/10 shrink-0"
                  aria-label={expanded ? t('categories.collapseVersion', 'Collapse version') : t('categories.expandVersion', 'Expand version')}
                  onClick={(e: MouseEvent) => { e.stopPropagation(); toggleVersion(v.name) }}
                >
                  {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                </button>
                <LayersIcon className="size-4 shrink-0" />
                <span className="flex-1 text-left truncate select-none">{v.name}</span>
                <span className="text-xs opacity-60">{v.count}</span>
              </div>

              {expanded && (
                <div className="ml-5 border-l pl-1">
                  {/* Uncategorized inside this version */}
                  <button
                    type="button"
                    onClick={() => onSelect({ version: v.name, category: '' })}
                    className={cn(
                      'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                      selection.version === v.name && selection.category === ''
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent'
                    )}
                  >
                    <InboxIcon className="size-4 shrink-0" />
                    <span className="flex-1 text-left truncate">{t('categories.uncategorized', 'Uncategorized')}</span>
                    <span className="text-xs opacity-60">{v.uncategorized_count}</span>
                  </button>

                  {v.categories.map((cat) => (
                    <div
                      key={cat.name}
                      className={cn(
                        'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
                        selection.version === v.name && selection.category === cat.name
                          ? 'bg-primary text-primary-foreground'
                          : 'hover:bg-accent'
                      )}
                      onClick={() => onSelect({ version: v.name, category: cat.name })}
                    >
                      <FolderIcon className="size-4 shrink-0" />
                      {renamingCat?.version === v.name && renamingCat.name === cat.name ? (
                        <Input
                          autoFocus
                          value={renameCatValue}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameCatValue(e.target.value)}
                          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleRenameCategory(v.name, cat.name)
                            if (e.key === 'Escape') { setRenamingCat(null); setRenameCatValue('') }
                          }}
                          className="h-6 flex-1 text-xs px-1"
                          onClick={(e: MouseEvent) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="flex-1 truncate">{cat.name}</span>
                      )}
                      <span className="text-xs opacity-60">{cat.count}</span>
                      <div className="hidden group-hover:flex items-center gap-0.5" onClick={(e: MouseEvent) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="p-0.5 rounded hover:bg-foreground/10"
                          onClick={() => { setRenamingCat({ version: v.name, name: cat.name }); setRenameCatValue(cat.name) }}
                        >
                          <PencilIcon className="size-3" />
                        </button>
                        <button
                          type="button"
                          className="p-0.5 rounded hover:bg-red-500/20"
                          onClick={() => handleDeleteCategory(v.name, cat.name)}
                        >
                          <TrashIcon className="size-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => setShowCreateVersion(true)}
        >
          <FolderPlusIcon className="size-4" /> {t('categories.newVersion', 'New version')}
        </Button>
      </div>

      {/* Version context menu — anchored to the cursor, not the row */}
      <DropdownMenu
        open={ctxMenu !== null}
        onOpenChange={(open) => { if (!open) setCtxMenu(null) }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
            className="fixed size-0"
            style={{ left: ctxMenu?.x ?? 0, top: ctxMenu?.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onSelect={() => {
              if (ctxMenu) { setCreateCatVersion(ctxMenu.version); setNewCatName('') }
            }}
          >
            <FolderPlusIcon className="size-4" />
            {t('categories.newCategory', 'New category')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              if (ctxMenu) { setRenameVersionTarget(ctxMenu.version); setRenameVersionValue(ctxMenu.version) }
            }}
          >
            <PencilIcon className="size-4" />
            {t('categories.renameVersion', 'Rename version')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-600 focus:text-red-600"
            onSelect={() => { if (ctxMenu) handleDeleteVersion(ctxMenu.version) }}
          >
            <TrashIcon className="size-4" />
            {t('categories.deleteVersion', 'Delete version')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create version dialog */}
      <Dialog open={showCreateVersion} onOpenChange={setShowCreateVersion}>
        <DialogContent className="w-96">
          <DialogHeader>
            <DialogTitle>{t('categories.createVersionTitle', 'Create version')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('categories.versionNamePlaceholder', 'Version number, e.g. 1.0')}
            value={newVersionName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewVersionName(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCreateVersion() }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreateVersion(false)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={handleCreateVersion}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename version dialog */}
      <Dialog open={renameVersionTarget !== null} onOpenChange={(open) => { if (!open) setRenameVersionTarget(null) }}>
        <DialogContent className="w-96">
          <DialogHeader>
            <DialogTitle>{t('categories.renameVersionTitle', 'Rename version')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('categories.versionNamePlaceholder', 'Version number, e.g. 1.0')}
            value={renameVersionValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameVersionValue(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && renameVersionTarget) handleRenameVersion(renameVersionTarget)
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameVersionTarget(null)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => renameVersionTarget && handleRenameVersion(renameVersionTarget)}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create category dialog (opened from a version's context menu) */}
      <Dialog open={createCatVersion !== null} onOpenChange={(open) => { if (!open) setCreateCatVersion(null) }}>
        <DialogContent className="w-96">
          <DialogHeader>
            <DialogTitle>
              {t('categories.createCategoryIn', 'New category in {{version}}', { version: createCatVersion ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('categories.namePlaceholder', 'Category name')}
            value={newCatName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewCatName(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && createCatVersion) handleCreateCategory(createCatVersion)
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateCatVersion(null)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => createCatVersion && handleCreateCategory(createCatVersion)}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
