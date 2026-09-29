import { useMemo, useState, type FormEvent, type JSX } from 'react'
import type { Snippet } from '@shared/types'
import { Drawer } from './Drawer'

interface SnippetEditorProps {
  /** Existing snippet to edit, or null when creating. */
  snippet: Snippet | null
  /** Pre-selected group when creating from a group tab. */
  defaultGroup: string
  /** Existing group names, offered as suggestions and used for renames. */
  groups: string[]
  onCancel: () => void
  onSaved: (input: Partial<Snippet> & { label: string; command: string }) => void
  onDeleted?: (id: string) => void
}

export function SnippetEditor({
  snippet,
  defaultGroup,
  groups,
  onCancel,
  onSaved,
  onDeleted
}: SnippetEditorProps): JSX.Element {
  const [label, setLabel] = useState(snippet?.label ?? '')
  const [command, setCommand] = useState(snippet?.command ?? '')
  const [group, setGroup] = useState(snippet?.group ?? defaultGroup)
  const [newGroup, setNewGroup] = useState('')
  const [description, setDescription] = useState(snippet?.description ?? '')
  const [error, setError] = useState<string | null>(null)

  const effectiveGroup = useMemo(() => newGroup.trim() || group, [newGroup, group])
  const canSave = label.trim().length > 0 && command.length > 0

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
        description: description.trim() || undefined
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
            <span>Label</span>
            <input
              autoFocus
              aria-label="snippet-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Restart nginx"
            />
          </label>

          <label className="td-field">
            <span>Command</span>
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
              <span>Group</span>
              <select
                aria-label="snippet-group"
                className="td-select"
                value={group}
                onChange={(e) => {
                  setGroup(e.target.value)
                  setNewGroup('')
                }}
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="td-field td-field-grow">
              <span>Or new group</span>
              <input
                aria-label="snippet-new-group"
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                placeholder="ops"
              />
            </label>
          </div>

          <label className="td-field">
            <span>Description (optional)</span>
            <input
              aria-label="snippet-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <div className="td-form-error">{error}</div>}
        </div>

        <div className="td-drawer-actions">
          {snippet?.id && onDeleted && (
            <button
              type="button"
              className="td-btn td-btn-danger"
              onClick={() => onDeleted(snippet.id)}
            >
              Delete
            </button>
          )}
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="td-btn td-btn-primary"
            data-testid="snippet-save"
            disabled={!canSave}
          >
            Save
          </button>
        </div>
      </form>
    </Drawer>
  )
}
