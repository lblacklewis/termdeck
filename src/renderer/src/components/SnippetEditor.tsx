import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import type { Snippet } from '@shared/types'
import { Drawer } from './Drawer'
import { formatEvent, isValidBinding } from './useShortcuts'
import { t } from '../i18n'

/**
 * The colours offered as one-click swatches.
 *
 * Chosen to be distinguishable on both the dark default and the light themes, and to
 * survive being drawn three pixels tall — a muted palette disappears at that size.
 */
const SWATCHES = [
  '#f7768e',
  '#ff9e64',
  '#e0af68',
  '#9ece6a',
  '#7dcfff',
  '#7aa2f7',
  '#bb9af7',
  '#c0caf5'
]

interface SnippetEditorProps {
  /** Existing snippet to edit, or null when creating. */
  snippet: Snippet | null
  /** Pre-selected group when creating from a group tab. */
  defaultGroup: string
  /** Existing group names, offered as suggestions and used for renames. */
  groups: string[]
  /**
   * Every other shortcut in the app, so a clash shows up while the key is being
   * pressed rather than only in the settings list afterwards.
   */
  taken: { keys: string; label: string }[]
  onCancel: () => void
  onSaved: (input: Partial<Snippet> & { label: string; command: string }) => void
  onDeleted?: (id: string) => void
}

