/**
 * Translations.
 *
 * Deliberately module state rather than a React context: strings are needed in
 * places React does not render — context-menu item lists, callbacks, window
 * titles — and threading a hook through all of them would touch far more code
 * than it is worth. The renderer sets the language from settings on every render
 * of the shell, which is also what makes a change take effect everywhere at once:
 * `t()` is re-evaluated as part of that render.
 *
 * The English text stays at the call site and is the fallback, so a key with no
 * translation shows English rather than a raw key, and a missing catalog entry is
 * never a visible bug.
 */
import { zh } from './zh'
import type { Catalog } from './catalog'

export type { Catalog }

export type Language = 'en' | 'zh-CN'

export const LANGUAGES: { id: Language; label: string; english: string }[] = [
  { id: 'en', label: 'English', english: 'English' },
  { id: 'zh-CN', label: '简体中文', english: 'Chinese (Simplified)' }
]

const CATALOGS: Partial<Record<Language, Record<string, string>>> = { 'zh-CN': zh }

let current: Language = 'en'
const listeners = new Set<() => void>()

export function setLanguage(next: Language): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

/**
 * Subscribe to language changes.
 *
 * The shell needs this so a *preview* redraws it: the settings dialog changes the
 * language imperatively (exactly as it previews a theme), and without a
 * subscription only the dialog itself would repaint while the rail around it kept
 * the old text.
 */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLanguage(): Language {
  return current
}

type Params = Record<string, string | number>

/**
 * Look up a translated string.
 *
 * `{name}` placeholders are substituted, so a translated sentence can put its
 * values in its own order instead of inheriting English word order.
 */
export function t(key: string, english: string, params?: Params): string {
  const catalog = CATALOGS[current]
  const raw = (catalog && catalog[key]) || english
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  )
}

/** True when a language other than the built-in one is active. */
export function isTranslated(): boolean {
  return current !== 'en'
}
