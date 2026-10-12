import { type JSX } from 'react'

interface BreakBarProps {
  /** Minutes of continuous focused work behind the nudge. */
  minutes: number
  /** Record the break and carry on. */
  onTakeBreak: () => void
  /** Record the break and cover the screen — the reason to stand up at all. */
  onTakeBreakAndLock: () => void
  /** Ask again later. */
  onSnooze: (minutes: number) => void
  /** Hide it without pretending a break happened. */
  onDismiss: () => void
  snoozeMinutes: number
}

/**
 * The break nudge, as a bar above the panes.
 *
 * Deliberately not a dialog: a modal takes the keyboard and the whole screen away
 * from whatever you were in the middle of, which is exactly what a reminder must
 * not do. This sits in the layout, costs one row, and waits politely — the
 * reminder only appears once the terminals have gone quiet (see `App`), so it
 * cannot land mid-command.
 *
 * "Take a break and lock" is the honest option of the three: standing up is the
 * point, and the lock screen already exists to cover the terminals while you do.
 */
export function BreakBar({
  minutes,
  onTakeBreak,
  onTakeBreakAndLock,
  onSnooze,
  onDismiss,
  snoozeMinutes
}: BreakBarProps): JSX.Element {
  return (
    <div className="td-break-bar" data-testid="break-bar">
      <span className="td-break-icon" aria-hidden="true">
        ☕
      </span>
      <span className="td-break-text">
        <b>{minutes} minutes</b> without a break — stand up, and look at something further away.
      </span>
      <span className="td-break-actions">
        <button
          className="td-btn td-btn-primary"
          data-testid="break-lock"
          onClick={onTakeBreakAndLock}
          title="Record the break and cover the screen"
        >
          Break &amp; lock
        </button>
        <button className="td-btn" data-testid="break-done" onClick={onTakeBreak}>
          Break taken
        </button>
        <button
          className="td-btn"
          data-testid="break-snooze"
          onClick={() => onSnooze(snoozeMinutes)}
        >
          {snoozeMinutes} min
        </button>
        <button
          className="td-icon-btn"
          data-testid="break-dismiss"
          title="Not now"
          onClick={onDismiss}
        >
          ✕
        </button>
      </span>
    </div>
  )
}
