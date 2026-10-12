import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'

interface LockScreenProps {
  /** True when a non-empty password is stored, so a field is needed. */
  hasPassword: boolean
  /** Resolves true when the password (or the empty one) matches. */
  onUnlock: (password: string) => Promise<boolean>
}

/**
 * The lock screen.
 *
 * Everything is opaque and covers the whole window, panes included — the point is
 * that whoever walks past cannot read the terminals. It is a *convenience* lock,
 * not a security boundary: the SSH sessions behind it stay connected and the
 * profile on disk is untouched, so it is honest to say it keeps eyes off the
 * screen rather than keeping anyone out of the machine.
 *
 * With no password stored, one click unlocks: the user asked for a lock that can
 * be used without one.
 */
export function LockScreen({ hasPassword, onUnlock }: LockScreenProps): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (hasPassword) inputRef.current?.focus()
  }, [hasPassword])

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const ok = await onUnlock(password)
      if (!ok) {
        setError('Wrong password.')
        setPassword('')
        inputRef.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="td-lock" data-testid="lock-screen" role="dialog" aria-label="TermDeck is locked">
      <div className="td-lock-inner">
        <div className="td-lock-brand">
          <span className="td-brand-mark">◈</span>
          <span className="td-brand-name">TermDeck</span>
        </div>

        <div className="td-lock-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div className="td-lock-date">
          {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>

        <form className="td-lock-form" onSubmit={(e) => void submit(e)}>
          {hasPassword && (
            <input
              ref={inputRef}
              className="td-lock-input"
              type="password"
              aria-label="lock-password"
              placeholder="Password"
              autoComplete="off"
              value={password}
              disabled={busy}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
            />
          )}
          {error && (
            <div className="td-form-error" data-testid="lock-error">
              {error}
            </div>
          )}
          <button
            type={hasPassword ? 'submit' : 'button'}
            className="td-btn td-btn-primary td-lock-unlock"
            data-testid="lock-unlock"
            disabled={busy}
            onClick={hasPassword ? undefined : () => void submit()}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        <p className="td-hint">
          {hasPassword
            ? 'Press Enter to unlock.'
            : 'No password is set — this lock just hides the screen.'}
        </p>
      </div>
    </div>
  )
}
