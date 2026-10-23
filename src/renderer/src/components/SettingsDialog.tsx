import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AppSettings,
  BreakMode,
  BreakSettings,
  BreakStats,
  ClipboardSettings,
  CredentialStatus,
  FontChoices,
  Keybinding,
  LockStatus,
  ReconnectSettings,
  SidebarSectionState,
  TerminalSettings
} from '@shared/types'
import { DEFAULT_KEYBINDINGS, SIDEBAR_SECTION_LABELS, UI_SCALES } from '@shared/types'
import { THEMES, findTheme } from '@shared/themes'
import {
  HIGHLIGHT_RULES,
  HIGHLIGHT_SCHEMES,
  stylesFor,
  type HighlightSchemeId
} from '@shared/highlight'
import { formatEvent, isValidBinding, parseBinding } from './useShortcuts'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { applyTheme } from './useTheme'
import { LANGUAGES, setLanguage, t, type Language } from '../i18n'

const api = window.termdeck

type Tab =
  | 'appearance'
  | 'terminal'
  | 'clipboard'
  | 'shortcuts'
  | 'hostkeys'
  | 'wellbeing'
  | 'credentials'

interface SettingsDialogProps {
  settings: AppSettings
  credentialStatus: CredentialStatus
  /**
   * Apply an interface scale. Owned by the shell rather than called here, because
   * the docking layout has to be re-synced once the zoom lands and only the shell
   * can reach it.
   */
  onApplyScale: (scale: number) => void
  onClose: () => void
  onSaved: (settings: AppSettings) => void
  onCredentialChanged: (status: CredentialStatus) => void
  /** Current lock state (the password itself never reaches the renderer). */
  lockStatus: LockStatus
  onLockChanged: (status: LockStatus) => void
  /** Show the break reminder immediately, for "Try it now". */
  onPreviewBreak: () => void
  /** Open the host share dialog in the given mode. */
  onExportShare: () => void
  onImportShare: () => void
}

