import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

export interface NamePromptProps {
  title: string
  /** Label above the field, e.g. "Group name". */
  label: string
  /** Existing name when renaming; empty when creating. */
  initialValue?: string
  confirmLabel: string
  placeholder?: string
  onCancel: () => void
  onSubmit: (name: string) => void
}

/**
 * One text field in a centred dialog, for naming a folder.
 *
 * Folder names used to be collected in two other ways, both of which this
 * replaces: creating a group silently made a second "New group" (you then had to
 * find it and rename it), and renaming put an input in the page header, at the
 * far top-right, nowhere near the row you had just right-clicked.
 *
 * A centred dialog is also the only shape that works from all three places a
 * folder is made or renamed — the Hosts page, the drawer's session tree, and the
 * tree's own + button — because they do not share a layout region to put a field in.
 *
 * The browser's own `prompt()` is not an option: Electron's renderer refuses it,
 * which is how the old rename came to close its menu and do nothing at all.
 */
export function NamePrompt({
  title,
  label,
  initialValue = '',
  confirmLabel,
  placeholder,
  onCancel,
  onSubmit
}: NamePromptProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  /*
   * Select the existing name so typing replaces it — that is what someone who
   * chose "Rename" wants — while the caret still ends up in the field so a
   * rename-by-typing never needs a click first.
   */
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const name = value.trim()
    if (!name) return
    onSubmit(name)
  }

  return (
    <ModalShell onDismiss={onCancel} testId="name-prompt">
      <div className="td-modal-head">
        <h2>{title}</h2>
        <button className="td-icon-btn" onClick={onCancel} title={t('nameprompt.cancel', 'Cancel')}>
          ✕
        </button>
      </div>

      <form className="td-form" onSubmit={submit}>
        <label className="td-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            aria-label="group-name"
            value={value}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                onCancel()
              }
            }}
          />
        </label>

        <div className="td-modal-foot">
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onCancel}>
            {t('nameprompt.cancel_2', 'Cancel')}
          </button>
          <button
            type="submit"
            className="td-btn td-btn-primary"
            data-testid="name-prompt-save"
            disabled={!value.trim()}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
