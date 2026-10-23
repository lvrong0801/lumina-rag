import { useState, useEffect, useCallback, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { FolderIcon, FolderPlusIcon, PencilIcon, TrashIcon, InboxIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/Dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import { toast } from 'sonner'
import {
  listCategories, createCategory, renameCategory, deleteCategory,
  type CategoryInfo
} from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

interface CategorySidebarProps {
  selectedCategory: string | null  // null = all, "" = uncategorized
  onSelect: (category: string | null) => void
  refreshTrigger: number
}

export default function CategorySidebar({ selectedCategory, onSelect, refreshTrigger }: CategorySidebarProps) {
  const { t } = useTranslation()
  const collapsed = useSettingsStore.use.categorySidebarCollapsed()
  const setCollapsed = useSettingsStore.use.setCategorySidebarCollapsed()
  const [categories, setCategories] = useState<CategoryInfo[]>([])
  const [uncatCount, setUncatCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await listCategories()
      setCategories(res.categories)
      setUncatCount(res.uncategorized_count)
      setTotalCount(res.total_count)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => { load() }, [load, refreshTrigger])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await createCategory(name)
      setShowCreate(false)
      setNewName('')
      load()
      toast.success(t('categories.created', { name }))
    } catch (e: any) {
      toast.error(e.message || t('categories.createError'))
    }
  }

  const handleRename = async (oldName: string) => {
    const newN = renameValue.trim()
    if (!newN) return
    if (newN === oldName) {
      // Unchanged name: exit editing silently; a 409 "already exists" for a
      // no-op rename reads as "cannot rename" (IME Enter hits this path).
      setRenaming(null)
      setRenameValue('')
      return
    }
    try {
      await renameCategory(oldName, newN)
      setRenaming(null)
      setRenameValue('')
      if (selectedCategory === oldName) onSelect(newN)
      load()
      toast.success(t('categories.renamed'))
    } catch (e: any) {
      toast.error(e.message || t('categories.renameError'))
    }
  }

  const handleDelete = async (name: string) => {
    if (!confirm(t('categories.confirmDelete', { name }))) return
    try {
      await deleteCategory(name)
      if (selectedCategory === name) onSelect(null)
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
            selectedCategory === null,
            t('categories.all', 'All'),
            () => onSelect(null),
            <FolderIcon className="size-4" />
          )}
          {railButton(
            selectedCategory === '',
            t('categories.uncategorized', 'Uncategorized'),
            () => onSelect(''),
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
        {/* All documents */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            selectedCategory === null
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent'
          )}
        >
          <FolderIcon className="size-4 shrink-0" />
          <span className="flex-1 text-left truncate">{t('categories.all', 'All')}</span>
          <span className="text-xs opacity-60">{totalCount}</span>
        </button>

        {/* Uncategorized */}
        <button
          type="button"
          onClick={() => onSelect('')}
          className={cn(
            'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
            selectedCategory === ''
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-accent'
          )}
        >
          <InboxIcon className="size-4 shrink-0" />
          <span className="flex-1 text-left truncate">{t('categories.uncategorized', 'Uncategorized')}</span>
          <span className="text-xs opacity-60">{uncatCount}</span>
        </button>

        <div className="my-2 border-t" />

        {/* User categories */}
        {categories.map((cat) => (
          <div
            key={cat.name}
            className={cn(
              'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors',
              selectedCategory === cat.name
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
            onClick={() => onSelect(cat.name)}
          >
            <FolderIcon className="size-4 shrink-0" />
            {renaming === cat.name ? (
              <Input
                autoFocus
                value={renameValue}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleRename(cat.name)
                  if (e.key === 'Escape') { setRenaming(null); setRenameValue('') }
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
                onClick={() => { setRenaming(cat.name); setRenameValue(cat.name) }}
              >
                <PencilIcon className="size-3" />
              </button>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-red-500/20"
                onClick={() => handleDelete(cat.name)}
              >
                <TrashIcon className="size-3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => setShowCreate(true)}
        >
          <FolderPlusIcon className="size-4" /> {t('categories.new', 'New category')}
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="w-96">
          <DialogHeader>
            <DialogTitle>{t('categories.createTitle', 'Create category')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t('categories.namePlaceholder', 'Category name')}
            value={newName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setNewName(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleCreate() }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={handleCreate}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
