import { useState, type FormEvent, type JSX } from 'react'
import type { SavedSession } from '@shared/types'
import { ModalShell } from './ModalShell'

export interface PasswordPromptResult {
  password: string
  /** Persist the password on this session for next time. */
  remember: boolean
}

interface PasswordPromptProps {
  session: SavedSession
  /** Why we are asking, e.g. the failure that triggered the prompt. */
  reason?: string
  /** True when a password is stored but was rejected. */
  retry?: boolean
  busy?: boolean
  onCancel: () => void
  onSubmit: (result: PasswordPromptResult) => void
}

/**
 * Asks for a password when a saved session has none (or has a wrong one).
 *
 * Connecting used to fail with "edit the session to add a password", which
 * forced the user through the editor for something the connect flow can collect
 * itself. The password is still stored only in the main process.
 */
export function PasswordPrompt({
  session,
  reason,
  retry,
  busy,
  onCancel,
  onSubmit
}: PasswordPromptProps): JSX.Element {
  const [password, setPassword] = useState('')
  // Default to saving: if the user had to type it, they almost always want it
  // remembered, and the box makes that explicit rather than silent.
  const [remember, setRemember] = useState(true)
  const [show, setShow] = useState(false)

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (!password || busy) return
    onSubmit({ password, remember })
  }

  return (
    <ModalShell onDismiss={onCancel} testId="password-prompt">
      <div className="td-modal-head">
        <h2>{retry ? 'Password rejected' : 'Password required'}</h2>
        <button className="td-icon-btn" onClick={onCancel} title="Cancel">
          ✕
        </button>
      </div>

      <form className="td-form" onSubmit={submit}>
        <div className="td-prompt-target">
          {/* Saved sessions are SSH-only, so the dot is always the SSH colour. */}
          <span className="td-dot td-dot-ssh" />
          <div>
            <strong>{session.name}</strong>
            <span className="td-hint">
              {session.username}@{session.host}:{session.port}
            </span>
          </div>
        </div>

        {retry && reason && (
          <div className="td-form-error" data-testid="password-prompt-reason">
            {reason}
          </div>
        )}

        <label className="td-field">
          <span>Password</span>
          <div className="td-field-row">
            <input
              className="td-field-grow"
              autoFocus
              aria-label="prompt-password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
            <button type="button" className="td-btn" onClick={() => setShow((v) => !v)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        <label className="td-check">
          <input
            type="checkbox"
            aria-label="prompt-remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            Save this password for <b>{session.name}</b>. It is stored encrypted on this machine,
            with the key held by your operating system's keychain.
          </span>
        </label>

        <div className="td-modal-foot">
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="td-btn td-btn-primary"
            data-testid="prompt-connect"
            disabled={!password || busy}
          >
            {busy ? 'Connecting…' : retry ? 'Try again' : 'Connect and save'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
