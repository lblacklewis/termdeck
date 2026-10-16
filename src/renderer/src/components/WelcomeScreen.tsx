import { useEffect, useState, type JSX } from 'react'
import type { AppSettings, FontChoices } from '@shared/types'
import { findTheme, THEMES } from '@shared/themes'
import { applyTheme } from './useTheme'
import { LANGUAGES, setLanguage, t, type Language } from '../i18n'

const api = window.termdeck

interface WelcomeScreenProps {
  settings: AppSettings
  /** Called with the choices once the user is happy, then never shown again. */
  onDone: (settings: AppSettings) => void
}

/**
 * First run: language, theme, font and where the data goes.
 *
 * Shown when `settings.onboarded` is not set, which is also true of a settings file
 * written before this screen existed — an existing install sees it once, which is
 * the intent: it is the only place the data directory can be chosen *before*
 * anything has been written into it.
 *
 * Everything here is applied live (the theme through the shell, the language
 * through the catalog) so the screen is its own preview.
 */
export function WelcomeScreen({ settings, onDone }: WelcomeScreenProps): JSX.Element {
  const [theme, setTheme] = useState(settings.theme)
  const [language, setLanguageState] = useState<Language>(settings.language)
  const [font, setFont] = useState(settings.terminal.fontFamily)
  const [fonts, setFonts] = useState<FontChoices | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [defaultDir, setDefaultDir] = useState('')
  const [moveData, setMoveData] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.listFonts().then(setFonts)
    void api.dataDirectory().then((status) => {
      setDefaultDir(status.default)
    })
  }, [])

  const pickTheme = (id: string): void => {
    setTheme(id)
    // Same call the settings dialog previews with: the palette lives in CSS custom
    // properties on the document, so nothing has to re-render.
    applyTheme(findTheme(id))
  }

  /** The same fallback stack the settings dialog builds, bundled faces first. */
  const stackFor = (family: string): string => {
    const quoted = /\s/.test(family) ? `"${family}"` : family
    return `${quoted}, "Roboto Mono", "JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`
  }

  const pickLanguage = (next: Language): void => {
    setLanguageState(next)
    setLanguage(next)
  }

  const chooseDirectory = async (): Promise<void> => {
    const picked = await api.pickDataDirectory()
    if (picked) setDir(picked)
  }

  const finish = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (dir) {
        const result = await api.setDataDirectory({ dir, move: moveData })
        if (!result.ok) {
          setError(result.message ?? 'Could not use that folder')
          setBusy(false)
          return
        }
      }
      const next: AppSettings = {
        ...settings,
        theme,
        language,
        onboarded: true,
        terminal: { ...settings.terminal, fontFamily: font }
      }
      await api.saveSettings(next)
      onDone(next)
      // A moved data directory only takes effect at start-up, so this is the last
      // thing that happens rather than something the user has to remember.
      if (dir) void api.restartApp()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const chips = fonts ? [...fonts.bundled, ...fonts.monospace].slice(0, 12) : []

  /*
   * Which chip is the chosen one: the *first* family in the stack.
   *
   * Testing "does the stack contain this name" lights up every bundled face at
   * once, because the fallbacks ("Roboto Mono", "JetBrains Mono") are in every
   * stack this screen builds — picking a font never appeared to unpick the last.
   * The settings dialog derives it the same way.
   */
  const primaryFamily = font.split(',')[0].trim().replace(/^["']|["']$/g, '')

  return (
    <div className="td-welcome" data-testid="welcome-screen">
      <div className="td-welcome-panel">
        <header className="td-welcome-head">
          <span className="td-welcome-mark" aria-hidden="true">
            ▚
          </span>
          <div>
            <h1>{t('welcome.title', 'Welcome to TermDeck')}</h1>
            <p className="td-hint">
              {t(
                'welcome.lead',
                'Four choices now, all of them changeable later in Settings.'
              )}
            </p>
          </div>
        </header>

        <div className="td-welcome-body">
          <label className="td-field">
            <span>{t('settingsdialog.language', 'Language')}</span>
            <select
              className="td-select"
              data-testid="welcome-language"
              value={language}
              onChange={(e) => pickLanguage(e.target.value as Language)}
            >
              {LANGUAGES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <div className="td-field">
            <span>{t('welcome.theme', 'Colour scheme')}</span>
            <div className="td-theme-grid" data-testid="welcome-themes">
              {THEMES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-theme-id={entry.id}
                  className={`td-theme-card${entry.id === theme ? ' is-active' : ''}`}
                  aria-pressed={entry.id === theme}
                  onClick={() => pickTheme(entry.id)}
                >
                  <span className="td-theme-swatch">
                    {entry.preview.map((colour) => (
                      <span key={colour} style={{ background: colour }} />
                    ))}
                  </span>
                  <span className="td-theme-meta">
                    <span className="td-theme-name">{entry.name}</span>
                    <span className="td-theme-scheme">{entry.scheme}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="td-field">
            <span>{t('settingsdialog.font_family', 'Font family')}</span>
            <div className="td-font-picks" data-testid="welcome-fonts">
              {chips.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`td-font-chip${primaryFamily === name ? ' is-active' : ''}`}
                  data-font={name}
                  style={{ fontFamily: `"${name}", monospace` }}
                  onClick={() => setFont(stackFor(name))}
                >
                  {name}
                </button>
              ))}
            </div>
            <p className="td-hint">
              {t('welcome.font_hint', 'The terminal font. The interface uses Inter.')}
            </p>
          </div>

          <div className="td-field">
            <span>{t('welcome.data_dir', 'Where settings and hosts are kept')}</span>
            <p className="td-hint td-mono" data-testid="welcome-data-dir">
              {dir ?? defaultDir}
            </p>
            <div className="td-row-actions">
              <button type="button" className="td-btn" data-testid="welcome-pick-dir" onClick={() => void chooseDirectory()}>
                {t('welcome.change_dir', 'Choose folder…')}
              </button>
              {dir && (
                <button type="button" className="td-btn" onClick={() => setDir(null)}>
                  {t('welcome.reset_dir', 'Use the default')}
                </button>
              )}
            </div>
            {dir && (
              <label className="td-check">
                <input
                  type="checkbox"
                  data-testid="welcome-move"
                  checked={moveData}
                  onChange={(e) => setMoveData(e.target.checked)}
                />
                <span>
                  {t('welcome.move_data', 'Copy my existing settings and hosts there')}
                </span>
              </label>
            )}
          </div>
        </div>

        {error && (
          <div className="td-form-error" data-testid="welcome-error">
            {error}
          </div>
        )}

        <footer className="td-welcome-foot">
          <button
            type="button"
            className="td-btn td-btn-primary td-welcome-start"
            data-testid="welcome-start"
            disabled={busy}
            onClick={() => void finish()}
          >
            {busy
              ? t('welcome.saving', 'Setting up…')
              : t('welcome.start', 'Get started')}
          </button>
        </footer>
      </div>
    </div>
  )
}
