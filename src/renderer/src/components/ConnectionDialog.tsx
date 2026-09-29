import { useState, type FormEvent, type JSX } from 'react'
import type { AuthMethod, CreateSessionResult, SshConnectPayload } from '@shared/types'
import { Drawer } from './Drawer'

const api = window.termdeck

interface ConnectionDialogProps {
  error: string | null
  /** Prefill, e.g. when retrying after trusting a host key. */
  initial?: Partial<{ host: string; port: number; username: string }>
  onCancel: () => void
  onResult: (result: CreateSessionResult, payload: SshConnectPayload) => void
  /** Save the current form as a reusable session, credentials included. */
  onSaveAsSession: (payload: SshConnectPayload) => void
}

/**
 * Quick-connect dialog. Nothing here is persisted unless the user chooses
 * "Save as session".
 */
export function ConnectionDialog({
  error,
  initial,
  onCancel,
  onResult,
  onSaveAsSession
}: ConnectionDialogProps): JSX.Element {
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(String(initial?.port ?? 22))
  const [username, setUsername] = useState(initial?.username ?? 'root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)

  const canSubmit = host.trim().length > 0 && username.trim().length > 0

  const buildPayload = (): SshConnectPayload => {
    const parsedPort = Number.parseInt(port, 10)
    return {
      host: host.trim(),
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
      username: username.trim(),
      auth:
        authMethod === 'agent'
          ? { useAgent: true }
          : authMethod === 'key'
            ? { privateKeyPath: keyPath, passphrase: passphrase || undefined }
            : { password }
    }
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit || busy) return

    setBusy(true)
    try {
      const payload = buildPayload()
      onResult(await api.createSshSession(payload), payload)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open title="Quick connect" size="md" testId="drawer" onClose={onCancel}>
      <form className="td-drawer-form" onSubmit={(e) => void submit(e)}>
        <div className="td-form">
          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>Host</span>
              <input
                autoFocus
                aria-label="ssh-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="10.0.0.1 or example.com"
                spellCheck={false}
              />
            </label>
            <label className="td-field td-field-port">
              <span>Port</span>
              <input
                aria-label="ssh-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                spellCheck={false}
              />
            </label>
          </div>

          <label className="td-field">
            <span>Username</span>
            <input
              aria-label="ssh-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
            />
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
              <span>Password</span>
              <input
                type="password"
                aria-label="ssh-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}

          {authMethod === 'key' && (
            <>
              <label className="td-field">
                <span>Private key file</span>
                <div className="td-field-row">
                  <input
                    className="td-field-grow"
                    aria-label="private-key-path"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    placeholder="/home/me/.ssh/id_ed25519"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="td-btn"
                    onClick={() =>
                      void api.pickPrivateKey().then((p) => {
                        if (p) setKeyPath(p)
                      })
                    }
                  >
                    Browse…
                  </button>
                </div>
              </label>
              <label className="td-field">
                <span>Key passphrase (optional)</span>
                <input
                  type="password"
                  aria-label="ssh-passphrase"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          )}

          {authMethod === 'agent' && (
            <p className="td-hint">
              Uses <code>SSH_AUTH_SOCK</code>, or Pageant on Windows.
            </p>
          )}

          {error && <div className="td-form-error">{error}</div>}
        </div>

        <div className="td-drawer-actions">
          <button
            type="button"
            className="td-btn"
            data-testid="save-as-session"
            disabled={!canSubmit}
            onClick={() => onSaveAsSession(buildPayload())}
          >
            Save as session…
          </button>
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="td-btn td-btn-primary"
            data-testid="connect-submit"
            disabled={!canSubmit || busy}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </Drawer>
  )
}