export function SnippetEditor({
  snippet,
  defaultGroup,
  groups,
  taken,
  onCancel,
  onSaved,
  onDeleted
}: SnippetEditorProps): JSX.Element {
  const [label, setLabel] = useState(snippet?.label ?? '')
  const [command, setCommand] = useState(snippet?.command ?? '')
  const [group, setGroup] = useState(snippet?.group ?? defaultGroup)
  const [newGroup, setNewGroup] = useState('')
  const [description, setDescription] = useState(snippet?.description ?? '')
  const [keys, setKeys] = useState(snippet?.keys ?? '')
  const [color, setColor] = useState(snippet?.color ?? '')
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * Recording, in the same shape the settings list uses: captured on the window so
   * the terminal never sees the chord, Escape abandons it, and a bare modifier
   * press is not a binding yet.
   */
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const formatted = formatEvent(e)
      if (!formatted || !isValidBinding(formatted)) return
      setKeys(formatted)
      setRecording(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording])

  /** The binding this key already belongs to, if it belongs to one. */
  const clash = useMemo(() => {
    const needle = keys.trim().toLowerCase()
    if (!needle) return null
    return taken.find((binding) => binding.keys.trim().toLowerCase() === needle) ?? null
  }, [keys, taken])

  const effectiveGroup = useMemo(() => newGroup.trim() || group, [newGroup, group])
  const canSave = label.trim().length > 0 && command.length > 0 && !clash && !recording

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!canSave) return

    try {
      onSaved({
        id: snippet?.id,
        label: label.trim(),
        // Stored exactly as typed — including any trailing newline, which is
        // what decides whether the shell runs it.
        command,
        group: effectiveGroup.trim(),
        description: description.trim() || undefined,
        keys: keys.trim() || undefined,
        color: color || undefined
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Drawer
      open
      size="md"
      testId="snippet-editor"
      title={snippet?.id ? 'Edit snippet' : 'New snippet'}
      onClose={onCancel}
    >
      <form className="td-drawer-form" onSubmit={submit}>
        <div className="td-form">
          <label className="td-field">
            <span>{t('snippeteditor.label', 'Label')}</span>
            <input
              autoFocus
              aria-label="snippet-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('snippeteditor.restart_nginx', 'Restart nginx')}
            />
          </label>

          <label className="td-field">
            <span>{t('snippeteditor.command', 'Command')}</span>
            <textarea
              className="td-textarea"
              aria-label="snippet-command"
              rows={4}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={'sudo systemctl restart nginx'}
              spellCheck={false}
            />
            {/* The text is sent exactly as typed, so the trailing newline is the
                user's decision rather than something we add. */}
            <span className="td-hint" data-testid="snippet-enter-hint">
              {/\r?\n\s*$/.test(command)
                ? 'Ends with a newline, so pressing Enter — and clicking it — will run it.'
                : 'No trailing newline, so it is only typed into the prompt. Add a newline at the end to make it run.'}
            </span>
          </label>

          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>{t('snippeteditor.group', 'Group')}</span>
              <select
                aria-label="snippet-group"
                className="td-select"
                value={group}
                onChange={(e) => {
                  setGroup(e.target.value)
                  setNewGroup('')
                }}
              >
                <option value="">{t('snippeteditor.ungrouped', 'Ungrouped')}</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="td-field td-field-grow">
              <span>{t('snippeteditor.or_new_group', 'Or new group')}</span>
              <input
                aria-label="snippet-new-group"
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                placeholder="ops"
              />
            </label>
          </div>

          <label className="td-field">
            <span>{t('snippeteditor.description_optional', 'Description (optional)')}</span>
            <input
              aria-label="snippet-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="td-field">
            <span>{t('snippeteditor.shortcut_optional', 'Shortcut (optional)')}</span>
            <div className="td-key-row">
              <button
                type="button"
                className={`td-key-btn${recording ? ' is-recording' : ''}${keys ? '' : ' is-empty'}`}
                data-testid="snippet-keys"
                onClick={() => setRecording(true)}
              >
                {recording
                  ? t('snippeteditor.press_keys', 'Press keys…')
                  : keys || t('snippeteditor.not_set', 'Not set')}
              </button>
              {keys !== '' && (
                <button
                  type="button"
                  className="td-mini"
                  data-testid="snippet-keys-clear"
                  title={t('snippeteditor.clear_shortcut', 'Clear the shortcut')}
                  onClick={() => setKeys('')}
                >
                  ×
                </button>
              )}
            </div>
            {clash && (
              <span className="td-form-error" data-testid="snippet-keys-clash">
                {t('snippeteditor.shortcut_already_used_b', 'Already used by {label}. Pick another one.', {
                  label: clash.label
                })}
              </span>
            )}
            <span className="td-hint">
              {t(
                'snippeteditor.shortcut_hint',
                'Runs this snippet from anywhere in the app, like any other shortcut.'
              )}
            </span>
          </div>

          <div className="td-field">
            <span>{t('snippeteditor.color_optional', 'Colour (optional)')}</span>
            <div className="td-swatch-row">
              <button
                type="button"
                className={`td-swatch td-swatch-none${color ? '' : ' is-on'}`}
                data-testid="snippet-color-none"
                title={t('snippeteditor.no_colour', 'No colour')}
                onClick={() => setColor('')}
              >
                ✕
              </button>
              {SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  className={`td-swatch${color.toLowerCase() === swatch ? ' is-on' : ''}`}
                  style={{ background: swatch }}
                  data-testid={'snippet-color-' + swatch.slice(1)}
                  title={swatch}
                  onClick={() => setColor(swatch)}
                />
              ))}
              {/*
                The native picker for anything outside the palette. Not every theme or
                brand colour is in eight swatches, and "custom" is what the field says.
              */}
              <input
                type="color"
                className="td-swatch-custom"
                data-testid="snippet-color-custom"
                value={color || SWATCHES[5]}
                title={t('snippeteditor.custom_colour', 'Any colour')}
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
            <span className="td-hint">
              {t(
                'snippeteditor.color_hint',
                'Shown as a stripe along the bottom of the button, so similar commands can be told apart.'
              )}
            </span>
          </div>

          {error && <div className="td-form-error">{error}</div>}
        </div>

        <div className="td-drawer-actions">
          {snippet?.id && onDeleted && (
            <button
              type="button"
              className="td-btn td-btn-danger"
              onClick={() => onDeleted(snippet.id)}
            >
              {t('snippeteditor.delete', 'Delete')}
            </button>
          )}
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onCancel}>
            {t('snippeteditor.cancel', 'Cancel')}
          </button>
          <button
            type="submit"
            className="td-btn td-btn-primary"
            data-testid="snippet-save"
            disabled={!canSave}
          >
            {t('snippeteditor.save', 'Save')}
          </button>
        </div>
      </form>
    </Drawer>
  )
}
