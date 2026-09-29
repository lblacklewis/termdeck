import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AppSettings,
  ClipboardSettings,
  CredentialStatus,
  FontChoices,
  Keybinding,
  TerminalSettings
} from '@shared/types'
import { DEFAULT_KEYBINDINGS } from '@shared/types'
import { THEMES, findTheme } from '@shared/themes'
import { formatEvent, isValidBinding, parseBinding } from './useShortcuts'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { applyTheme } from './useTheme'

const api = window.termdeck

type Tab = 'appearance' | 'terminal' | 'clipboard' | 'shortcuts' | 'hostkeys' | 'credentials'

interface SettingsDialogProps {
  settings: AppSettings
  credentialStatus: CredentialStatus
  onClose: () => void
  onSaved: (settings: AppSettings) => void
  onCredentialChanged: (status: CredentialStatus) => void
}

export function SettingsDialog({
  settings,
  credentialStatus,
  onClose,
  onSaved,
  onCredentialChanged
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

  const dismiss = (): void => {
    // Revert an unsaved preview.
    if (draft.theme !== settings.theme) applyTheme(findTheme(settings.theme))
    onClose()
  }

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

      setDraft((d) => ({
        ...d,
        keybindings: d.keybindings.map((b) => (b.id === recording ? { ...b, keys: formatted } : b))
      }))
      setError(null)
      setRecording(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  const setBindingKeys = (id: string, keys: string): void =>
    setDraft((d) => ({
      ...d,
      keybindings: d.keybindings.map((b) => (b.id === id ? { ...b, keys } : b))
    }))

  const conflicts = useMemo(() => {
    const byKeys = new Map<string, string[]>()
    for (const binding of draft.keybindings) {
      if (!binding.keys) continue
      const normalised = binding.keys.toLowerCase()
      byKeys.set(normalised, [...(byKeys.get(normalised) ?? []), binding.label])
    }
    const out = new Map<string, string[]>()
    for (const [keys, labels] of byKeys) {
      if (labels.length > 1) out.set(keys, labels)
    }
    return out
  }, [draft.keybindings])

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
      { id: 'rebind', label: 'Change shortcut...' },
      { id: 'clear', label: 'Remove shortcut', disabled: !binding.keys },
      {
        id: 'reset',
        label: 'Reset to default',
        disabled: !original || original.keys === binding.keys,
        separatorBefore: true
      },
      { id: 'moveUp', label: 'Move up' },
      { id: 'moveDown', label: 'Move down' }
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
    if (conflicts.size > 0) {
      setError('Resolve conflicting shortcuts before saving.')
      return
    }
    try {
      const saved = await api.saveSettings(draft)
      onSaved(saved)
      setError(null)
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
              ['credentials', 'Credentials']
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={`td-settings-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

          <div className="td-settings-body">
            {tab === 'appearance' && (
              <ThemeTab
                activeTheme={draft.theme}
                savedTheme={settings.theme}
                onPick={previewTheme}
              />
            )}

            {tab === 'terminal' && (
              <TerminalTab settings={draft.terminal} onChange={updateTerminal} />
            )}

            {tab === 'clipboard' && (
              <ClipboardTab settings={draft.clipboard} onChange={updateClipboard} />
            )}

            {tab === 'shortcuts' && (
              <div className="td-field-stack">
                <p className="td-hint">
                  Click a shortcut and press the new combination (<kbd>Esc</kbd> cancels), or
                  right-click a row for more. Drag rows to change their order.
                </p>
                {[...conflicts.entries()].map(([keys, labels]) => (
                  <div key={keys} className="td-form-error">
                    Shortcut conflict on <b>{keys}</b>: {labels.join(', ')}
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
                      <span className="td-drag-grip" title="Drag to reorder">
                        ⠿
                      </span>
                      <span className="td-shortcut-label">{binding.label}</span>
                      <button
                        className={`td-key-btn${recording === binding.id ? ' is-recording' : ''}${
                          binding.keys ? '' : ' is-empty'
                        }`}
                        data-testid={`binding-${binding.id}`}
                        onClick={() => setRecording(binding.id)}
                      >
                        {recording === binding.id ? 'Press keys...' : binding.keys || 'Not set'}
                      </button>
                      <button
                        className="td-mini"
                        title="Remove shortcut"
                        onClick={() => setBindingKeys(binding.id, '')}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tab === 'hostkeys' && (
              <div className="td-field-stack">
                <label className="td-field">
                  <span>Unknown host keys</span>
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
                    <option value="ask">Ask me (show the fingerprint)</option>
                    <option value="strict">Refuse to connect</option>
                    <option value="trust">Trust on first use (insecure)</option>
                  </select>
                </label>
                <p className="td-hint">
                  A <b>changed</b> host key is never accepted automatically, even under "trust
                  on first use" — that is exactly the case a man-in-the-middle would produce.
                </p>
              </div>
            )}

            {tab === 'credentials' && (
              <CredentialsTab status={credentialStatus} onChanged={onCredentialChanged} />
            )}
          </div>
        </div>

      {error && <div className="td-form-error td-settings-error">{error}</div>}

      <div className="td-drawer-actions">
        <span className="td-spacer" />
        <button className="td-btn" onClick={dismiss}>
          Close
        </button>
        <button
          className="td-btn td-btn-primary"
          data-testid="settings-save"
          disabled={!dirty}
          onClick={() => void save()}
        >
          {dirty ? 'Save settings' : 'Saved'}
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
  onPick
}: {
  activeTheme: string
  savedTheme: string
  onPick: (id: string) => void
}): JSX.Element {
  const previewing = activeTheme !== savedTheme
  return (
    <div className="td-field-stack">
      <div className="td-theme-head">
        <p className="td-hint">
          Pick a theme to preview it straight away — the whole app and the terminal change
          together. Press <b>Save settings</b> to keep it.
        </p>
        {previewing && (
          <span className="td-preview-badge" data-testid="theme-previewing">
            Previewing {findTheme(activeTheme).name}
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
    </div>
  )
}

/** Read-only view of how credentials are protected on this machine. */
function CredentialsTab({ status }: { status: CredentialStatus; onChanged: (s: CredentialStatus) => void }): JSX.Element {
  return (
    <div className="td-field-stack" data-testid="credentials-tab">
      <div className="td-cred-badge">
        <span className="td-cred-icon">🔒</span>
        <div>
          <strong>Passwords are saved and encrypted automatically</strong>
          <p className="td-hint">{status.detail}</p>
        </div>
      </div>

      <dl className="td-kv">
        <dt>Protection</dt>
        <dd>{status.backend === 'os' ? 'OS keychain' : 'Local key file'}</dd>
        <dt>Encryption</dt>
        <dd>{status.encrypted ? 'AES-256-GCM' : 'None'}</dd>
        <dt>Sessions with saved credentials</dt>
        <dd data-testid="credential-count">{status.credentialCount}</dd>
      </dl>

      {status.backend === 'local' && (
        <p className="td-hint">
          This system exposes no OS keychain to the app, so the encryption key lives in a file
          next to the data with owner-only permissions. That protects against casual reading, not
          against someone who can already read your user profile.
        </p>
      )}
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
  const [fonts, setFonts] = useState<FontChoices>({ monospace: [], others: [] })

  useEffect(() => {
    let active = true
    // Enumerated by the main process; a failure just leaves the shortlist empty
    // and the field stays free-text.
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
      fontFamily: `${quoted}, "Cascadia Mono", "JetBrains Mono", Consolas, "DejaVu Sans Mono", monospace`
    })
  }

  /** A live sample, so the choice can be judged rather than guessed. */
  const previewFamily = primaryFamily || 'monospace'

  return (
    <div className="td-field-stack">
      <label className="td-field">
        <span>Font family</span>
        <input
          aria-label="font-family"
          list="td-font-choices"
          value={primaryFamily}
          placeholder="Type or pick a font"
          onChange={(e) => setFamily(e.target.value)}
        />
        <datalist id="td-font-choices">
          {fonts.monospace.map((name) => (
            <option key={`mono-${name}`} value={name} />
          ))}
          {fonts.others.map((name) => (
            <option key={`other-${name}`} value={name} />
          ))}
        </datalist>
        <span className="td-hint" data-testid="font-hint">
          {fonts.monospace.length > 0
            ? `${fonts.monospace.length} monospaced fonts found on this system, ` +
              `plus ${fonts.others.length} others. Type to filter.`
            : 'Could not read the installed fonts; type a family name instead.'}
        </span>
      </label>

      {fonts.monospace.length > 0 && (
        <div className="td-font-picks" data-testid="font-picks">
          {fonts.monospace.slice(0, 12).map((name) => (
            <button
              key={name}
              type="button"
              className={`td-font-chip${primaryFamily === name ? ' is-active' : ''}`}
              data-font={name}
              style={{ fontFamily: `"${name}", monospace` }}
              onClick={() => setFamily(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="td-font-preview" style={{ fontFamily: `"${previewFamily}", monospace` }} data-testid="font-preview">
        <span>Monospace 0123456789</span>
        <span className="td-font-preview-dim">git commit -m &quot;fix&quot; · {`{ } ( ) => ; | ~`}</span>
      </div>

      <div className="td-field-row">
        <label className="td-field td-field-grow">
          <span>Font size</span>
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
          <span>Line height</span>
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
          <span>Cursor</span>
          <select
            aria-label="cursor-style"
            className="td-select"
            value={settings.cursorStyle}
            onChange={(e) =>
              onChange({ cursorStyle: e.target.value as TerminalSettings['cursorStyle'] })
            }
          >
            <option value="bar">Bar</option>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label className="td-field td-field-grow">
          <span>Scrollback lines</span>
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
          <span>Cursor blink</span>
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
            <option value="off">Off (steady)</option>
            <option value="1200">Slow — 1.2s</option>
            <option value="900">Relaxed — 0.9s</option>
            <option value="650">Normal — 0.65s</option>
            <option value="400">Fast — 0.4s</option>
          </select>
        </label>
        <div className="td-field td-field-grow" />
      </div>

      <label className="td-check">
        <input
          type="checkbox"
          aria-label="show-timestamps"
          checked={settings.showTimestamps}
          onChange={(e) => onChange({ showTimestamps: e.target.checked })}
        />
        <span>
          Show a timestamp column beside each pane. Times are recorded per line as output arrives;
          they are not saved with the session.
        </span>
      </label>
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
          <b>Copy on select</b> — dragging over text copies it immediately. Leaves{' '}
          <kbd>Ctrl</kbd>+<kbd>C</kbd> free for the remote shell.
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
          <b>Right-click paste</b> — paste the clipboard instead of opening a menu.
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
          <b>Middle-click paste</b> — paste with the middle mouse button.
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
          <b>Confirm multi-line paste</b> — ask before sending several commands at once.
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
