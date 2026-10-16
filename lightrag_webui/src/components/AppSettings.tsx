import { useState, useCallback } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import Button from '@/components/ui/Button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import { useSettingsStore } from '@/stores/settings'
import { PaletteIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface AppSettingsProps {
  className?: string
}

export default function AppSettings({ className }: AppSettingsProps) {
  const [opened, setOpened] = useState<boolean>(false)
  const { t } = useTranslation()

  const language = useSettingsStore.use.language()
  const setLanguage = useSettingsStore.use.setLanguage()

  const theme = useSettingsStore.use.theme()
  const setTheme = useSettingsStore.use.setTheme()

  const handleLanguageChange = useCallback((value: string) => {
    setLanguage(value as 'en' | 'zh' | 'fr' | 'ar' | 'zh_TW' | 'ru' | 'ja' | 'de' | 'uk' | 'ko' | 'vi' | 'id')
  }, [setLanguage])

  const handleThemeChange = useCallback((value: string) => {
    setTheme(value as 'light' | 'dark' | 'system')
  }, [setTheme])

  return (
    <Popover open={opened} onOpenChange={setOpened}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          side="bottom"
          tooltip={t('header.appSettings')}
          // A tooltip is only a description, never the accessible name — an
          // icon-only button needs the explicit aria-label.
          aria-label={t('header.appSettings')}
          // 36px visual size; the ::after overlay widens the TOUCH target to
          // 44px (PRD: primary touch targets ≥44px) without moving layout.
          className={cn(
            'relative h-9 w-9 after:absolute after:-inset-1 after:content-[\'\']',
            className
          )}
        >
          <PaletteIcon className="h-5 w-5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-56">
        <div className="flex flex-col gap-4">
          {/* Language */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('settings.language')}</label>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {language.toUpperCase()}
              </span>
            </div>
            <Select value={language} onValueChange={handleLanguageChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="zh">中文</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
                <SelectItem value="ar">العربية</SelectItem>
                <SelectItem value="zh_TW">繁體中文</SelectItem>
                <SelectItem value="ru">Русский</SelectItem>
                <SelectItem value="ja">日本語</SelectItem>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="uk">Українська</SelectItem>
                <SelectItem value="ko">한국어</SelectItem>
                <SelectItem value="vi">Tiếng Việt</SelectItem>
                <SelectItem value="id">Bahasa Indonesia</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Theme */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('settings.theme')}</label>
              <span className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                theme === 'dark'
                  ? 'bg-slate-800 text-slate-200'
                  : theme === 'light'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-muted text-muted-foreground'
              )}>
                {theme === 'dark' ? '● Dark' : theme === 'light' ? '○ Light' : '◐ System'}
              </span>
            </div>
            <Select value={theme} onValueChange={handleThemeChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">{t('settings.light')}</SelectItem>
                <SelectItem value="dark">{t('settings.dark')}</SelectItem>
                <SelectItem value="system">{t('settings.system')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
