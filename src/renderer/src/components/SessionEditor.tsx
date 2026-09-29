import { useState, type FormEvent, type JSX } from 'react'
import type { AuthMethod, SavedSession, SessionFolder, SessionTree } from '@shared/types'

const api = window.termdeck

export interface SessionEditorProps {
  /** Existing session to edit, or null when creating a new one. */
  session: SavedSession | null
  /** Pre-selected parent folder when creating from a folder. */
  defaultParentId: string | null
  folders: SessionFolder[]
  knownTags: string[]
  /** Credentials carried over from the quick-connect dialog. */
  prefill?: { password?: string; passphrase?: string }
  onCancel: () => void
  /** Called after a successful save; the tree itself arrives via broadcast. */
  onSaved: (tree: SessionTree) => void
  onDeleted?: (tree: SessionTree) => void
}

/** Flatten folders into indented options so nesting is visible in the select. */
function folderOptions(tree: SessionFolder[]): Array<{ id: string; label: string }> {
  const byParent = new Map<string | null, SessionFolder[]>()
  for (const folder of tree) {
    const list = byParent.get(folder.parentId) ?? []
    list.push(folder)
    byParent.set(folder.parentId, list)
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  const out: Array<{ id: string; label: string }> = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      out.push({ id: folder.id, label: `${'— '.repeat(depth)}${folder.name}` })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * Session form, rendered as the body of a drawer.
 *
 * The `Drawer` supplies the sliding panel and the title, so this component only
 * owns the fields and the action row.
 */
export function SessionEditor({
  session,
  defaultParentId,
  folders,
  knownTags,
  prefill,
  onCancel,
  onSaved,
  onDeleted
}: SessionEditorProps): JSX.Element {
  const [name, setName] = useState(session?.name ?? '')
  const [host, setHost] = useState(session?.host ?? '')
  const [port, setPort] = useState(String(session?.port ?? 22))
  const [username, setUsername] = useState(session?.username ?? 'root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>(session?.authMethod ?? 'password')
  const [privateKeyPath, setPrivateKeyPath] = useState(session?.privateKeyPath ?? '')

  /**
   * Password/passphrase fields. They start empty for an existing session:
   * the stored value is never sent to the renderer, only a `hasPassword` flag.
   * Leaving them blank keeps whatever is stored.
   */
  const [password, setPassword] = useState(prefill?.password ?? '')
  const [passphrase, setPassphrase] = useState(prefill?.passphrase ?? '')
  // Prefilled values count as an edit, so saving persists them.
  const [passwordTouched, setPasswordTouched] = useState(!!prefill?.password)
  const [passphraseTouched, setPassphraseTouched] = useState(!!prefill?.passphrase)
  const [revealed, setRevealed] = useState<string | null>(null)

  const [parentId, setParentId] = useState<string | null>(
    session?.parentId ?? defaultParentId ?? null
  )
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(session?.tags ?? [])
  const [notes, setNotes] = useState(session?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const options = folderOptions(folders)
  const canSave = host.trim().length > 0 && username.trim().length > 0
  const editing = !!session?.id

  const addTag = (raw: string): void => {
    const tag = raw.trim()
    if (!tag) return
    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
    setTagInput('')
  }

  const reveal = async (): Promise<void> => {
    const value = session?.id ? await api.revealCredential(session.id) : null
    if (value === null) {
      setError('No saved password to show for this session.')
      return
    }
    setRevealed(value)
    setPassword(value)
    setPasswordTouched(false)
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSave || busy) return

    setBusy(true)
    setError(null)
    try {
      const parsedPort = Number.parseInt(port, 10)

      // Only send credentials the user actually edited; omitted keys keep
      // whatever is already stored (the store merges partial updates), and an
      // empty string is how a field is explicitly cleared.
      const credential: { password?: string; passphrase?: string } = {}
      if (passwordTouched) credential.password = password
      if (passphraseTouched) credential.passphrase = passphrase

      const tree = await api.saveSession({
        id: session?.id,
        name: name.trim() || `${username.trim()}@${host.trim()}`,
        host: host.trim(),
        port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
        username: username.trim(),
        authMethod,
        privateKeyPath: privateKeyPath.trim() || undefined,
        tags,
        notes: notes.trim() || undefined,
        parentId,
        credential
      })
      onSaved(tree)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!session || !onDeleted) return
    setBusy(true)
    try {
      onDeleted(await api.deleteSession(session.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="td-drawer-form" onSubmit={(e) => void submit(e)} data-testid="session-form">
      <div className="td-form">
        <label className="td-field">
          <span>Name</span>
          <input
            aria-label="session-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={host ? `${username}@${host}` : 'prod-web-1'}
          />
        </label>

        <div className="td-field-row">
          <label className="td-field td-field-grow">
            <span>Host</span>
            <input
              aria-label="session-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.0.0.1 or example.com"
              spellCheck={false}
            />
          </label>
          <label className="td-field td-field-port">
            <span>Port</span>
            <input
              aria-label="session-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
            />
          </label>
        </div>

        <label className="td-field">
          <span>Username</span>
          <input
            aria-label="session-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="td-field">
          <span>Folder</span>
          <select
            aria-label="session-folder"
            className="td-select"
            value={parentId ?? ''}
            onChange={(e) => setParentId(e.target.value || null)}
          >
            <option value="">(root)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="td-field">
          <span>Authentication</span>
          <div className="td-segmented">
            {(
              [
                ['password', 'Password'],
                ['key', 'Private key'],
                ['agent', 'SSH agent']
              ] as Array<[AuthMethod, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={authMethod === value ? 'is-active' : ''}
                onClick={() => setAuthMethod(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {authMethod === 'password' && (
          <label className="td-field">
            <span>
              Password
              {session?.hasPassword && !passwordTouched && (
                <span className="td-field-note"> — one is saved</span>
              )}
            </span>
            <div className="td-field-row">
              <input
                className="td-field-grow"
                aria-label="session-password"
                type={revealed !== null ? 'text' : 'password'}
                value={password}
                placeholder={session?.hasPassword ? '•••••••• (unchanged)' : ''}
                autoComplete="off"
                onChange={(e) => {
                  setPassword(e.target.value)
                  setPasswordTouched(true)
                }}
              />
              {session?.id && session.hasPassword && (
                <button type="button" className="td-btn" onClick={() => void reveal()}>
                  Show
                </button>
              )}
            </div>
            <span className="td-hint">
              Saved encrypted on this machine, with the key held by your operating system's
              keychain — no master password to type.
            </span>
          </label>
        )}

        {authMethod === 'key' && (
          <>
            <label className="td-field">
              <span>Private key file</span>
              <div className="td-field-row">
                <input
                  className="td-field-grow"
                  aria-label="session-key-path"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder="/home/me/.ssh/id_ed25519"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="td-btn"
                  onClick={() =>
                    void api.pickPrivateKey().then((p) => {
                      if (p) setPrivateKeyPath(p)
                    })
                  }
                >
                  Browse…
                </button>
              </div>
            </label>

            <label className="td-field">
              <span>
                Key passphrase (optional)
                {session?.hasPassphrase && !passphraseTouched && (
                  <span className="td-field-note"> — one is saved</span>
                )}
              </span>
              <input
                aria-label="session-passphrase"
                type="password"
                value={passphrase}
                placeholder={session?.hasPassphrase ? '•••••••• (unchanged)' : ''}
                autoComplete="off"
                onChange={(e) => {
                  setPassphrase(e.target.value)
                  setPassphraseTouched(true)
                }}
              />
            </label>
          </>
        )}

        {authMethod === 'agent' && (
          <p className="td-hint">
            Uses <code>SSH_AUTH_SOCK</code>, or Pageant on Windows.
          </p>
        )}

        <div className="td-field">
          <span>Tags</span>
          <div className="td-tag-editor">
            {tags.map((tag) => (
              <span key={tag} className="td-tag">
                {tag}
                <button
                  type="button"
                  className="td-tag-remove"
                  onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              aria-label="session-tag-input"
              className="td-tag-input"
              list="td-known-tags"
              placeholder="add tag…"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag(tagInput)
                } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                  setTags((prev) => prev.slice(0, -1))
                }
              }}
            />
            <datalist id="td-known-tags">
              {knownTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        </div>

        <label className="td-field">
          <span>Notes</span>
          <input
            aria-label="session-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {error && <div className="td-form-error">{error}</div>}
      </div>

      <div className="td-drawer-actions">
        {session && onDeleted && (
          <button
            type="button"
            className="td-btn td-btn-danger"
            disabled={busy}
            onClick={() => void remove()}
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
          data-testid="session-save"
          disabled={!canSave || busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