export function SettingsDialog({
  settings,
  credentialStatus,
  onApplyScale,
  onClose,
  onSaved,
  onCredentialChanged,
  lockStatus,
  onLockChanged,
  onPreviewBreak,
  onExportShare,
  onImportShare
}: SettingsDialogProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('appearance')
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Shortcut list interaction state.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  // Test hook: exposes what a save would actually send, so the smoke harness can
  // compare the rendered order against the payload rather than guessing.
  if (typeof window !== 'undefined' && window.localStorage.getItem('tdDebug') === '1') {
    ;(window as unknown as Record<string, unknown>)['__tdDraftBindings'] =
      draft.keybindings.map((b) => b.id)
  }

  const updateTerminal = (patch: Partial<TerminalSettings>): void =>
    setDraft((d) => ({ ...d, terminal: { ...d.terminal, ...patch } }))
  const updateClipboard = (patch: Partial<ClipboardSettings>): void =>
    setDraft((d) => ({ ...d, clipboard: { ...d.clipboard, ...patch } }))
  const updateReconnect = (patch: Partial<ReconnectSettings>): void =>
    setDraft((d) => ({ ...d, reconnect: { ...d.reconnect, ...patch } }))

  // ---- live theme preview -------------------------------------------------

  /**
   * Picking a theme applies it immediately so the choice can be judged in
   * context, rather than requiring a save first. Closing without saving puts the
   * stored theme back, so a preview can never strand the user in a theme they
   * did not accept.
   */
  const previewTheme = (id: string): void => {
    setDraft((d) => ({ ...d, theme: id }))
    applyTheme(findTheme(id))
  }

  /**
   * Interface scale previews too: it is applied on change so the result can be
   * judged rather than guessed, and closing without saving restores the stored
   * value along with the theme.
   */
  const previewScale = (scale: number): void => {
    setDraft((d) => ({ ...d, uiScale: scale }))
    onApplyScale(scale)
  }

  /** Language previews like the theme does: the whole dialog redraws at once. */
  const previewLanguage = (language: Language): void => {
    setDraft((d) => ({ ...d, language }))
    setLanguage(language)
  }

  const dismiss = (): void => {
    // Revert an unsaved preview.
    if (draft.theme !== settings.theme) applyTheme(findTheme(settings.theme))
    if (draft.uiScale !== settings.uiScale) onApplyScale(settings.uiScale)
    if (draft.language !== settings.language) setLanguage(settings.language)
    onClose()
  }

  /**
   * The drawer header's X and the backdrop close the drawer directly, without
   * going through `dismiss`. Previewing a theme or a scale is a live change, so
   * closing by any route has to put the stored values back — otherwise a preview
   * the user never accepted would outlive the dialog that offered it.
   *
   * The refs keep this deliberately **unmount-only**. A plain effect cleanup also
   * fires when the dependencies change, and saving does exactly that (the new
   * settings arrive before the dialog closes), which would undo the very value
   * that was just saved.
   */
  const lastAppliedRef = useRef({
    theme: draft.theme,
    scale: draft.uiScale,
    language: draft.language
  })
  lastAppliedRef.current = { theme: draft.theme, scale: draft.uiScale, language: draft.language }

  const savedRef = useRef({
    theme: settings.theme,
    scale: settings.uiScale,
    language: settings.language
  })
  savedRef.current = { theme: settings.theme, scale: settings.uiScale, language: settings.language }

  // `onApplyScale` is stable (the shell memoises it), so it is deliberately not
  // a dependency: this must run only on unmount.
  const applyScaleRef = useRef(onApplyScale)
  applyScaleRef.current = onApplyScale

  useEffect(
    () => () => {
      const applied = lastAppliedRef.current
      const saved = savedRef.current
      if (applied.theme !== saved.theme) applyTheme(findTheme(saved.theme))
      if (applied.scale !== saved.scale) applyScaleRef.current(saved.scale)
      if (applied.language !== saved.language) setLanguage(saved.language)
    },
    []
  )

  // ---- shortcut recording -------------------------------------------------

  useEffect(() => {
    if (!recording) return

    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRecording(null)
        return
      }

      const formatted = formatEvent(e)
      if (!formatted) return // waiting for a non-modifier key
      if (!isValidBinding(formatted)) return

      setBindingKeys(recording, formatted)
      setError(null)
      setRecording(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  /**
   * Set a shortcut by binding id.
   *
   * A snippet carries its own key rather than owning a row in `keybindings`, so
   * the id decides which list is written — `snippet:<id>` goes to the snippet and
   * everything else to the binding list.
   */
  const setBindingKeys = (id: string, keys: string): void =>
    setDraft((d) =>
      id.startsWith('snippet:')
        ? {
            ...d,
            snippets: d.snippets.map((s) =>
              s.id === id.slice('snippet:'.length) ? { ...s, keys: keys || undefined } : s
            )
          }
        : {
            ...d,
            keybindings: d.keybindings.map((b) => (b.id === id ? { ...b, keys } : b))
          }
    )

  /**
   * Every shortcut in the app, in one namespace, so a clash can be found.
   *
   * Snippet shortcuts are included because they compete for the same keys: two
   * snippets on one chord, or a snippet on top of a built-in, would leave the
   * dispatcher picking whichever happens to come first in the list — the user's
   * key would appear to work "sometimes".
   */
  const shortcutsInUse = useMemo(
    () => [
      ...draft.keybindings,
      ...draft.snippets
        .filter((snippet) => !!snippet.keys)
        .map((snippet) => ({
          id: `snippet:${snippet.id}`,
          label: snippet.label,
          keys: snippet.keys as string
        }))
    ],
    [draft.keybindings, draft.snippets]
  )

  const conflicts = useMemo(() => {
    // Keyed by the lower-cased chord for comparison, but the original spelling and
    // the labels are what get shown — `ctrl+t` in a warning about key names reads
    // like a different key from the one the user just pressed.
    const byKeys = new Map<string, { keys: string; labels: string[] }>()
    for (const binding of shortcutsInUse) {
      if (!binding.keys) continue
      const normalised = binding.keys.toLowerCase()
      const existing = byKeys.get(normalised)
      if (existing) existing.labels.push(binding.label)
      else byKeys.set(normalised, { keys: binding.keys, labels: [binding.label] })
    }
    const out = new Map<string, { keys: string; labels: string[] }>()
    for (const [normalised, entry] of byKeys) {
      if (entry.labels.length > 1) out.set(normalised, entry)
    }
    return out
  }, [shortcutsInUse])

  /** Is this key one of the clashing ones? Used to mark the row itself. */
  const clashesOn = (keys: string | undefined): boolean =>
    !!keys && conflicts.has(keys.toLowerCase())

  /** Reorder by dropping `from` onto `to`. */
  const reorder = (from: string, to: string): void => {
    if (from === to) return
    setDraft((d) => {
      const list = [...d.keybindings]
      const fromIndex = list.findIndex((b) => b.id === from)
      const toIndex = list.findIndex((b) => b.id === to)
      if (fromIndex < 0 || toIndex < 0) return d
      const [moved] = list.splice(fromIndex, 1)
      list.splice(toIndex, 0, moved)
      return { ...d, keybindings: list }
    })
  }

  const shortcutMenuItems = (binding: Keybinding): MenuItem[] => {    const original = DEFAULT_KEYBINDINGS.find((b) => b.id === binding.id)
    return [
      { id: 'rebind', label: t('settingsdialog.change_shortcut', 'Change shortcut...') },
      { id: 'clear', label: t('settingsdialog.remove_shortcut', 'Remove shortcut'), disabled: !binding.keys },
      {
        id: 'reset',
        label: t('settingsdialog.reset_to_default', 'Reset to default'),
        disabled: !original || original.keys === binding.keys,
        separatorBefore: true
      },
      { id: 'moveUp', label: t('settingsdialog.move_up', 'Move up') },
      { id: 'moveDown', label: t('settingsdialog.move_down', 'Move down') }
    ]
  }

  const runShortcutAction = (binding: Keybinding, actionId: string): void => {
    if (actionId === 'rebind') setRecording(binding.id)
    else if (actionId === 'clear') setBindingKeys(binding.id, '')
    else if (actionId === 'reset') {
      const original = DEFAULT_KEYBINDINGS.find((b) => b.id === binding.id)
      if (original) setBindingKeys(binding.id, original.keys)
    } else if (actionId === 'moveUp' || actionId === 'moveDown') {
      setDraft((d) => {
        const list = [...d.keybindings]
        const index = list.findIndex((b) => b.id === binding.id)
        const next = actionId === 'moveUp' ? index - 1 : index + 1
        if (index < 0 || next < 0 || next >= list.length) return d
        const [moved] = list.splice(index, 1)
        list.splice(next, 0, moved)
        return { ...d, keybindings: list }
      })
    }
  }

  const save = async (): Promise<void> => {
    /*
     * A duplicated chord is refused, not resolved: two bindings on one key means
     * whichever comes first in the list wins, so "it works sometimes" is the only
     * outcome the app could promise. The rows above say which two.
     */
    if (conflicts.size > 0) {
      setError(
        t(
          'settingsdialog.resolve_conflicting_short',
          'Fix the conflicting shortcuts before saving — the same key is used twice.'
        )
      )
      return
    }
    try {
      const saved = await api.saveSettings(draft)
      onSaved(saved)
      setError(null)
      /*
       * Close once the settings are in. Saving used to leave the drawer open with
       * "Saved" showing, which reads as nothing happened and keeps a modal in front of
       * the terminals; the state is already stored, so closing is the confirmation.
       */
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="td-settings">
        <nav className="td-settings-tabs">
          {(
            [
              ['appearance', 'Appearance'],
              ['terminal', 'Terminal'],
              ['clipboard', 'Clipboard'],
              ['shortcuts', 'Shortcuts'],
              ['hostkeys', 'Host keys'],
              ['wellbeing', 'Wellbeing'],
              ['credentials', 'Credentials']
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`td-settings-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {t('settingstab.' + id, label)}
            </button>
          ))}
        </nav>

          <div className="td-settings-body">
            {tab === 'appearance' && (
              <ThemeTab
                activeTheme={draft.theme}
                savedTheme={settings.theme}
                onPick={previewTheme}
                scale={draft.uiScale}
                savedScale={settings.uiScale}
                onScale={previewScale}
                language={draft.language}
                onLanguage={previewLanguage}
              />
            )}

            {tab === 'terminal' && (
              <>
                <TerminalTab settings={draft.terminal} onChange={updateTerminal} />
                <ReconnectTab settings={draft.reconnect} onChange={updateReconnect} />
              </>
            )}

            {tab === 'clipboard' && (
              <ClipboardTab settings={draft.clipboard} onChange={updateClipboard} />
            )}

            {tab === 'wellbeing' && (
              <WellbeingTab
                breakSettings={draft.break}
                breakStats={draft.breakStats}
                sections={draft.sidebar.sections}
                lockStatus={lockStatus}
                onBreak={(patch) => setDraft((d) => ({ ...d, break: { ...d.break, ...patch } }))}
                onSections={(sections) =>
                  setDraft((d) => ({ ...d, sidebar: { ...d.sidebar, sections } }))
                }
                onLockChanged={onLockChanged}
                onPreviewBreak={onPreviewBreak}
              />
            )}

            {tab === 'shortcuts' && (
              <div className="td-field-stack">
                <p className="td-hint">
                  {t('settingsdialog.click_a_shortcut_and_press_t', 'Click a shortcut and press the new combination (')}<kbd>{t('settingsdialog.esc', 'Esc')}</kbd> {t('settingsdialog.cancels_or_right_click_a_row', 'cancels), or right-click a row for more. Drag rows to change their order.')}
                </p>
                {/*
                  The digit family is not a row: which number means which session is
                  the order the panes are laid out in, so it is shown here instead of
                  being editable. The three families are named together because they
                  are what people actually reach for, and two of them are not in the
                  list below at all (the digits) or carry aliases the list cannot
                  express (zoom).
                */}
                <p className="td-hint" data-testid="page-shortcuts">
                  <kbd>{t('settingsdialog.alt', 'Alt')}</kbd>+<kbd>1</kbd>…<kbd>9</kbd> {t('settingsdialog.jumps_straight_to_a_session', 'jumps straight to a session — 1 is the first pane in the arrangement, 2 the second, and so on.')}{' '}
                  <kbd>{t('settingsdialog.alt_2', 'Alt')}</kbd>+<kbd>[</kbd> and <kbd>{t('settingsdialog.alt_3', 'Alt')}</kbd>+<kbd>]</kbd> {t('settingsdialog.step_to_the_previous_and_nex', 'step to the previous and next session and wrap around at both ends.')}{' '}
                  <kbd>{t('settingsdialog.ctrl', 'Ctrl')}</kbd>+<kbd>=</kbd> and <kbd>{t('settingsdialog.ctrl_2', 'Ctrl')}</kbd>+<kbd>-</kbd> {t('settingsdialog.make_the_whole_interface_lar', 'make the whole interface larger and smaller, a step at a time through the sizes on the Appearance tab.')}
                </p>
                {[...conflicts.values()].map((entry) => (
                  <div key={entry.keys} className="td-form-error" data-testid="shortcut-conflict">
                    {t('settingsdialog.shortcut_conflict_on', 'Shortcut conflict on')}{' '}
                    <b>{entry.keys}</b>: {entry.labels.join(', ')}
                  </div>
                ))}
                <ul className="td-shortcut-list" data-testid="shortcut-list">
                  {draft.keybindings.map((binding) => (
                    <li
                      key={binding.id}
                      className={`td-shortcut-row${dragging === binding.id ? ' is-dragging' : ''}${
                        dropTarget === binding.id ? ' is-drop' : ''
                      }`}
                      data-binding-id={binding.id}
                      draggable
                      onDragStart={(e) => {
                        dragIdRef.current = binding.id
                        setDragging(binding.id)
                        e.dataTransfer.setData('text/plain', binding.id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        dragIdRef.current = null
                        setDragging(null)
                        setDropTarget(null)
                      }}
                      onDragOver={(e) => {
                        if (!dragIdRef.current) return
                        e.preventDefault()
                        if (dropTarget !== binding.id) setDropTarget(binding.id)
                      }}
                      onDragLeave={() => setDropTarget((c) => (c === binding.id ? null : c))}
                      onDrop={(e) => {
                        e.preventDefault()
                        const from =
                          dragIdRef.current || e.dataTransfer.getData('text/plain')
                        setDropTarget(null)
                        setDragging(null)
                        dragIdRef.current = null
                        if (from) reorder(from, binding.id)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, id: binding.id })
                      }}
                    >
                      <span className="td-drag-grip" title={t('settingsdialog.drag_to_reorder', 'Drag to reorder')}>
                        ⠿
                      </span>
                      <span className="td-shortcut-label">
                        {t('keybinding.' + binding.id, binding.label)}
                      </span>
                      <button
                        className={`td-key-btn${recording === binding.id ? ' is-recording' : ''}${
                          binding.keys ? '' : ' is-empty'
                        }${clashesOn(binding.keys) ? ' is-conflict' : ''}`}
                        data-testid={`binding-${binding.id}`}
                        onClick={() => setRecording(binding.id)}
                      >
                        {recording === binding.id ? 'Press keys...' : binding.keys || 'Not set'}
                      </button>
                      <button
                        className="td-mini"
                        title={t('settingsdialog.remove_shortcut_2', 'Remove shortcut')}
                        onClick={() => setBindingKeys(binding.id, '')}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>

                {/*
                  Snippet shortcuts live on the snippet, not in the list above, but
                  they are matched by the same dispatcher and so compete for the same
                  keys. They are shown here so a clash with a built-in is visible in
                  the place where clashes are resolved — and so saving is blocked by
                  the same check rather than by a second rule.
                */}
                {draft.snippets.length > 0 && (
                  <>
                    <p className="td-hint td-settings-spaced" data-testid="snippet-shortcut-heading">
                      {t(
                        'settingsdialog.snippet_shortcuts',
                        'Snippet shortcuts — set in a snippet’s editor, listed here because they take part in the same conflict check.'
                      )}
                    </p>
                    <ul className="td-shortcut-list" data-testid="snippet-shortcut-list">
                      {draft.snippets.map((snippet) => (
                        <li
                          key={snippet.id}
                          className="td-shortcut-row"
                          data-snippet-id={snippet.id}
                        >
                          <span className="td-shortcut-label">{snippet.label}</span>
                          <button
                            className={`td-key-btn${
                              recording === `snippet:${snippet.id}` ? ' is-recording' : ''
                            }${snippet.keys ? '' : ' is-empty'}${
                              clashesOn(snippet.keys) ? ' is-conflict' : ''
                            }`}
                            data-testid={`snippet-binding-${snippet.id}`}
                            onClick={() => setRecording(`snippet:${snippet.id}`)}
                          >
                            {recording === `snippet:${snippet.id}`
                              ? 'Press keys...'
                              : snippet.keys || t('settingsdialog.not_set', 'Not set')}
                          </button>
                          <button
                            className="td-mini"
                            title={t('settingsdialog.remove_shortcut_2', 'Remove shortcut')}
                            onClick={() => setBindingKeys(`snippet:${snippet.id}`, '')}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {tab === 'hostkeys' && (
              <div className="td-field-stack">
                <label className="td-field">
                  <span>{t('settingsdialog.unknown_host_keys', 'Unknown host keys')}</span>
                  <select
                    className="td-select"
                    value={draft.hostKeys.policy}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        hostKeys: { policy: e.target.value as AppSettings['hostKeys']['policy'] }
                      }))
                    }
                  >
                    <option value="ask">{t('settingsdialog.ask_me_show_the_fingerprint', 'Ask me (show the fingerprint)')}</option>
                    <option value="strict">{t('settingsdialog.refuse_to_connect', 'Refuse to connect')}</option>
                    <option value="trust">{t('settingsdialog.trust_on_first_use_insecure', 'Trust on first use (insecure)')}</option>
                  </select>
                </label>
                <p className="td-hint">
                  A <b>changed</b> {t('settingsdialog.host_key_is_never_accepted_a', 'host key is never accepted automatically, even under "trust on first use" — that is exactly the case a man-in-the-middle would produce.')}
                </p>
              </div>
            )}

            {tab === 'credentials' && (
              <CredentialsTab
                status={credentialStatus}
                onChanged={onCredentialChanged}
                onExportShare={onExportShare}
                onImportShare={onImportShare}
              />
            )}
          </div>
        </div>

      {error && <div className="td-form-error td-settings-error">{error}</div>}

      <div className="td-drawer-actions">
        <span className="td-spacer" />
        <button className="td-btn" onClick={dismiss}>
          {t('settingsdialog.close', 'Close')}
        </button>
        <button
          className="td-btn td-btn-primary"
          data-testid="settings-save"
          disabled={!dirty}
          onClick={() => void save()}
        >
          {dirty
            ? t('settingsdialog.save_settings', 'Save settings')
            : t('settingsdialog.saved', 'Saved')}
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={shortcutMenuItems(
            draft.keybindings.find((b) => b.id === menu.id) as Keybinding
          )}
          onSelect={(actionId) => {
            const binding = draft.keybindings.find((b) => b.id === menu.id)
            if (binding) runShortcutAction(binding, actionId)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

// ---- tabs ---------------------------------------------------------------

/** Theme picker. Picking a theme previews it immediately. */
function ThemeTab({
  activeTheme,
  savedTheme,
  onPick,
  scale,
  savedScale,
  onScale,
  language,
  onLanguage
}: {
  activeTheme: string
  savedTheme: string
  onPick: (id: string) => void
  scale: number
  savedScale: number
  onScale: (scale: number) => void
  language: Language
  onLanguage: (language: Language) => void
}): JSX.Element {
  const previewing = activeTheme !== savedTheme

  return (
    <div className="td-field-stack">
      {/*
        Language sits above the themes because it changes every label in this
        dialog — including the ones below it, which is also the fastest way to see
        what the choice does.
      */}
      <label className="td-field">
        <span>{t('settingsdialog.language', 'Language')}</span>
        <select
          className="td-select"
          aria-label="language"
          data-testid="language-pick"
          value={language}
          onChange={(e) => onLanguage(e.target.value as Language)}
        >
          {LANGUAGES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <div className="td-theme-head">
        <p className="td-hint">
          {t('settingsdialog.pick_a_theme_to_preview_it_s', 'Pick a theme to preview it straight away — the whole app and the terminal change together. Press')}<b>{t('settingsdialog.save_settings', 'Save settings')}</b> {t('settingsdialog.to_keep_it', 'to keep it.')}
        </p>
        {previewing && (
          <span className="td-preview-badge" data-testid="theme-previewing">
            {t('settingsdialog.previewing', 'Previewing')}{findTheme(activeTheme).name}
          </span>
        )}
      </div>

      <div className="td-theme-grid" data-testid="theme-grid">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            data-theme-id={theme.id}
            aria-pressed={theme.id === activeTheme}
            className={`td-theme-card${theme.id === activeTheme ? ' is-active' : ''}`}
            onClick={() => onPick(theme.id)}
          >
            <span className="td-theme-swatch">
              {theme.preview.map((color) => (
                <span key={color} style={{ background: color }} />
              ))}
            </span>
            <span className="td-theme-meta">
              <span className="td-theme-name">{theme.name}</span>
              <span className="td-theme-scheme">{theme.scheme}</span>
            </span>
            {theme.id === savedTheme && <span className="td-theme-saved">saved</span>}
          </button>
        ))}
      </div>

      {/*
        Interface scale. A dense desktop UI is uncomfortable on a wide monitor and
        there was previously nothing the user could do about it; this scales every
        measurement together rather than only the terminal font.

        The chips are `UI_SCALES` itself, the same ladder `Ctrl`+`=` / `Ctrl`+`-`
        step through. They used to be their own, shorter list, which meant the
        shortcut could land on a size no chip showed — a highlighted nothing.
      */}
      <div className="td-field">
        <span>{t('settingsdialog.interface_size', 'Interface size')}</span>
        <div className="td-scale-picks" data-testid="scale-picks">
          {UI_SCALES.map((value) => (
            <button
              key={value}
              type="button"
              className={`td-scale-chip${Math.abs(value - scale) < 0.001 ? ' is-active' : ''}`}
              data-scale={value}
              aria-pressed={Math.abs(value - scale) < 0.001}
              onClick={() => onScale(value)}
            >
              {Math.round(value * 100)}%
            </button>
          ))}
        </div>
        <span className="td-hint" data-testid="scale-hint">
          {Math.abs(scale - savedScale) < 0.001
            ? `Currently ${Math.round(scale * 100)}%. Scales the rail, sidebar, dialogs and terminal together.`
            : `Previewing ${Math.round(scale * 100)}% (saved: ${Math.round(savedScale * 100)}%). Press Save settings to keep it.`}
        </span>
      </div>
    </div>
  )
}

/** Read-only view of how credentials are protected on this machine. */
function CredentialsTab({
  status,
  onExportShare,
  onImportShare
}: {
  status: CredentialStatus
  onChanged: (s: CredentialStatus) => void
  /** Open the host share dialog, which lives in the shell beside this drawer. */
  onExportShare: () => void
  onImportShare: () => void
}): JSX.Element {
  return (
    <div className="td-field-stack" data-testid="credentials-tab">
      <div className="td-cred-badge">
        <span className="td-cred-icon">🔒</span>
        <div>
          <strong>{t('settingsdialog.passwords_are_saved_and_encr', 'Passwords are saved and encrypted automatically')}</strong>
          <p className="td-hint">{status.detail}</p>
        </div>
      </div>

      <dl className="td-kv">
        <dt>{t('settingsdialog.protection', 'Protection')}</dt>
        <dd>{status.backend === 'os' ? 'OS keychain' : 'Local key file'}</dd>
        <dt>{t('settingsdialog.encryption', 'Encryption')}</dt>
        <dd>{status.encrypted ? 'AES-256-GCM' : 'None'}</dd>
        <dt>{t('settingsdialog.sessions_with_saved_credenti', 'Sessions with saved credentials')}</dt>
        <dd data-testid="credential-count">{status.credentialCount}</dd>
      </dl>

      {status.backend === 'local' && (
        <p className="td-hint">
          {t('settingsdialog.this_system_exposes_no_os_ke', 'This system exposes no OS keychain to the app, so the encryption key lives in a file next to the data with owner-only permissions. That protects against casual reading, not against someone who can already read your user profile.')}
        </p>
      )}

      {/*
        Host import/export sits here as well as on the Hosts page.

        This is where people look for "move my data to another machine" — next to
        the thing being moved — and the Hosts page toolbar is where they look for
        "get my host list in and out". Both open the same dialog.
      */}
      <div className="td-field" data-testid="credentials-share">
        <span>{t('settingsdialog.hosts_backup', 'Hosts backup')}</span>
        <p className="td-hint">
          {t(
            'settingsdialog.hosts_backup_hint',
            'Export every group and host into one encrypted file (passwords included, if you want), or read a file someone shared with you.'
          )}
        </p>
        <div className="td-row-actions">
          <button
            type="button"
            className="td-btn"
            data-testid="credentials-export"
            onClick={onExportShare}
          >
            {t('settingsdialog.export_hosts', 'Export hosts…')}
          </button>
          <button
            type="button"
            className="td-btn"
            data-testid="credentials-import"
            onClick={onImportShare}
          >
            {t('settingsdialog.import_hosts', 'Import hosts…')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * What happens when a connection drops on its own.
 *
 * Separate from the terminal's own settings because it is not about how a
 * terminal looks: it is the policy for a host that went away underneath a pane.
 */
function ReconnectTab({
  settings,
  onChange
}: {
  settings: ReconnectSettings
  onChange: (patch: Partial<ReconnectSettings>) => void
}): JSX.Element {
  return (
    <div className="td-field-stack td-settings-spaced" data-testid="reconnect-tab">
      <h3 className="td-settings-heading">
        {t('settingsdialog.dropped_connections', 'Dropped connections')}
      </h3>
      <label className="td-check">
        <input
          type="checkbox"
          aria-label="reconnect-enabled"
          checked={settings.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.retry_automatically', 'Retry automatically')}</b>{' '}
          {t(
            'settingsdialog.retry_automatically_hint',
            '— only for a connection that drops by itself. A shell you ended yourself stays ended, and Ctrl+R retries by hand at any time.'
          )}
        </span>
      </label>

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.attempts', 'Attempts')}</span>
          <input
            type="number"
            aria-label="reconnect-attempts"
            min={0}
            max={10}
            disabled={!settings.enabled}
            value={settings.attempts}
            onChange={(e) => onChange({ attempts: Number(e.target.value) })}
          />
        </label>
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.seconds_between_attempts', 'Seconds between attempts')}</span>
          <input
            type="number"
            aria-label="reconnect-delay"
            min={1}
            max={120}
            disabled={!settings.enabled}
            value={settings.delaySeconds}
            onChange={(e) => onChange({ delaySeconds: Number(e.target.value) })}
          />
        </label>
      </div>
    </div>
  )
}

function TerminalTab({
  settings,
  onChange
}: {
  settings: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
}): JSX.Element {
  const [fonts, setFonts] = useState<FontChoices>({
    bundled: [],
    monospace: [],
    others: [],
    suggested: []
  })

  useEffect(() => {
    let active = true
    // Enumerated by the main process; a failure just leaves the installed list
    // empty and the field stays free-text.
    void window.termdeck.listFonts().then((list) => {
      if (active) setFonts(list)
    })
    return () => {
      active = false
    }
  }, [])

  /**
   * The setting stores a full CSS stack, but the picker shows the primary family.
   * Choosing one rebuilds the stack with sensible fallbacks rather than
   * discarding them, so a font that lacks a glyph still falls back correctly.
   */
  const primaryFamily = settings.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')

  const setFamily = (family: string): void => {
    const quoted = /\s/.test(family) ? `"${family}"` : family
    onChange({
      // The bundled faces lead the fallback stack, because they are the only ones
      // guaranteed to exist on this machine.
      fontFamily: `${quoted}, "Roboto Mono", "JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`
    })
  }

  /** A live sample, so the choice can be judged rather than guessed. */
  const previewFamily = primaryFamily || 'monospace'

  /** What the chips offer: everything that will really render. */
  const choices = [...fonts.bundled, ...fonts.monospace].slice(0, 16)

  return (
    <div className="td-field-stack">
      <label className="td-field">
        <span>{t('settingsdialog.font_family', 'Font family')}</span>
        <input
          aria-label="font-family"
          list="td-font-choices"
          value={primaryFamily}
          placeholder={t('settingsdialog.type_or_pick_a_font', 'Type or pick a font')}
          onChange={(e) => setFamily(e.target.value)}
        />
        <datalist id="td-font-choices">
          {fonts.bundled.map((name) => (
            <option key={`bundled-${name}`} value={name} label={t('settingsdialog.ships_with_termdeck', 'ships with TermDeck')} />
          ))}
          {fonts.monospace.map((name) => (
            <option key={`mono-${name}`} value={name} />
          ))}
          {fonts.others.map((name) => (
            <option key={`other-${name}`} value={name} />
          ))}
          {/*
           * Offered for autocomplete only, and labelled: these are the names a
           * desktop usually has, and picking one that is not installed renders as
           * the fallback — which is exactly what used to happen silently.
           */}
          {fonts.suggested.map((name) => (
            <option key={`suggested-${name}`} value={name} label={t('settingsdialog.not_installed', 'not installed')} />
          ))}
        </datalist>
        <span className="td-hint" data-testid="font-hint">
          {fonts.bundled.length > 0
            ? `${fonts.bundled.length} ship with TermDeck, ` +
              (fonts.monospace.length > 0
                ? `${fonts.monospace.length} monospaced fonts found on this system, `
                : 'no monospaced fonts could be read from this system, ') +
              `plus ${fonts.others.length} others. Type to filter.`
            : 'Could not read the installed fonts; type a family name instead.'}
        </span>
      </label>

      {choices.length > 0 && (
        <div className="td-font-picks" data-testid="font-picks">
          {choices.map((name) => (
            <button
              key={name}
              type="button"
              className={`td-font-chip${primaryFamily === name ? ' is-active' : ''}`}
              data-font={name}
              data-bundled={fonts.bundled.includes(name) ? 'true' : undefined}
              title={fonts.bundled.includes(name) ? 'Ships with TermDeck' : 'Installed on this system'}
              style={{ fontFamily: `"${name}", monospace` }}
              onClick={() => setFamily(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="td-font-preview" style={{ fontFamily: `"${previewFamily}", monospace` }} data-testid="font-preview">
        <span>{t('settingsdialog.monospace_0123456789', 'Monospace 0123456789')}</span>
        <span className="td-font-preview-dim">{t('settingsdialog.git_commit_m_quot_fix_quot', 'git commit -m &quot;fix&quot; ·')}{`{ } ( ) => ; | ~`}</span>
      </div>

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.font_size', 'Font size')}</span>
          <input
            aria-label="font-size"
            type="number"
            min={8}
            max={32}
            value={settings.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) || 14 })}
          />
        </label>
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.line_height', 'Line height')}</span>
          <input
            aria-label="line-height"
            type="number"
            step={0.1}
            min={0.8}
            max={2}
            value={settings.lineHeight}
            onChange={(e) => onChange({ lineHeight: Number(e.target.value) || 1.2 })}
          />
        </label>
      </div>

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.cursor', 'Cursor')}</span>
          <select
            aria-label="cursor-style"
            className="td-select"
            value={settings.cursorStyle}
            onChange={(e) =>
              onChange({ cursorStyle: e.target.value as TerminalSettings['cursorStyle'] })
            }
          >
            <option value="outline">{t('settingsdialog.outline_hollow_box', 'Outline (hollow box)')}</option>
            <option value="bar">{t('settingsdialog.bar', 'Bar')}</option>
            <option value="block">{t('settingsdialog.block', 'Block')}</option>
            <option value="underline">{t('settingsdialog.underline', 'Underline')}</option>
          </select>
        </label>
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.scrollback_lines', 'Scrollback lines')}</span>
          <input
            aria-label="scrollback"
            type="number"
            min={0}
            max={1000000}
            step={1000}
            value={settings.scrollback}
            onChange={(e) => onChange({ scrollback: Number(e.target.value) || 0 })}
          />
        </label>
      </div>

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.cursor_blink', 'Cursor blink')}</span>
          <select
            aria-label="cursor-blink-rate"
            className="td-select"
            value={settings.cursorBlink ? String(settings.cursorBlinkMs) : 'off'}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'off') onChange({ cursorBlink: false })
              else onChange({ cursorBlink: true, cursorBlinkMs: Number(v) })
            }}
          >
            <option value="off">{t('settingsdialog.off_steady', 'Off (steady)')}</option>
            <option value="1200">{t('settingsdialog.slow_1_2s', 'Slow — 1.2s')}</option>
            <option value="900">{t('settingsdialog.relaxed_0_9s', 'Relaxed — 0.9s')}</option>
            <option value="650">{t('settingsdialog.normal_0_65s', 'Normal — 0.65s')}</option>
            <option value="400">{t('settingsdialog.fast_0_4s', 'Fast — 0.4s')}</option>
          </select>
        </label>
        <div className="td-field td-field-grow" />
      </div>

      <label className="td-check">
        <input
          type="checkbox"
          aria-label="suggest-commands"
          checked={settings.suggestions}
          onChange={(e) => onChange({ suggestions: e.target.checked })}
        />
        <span>
          {t('settingsdialog.suggest_commands', 'Suggest commands from history while typing. Up and Down pick one, Enter puts it on the line without running it.')}
        </span>
      </label>
      <label className="td-check">
        <input
          type="checkbox"
          aria-label="show-timestamps"
          checked={settings.showTimestamps}
          onChange={(e) => onChange({ showTimestamps: e.target.checked })}
        />
        <span>
          {t('settingsdialog.show_a_timestamp_column_besi', 'Show a timestamp column beside each pane. Times are recorded per line as output arrives; they are not saved with the session.')}
        </span>
      </label>

      {/*
        Output highlighting. The detail rows appear only when it is on: an off switch
        with a palette and eight checkboxes under it reads as settings that apply.
      */}
      <label className="td-check">
        <input
          type="checkbox"
          aria-label="highlight-output"
          data-testid="highlight-enabled"
          checked={settings.highlightEnabled}
          onChange={(e) => onChange({ highlightEnabled: e.target.checked })}
        />
        <span>
          {t('settingsdialog.highlight_output', 'Colour addresses, links and error words in the output. Only the display changes — the text itself, and anything you copy or save, stays exactly as the remote sent it.')}
        </span>
      </label>

      {settings.highlightEnabled && (
        <>
          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>{t('settingsdialog.highlight_scheme', 'Colour scheme')}</span>
              <select
                className="td-select"
                aria-label="highlight-scheme"
                data-testid="highlight-scheme"
                value={settings.highlightScheme}
                onChange={(e) =>
                  onChange({ highlightScheme: e.target.value as HighlightSchemeId })
                }
              >
                {HIGHLIGHT_SCHEMES.map((scheme) => (
                  <option key={scheme.id} value={scheme.id}>
                    {t('highlight.scheme.' + scheme.id, scheme.english)}
                  </option>
                ))}
              </select>
            </label>
            <div className="td-field td-field-grow" />
          </div>

          <div className="td-field">
            <span>{t('settingsdialog.highlight_what', 'Highlight these')}</span>
            <div className="td-highlight-rules" data-testid="highlight-rules">
              {HIGHLIGHT_RULES.map((rule) => {
                const style = stylesFor(settings.highlightScheme)[rule.id]
                const on = settings.highlightRules.includes(rule.id)
                return (
                  <label
                    key={rule.id}
                    className={`td-highlight-rule${on ? ' is-on' : ''}`}
                    data-rule={rule.id}
                  >
                    <input
                      type="checkbox"
                      aria-label={'highlight-rule-' + rule.id}
                      data-testid="highlight-rule"
                      data-rule={rule.id}
                      checked={on}
                      onChange={() =>
                        onChange({
                          highlightRules: on
                            ? settings.highlightRules.filter((id) => id !== rule.id)
                            : [...settings.highlightRules, rule.id]
                        })
                      }
                    />
                    {/* The swatch is the scheme's real colours, so the palette is
                        readable without applying it and guessing. */}
                    <span
                      className="td-highlight-swatch"
                      style={{ color: style.fg, background: style.bg }}
                      data-contrast-exempt
                    >
                      Aa
                    </span>
                    <span>{t('highlight.rule.' + rule.id, rule.english)}</span>
                  </label>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ClipboardTab({
  settings,
  onChange
}: {
  settings: ClipboardSettings
  onChange: (patch: Partial<ClipboardSettings>) => void
}): JSX.Element {
  return (
    <div className="td-field-stack">
      <label className="td-check">
        <input
          type="checkbox"
          aria-label="copy-on-select"
          checked={settings.copyOnSelect}
          onChange={(e) => onChange({ copyOnSelect: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.copy_on_select', 'Copy on select')}</b> {t('settingsdialog.dragging_over_text_copies_it', '— dragging over text copies it immediately. Leaves')}{' '}
          <kbd>{t('settingsdialog.ctrl_3', 'Ctrl')}</kbd>+<kbd>C</kbd> {t('settingsdialog.free_for_the_remote_shell', 'free for the remote shell.')}
        </span>
      </label>

      <label className="td-check">
        <input
          type="checkbox"
          aria-label="paste-on-right-click"
          checked={settings.pasteOnRightClick}
          onChange={(e) => onChange({ pasteOnRightClick: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.right_click_paste', 'Right-click paste')}</b> {t('settingsdialog.paste_the_clipboard_instead', '— paste the clipboard instead of opening a menu.')}
        </span>
      </label>

      <label className="td-check">
        <input
          type="checkbox"
          aria-label="paste-on-middle-click"
          checked={settings.pasteOnMiddleClick}
          onChange={(e) => onChange({ pasteOnMiddleClick: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.middle_click_paste', 'Middle-click paste')}</b> {t('settingsdialog.paste_with_the_middle_mouse', '— paste with the middle mouse button.')}
        </span>
      </label>

      <label className="td-check">
        <input
          type="checkbox"
          aria-label="confirm-multiline-paste"
          checked={settings.confirmMultilinePaste}
          onChange={(e) => onChange({ confirmMultilinePaste: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.confirm_multi_line_paste', 'Confirm multi-line paste')}</b> {t('settingsdialog.ask_before_sending_several_c', '— ask before sending several commands at once.')}
        </span>
      </label>
    </div>
  )
}

/** Debug helper used by the smoke probe to assert on binding syntax. */
export function describeBinding(binding: string): string {
  const parsed = parseBinding(binding)
  return parsed ? `${parsed.key} ctrl=${parsed.ctrl} shift=${parsed.shift}` : 'invalid'
}

/**
 * Breaks, the lock, and which drawer sections are showing.
 *
 * The lock password is not part of `draft`: it lives in the encrypted vault and
 * is written the moment it is set, so closing the dialog without saving never
 * leaves the user believing a password is in place when it is not.
 */
export function WellbeingTab({
  breakSettings,
  breakStats,
  sections,
  lockStatus,
  onBreak,
  onSections,
  onLockChanged,
  onPreviewBreak
}: {
  breakSettings: BreakSettings
  breakStats: BreakStats
  sections: SidebarSectionState[]
  lockStatus: LockStatus
  onBreak: (patch: Partial<BreakSettings>) => void
  onSections: (sections: SidebarSectionState[]) => void
  onLockChanged: (status: LockStatus) => void
  onPreviewBreak: () => void
}): JSX.Element {
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState<string | null>(null)

  const commitLock = async (next: string | null): Promise<void> => {
    const status = await api.saveLock({ password: next })
    onLockChanged(status)
    setPassword('')
    setSaved(next ? 'Password saved.' : 'Password cleared — the lock now opens on a click.')
  }

  return (
    <div className="td-field-stack" data-testid="wellbeing-tab">
      <h3 className="td-settings-heading">{t('settingsdialog.break_reminder', 'Break reminder')}</h3>
      <label className="td-check">
        <input
          type="checkbox"
          aria-label="break-enabled"
          checked={breakSettings.enabled}
          onChange={(e) => onBreak({ enabled: e.target.checked })}
        />
        <span>
          <b>{t('settingsdialog.remind_me_to_take_a_break', 'Remind me to take a break')}</b> {t('settingsdialog.counted_only_while_this_wind', '— counted only while this window is focused, so a reminder never fires at an empty desk.')}
        </span>
      </label>

      <div className="td-field-row" data-testid="break-mode">
        {(
          [
            ['reminder', 'Nudge me'],
            ['pomodoro', 'Pomodoro cycle']
          ] as Array<[BreakMode, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={`td-btn td-field-grow${breakSettings.mode === id ? ' td-btn-primary' : ''}`}
            data-testid={`break-mode-${id}`}
            aria-pressed={breakSettings.mode === id}
            onClick={() => onBreak({ mode: id })}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="td-field">
        <span>
          {breakSettings.mode === 'pomodoro' ? 'Minutes per work round' : 'Minutes between reminders'}
        </span>
        <div className="td-field-row">
          <input
            className="td-field-grow"
            type="number"
            min={1}
            max={240}
            aria-label="break-minutes"
            value={breakSettings.minutes}
            onChange={(e) => onBreak({ minutes: Number(e.target.value) })}
          />
          <button className="td-btn" data-testid="break-preview" onClick={onPreviewBreak}>
            {t('settingsdialog.try_it_now', 'Try it now')}
          </button>
        </div>
      </label>

      {breakSettings.mode === 'pomodoro' && (
        <label className="td-field">
          <span>{t('settingsdialog.minutes_per_break', 'Minutes per break')}</span>
          <input
            type="number"
            min={1}
            max={60}
            aria-label="break-length"
            value={breakSettings.breakMinutes}
            onChange={(e) => onBreak({ breakMinutes: Number(e.target.value) })}
          />
        </label>
      )}

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.wait_for_the_terminals_to_be', 'Wait for the terminals to be quiet for')}</span>
          <input
            type="number"
            min={2}
            max={120}
            aria-label="break-idle"
            value={breakSettings.idleSeconds}
            onChange={(e) => onBreak({ idleSeconds: Number(e.target.value) })}
          />
        </label>
        <label className="td-field td-field-grow">
          <span>{t('settingsdialog.snooze_for', 'Snooze for')}</span>
          <input
            type="number"
            min={1}
            max={120}
            aria-label="break-snooze"
            value={breakSettings.snoozeMinutes}
            onChange={(e) => onBreak({ snoozeMinutes: Number(e.target.value) })}
          />
        </label>
      </div>

      <p className="td-hint">
        {t('settingsdialog.counted_only_while_this_wind_2', 'Counted only while this window is focused, and the nudge waits for')}{breakSettings.idleSeconds}
        {t('settingsdialog.s_of_silence_in_every_sessio', 's of silence in every session so it never lands in the middle of a command. It appears as a bar above the panes — take the break, cover the screen with the lock, or put it off.')}
        {breakSettings.mode === 'pomodoro' &&
          ' A pomodoro break counts down in wall-clock time, because you are supposed to be away; the countdown sits in the drawer footer.'}
      </p>
      <p className="td-hint" data-testid="break-stats">
        {breakStats.breaks === 0
          ? 'No breaks recorded yet.'
          : `Longest stretch ${breakStats.longestMinutes} min · ${breakStats.breaks} break${
              breakStats.breaks === 1 ? '' : 's'
            }${breakStats.pomodoros > 0 ? ` · ${breakStats.pomodoros} pomodoro rounds` : ''}.`}
      </p>

      <h3 className="td-settings-heading">{t('settingsdialog.drawer_sections', 'Drawer sections')}</h3>
      <p className="td-hint">
        {t('settingsdialog.which_blocks_the_terminal_dr', 'Which blocks the Terminal drawer shows. They can also be dragged into order, and hidden by right-clicking a heading there.')}
      </p>
      <div className="td-section-toggles">
        {sections.map((section) => (
          <label className="td-check" key={section.id}>
            <input
              type="checkbox"
              aria-label={`section-${section.id}`}
              checked={section.visible}
              onChange={(e) =>
                onSections(
                  sections.map((s) =>
                    s.id === section.id ? { ...s, visible: e.target.checked } : s
                  )
                )
              }
            />
            <span>{t('sidertab.' + section.id, SIDEBAR_SECTION_LABELS[section.id])}</span>
          </label>
        ))}
      </div>

      <h3 className="td-settings-heading">{t('settingsdialog.lock_screen', 'Lock screen')}</h3>
      <p className="td-hint">
        <kbd>{t('settingsdialog.ctrl_4', 'Ctrl')}</kbd>+<kbd>{t('settingsdialog.alt_4', 'Alt')}</kbd>+<kbd>L</kbd> {t('settingsdialog.covers_the_window_so_the_pan', 'covers the window so the panes cannot be read. It hides the screen rather than suspending anything: the sessions behind it stay connected. Leave the password empty to unlock with a single click.')}
      </p>
      <div className="td-field-row">
        <input
          className="td-field-grow"
          type="password"
          aria-label="lock-password"
          placeholder={lockStatus.hasPassword ? 'Change password' : 'Set a password'}
          autoComplete="off"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setSaved(null)
          }}
        />
        <button
          className="td-btn td-btn-primary"
          data-testid="lock-save"
          onClick={() => void commitLock(password)}
        >
          {t('settingsdialog.save', 'Save')}
        </button>
        <button
          className="td-btn"
          data-testid="lock-clear"
          disabled={!lockStatus.hasPassword}
          onClick={() => void commitLock(null)}
        >
          {t('settingsdialog.clear', 'Clear')}
        </button>
      </div>
      <p className="td-hint" data-testid="lock-status">
        {saved ??
          (lockStatus.hasPassword
            ? 'A password is set.'
            : 'No password set — the lock unlocks with one click.')}
      </p>
    </div>
  )
}
