import { type JSX } from 'react'
import { formatClock, useCountdown } from './useCountdown'

interface BreakBarProps {
  kind: 'reminder' | 'break' | 'work'
  /** Minutes behind the nudge (reminder) or the length of the round. */
  minutes: number
  /** When the break ends, for the countdown; 0 when there is no countdown. */
  endsAt: number
  snoozeMinutes: number
  /** Record the break and carry on. */
  onTakeBreak: () => void
  /** Record the break and cover the screen — the reason to stand up at all. */
  onTakeBreakAndLock: () => void
  /** Ask again later (reminder mode). */
  onSnooze: (minutes: number) => void
  /** Cut a pomodoro break short and start the next round. */
  onEndBreak: () => void
  /** Hide it without pretending a break happened. */
  onDismiss: () => void
}

/**
 * The wellness nudge, as a bar above the panes.
 *
 * Deliberately not a dialog: a modal takes the keyboard and the whole screen away
 * from whatever you were in the middle of, which is exactly what a reminder must
 * not do. This sits in the layout, costs one row, and waits politely — it only
 * appears once the terminals have gone quiet (see `App`), so it cannot land
 * mid-command.
 *
 * Three things it can be saying: a plain reminder, a pomodoro break running, or a
 * pomodoro break that has just finished.
 */
export function BreakBar({
  kind,
  minutes,
  endsAt,
  snoozeMinutes,
  onTakeBreak,
  onTakeBreakAndLock,
  onSnooze,
  onEndBreak,
  onDismiss
}: BreakBarProps): JSX.Element {
  const left = useCountdown(kind === 'break' ? endsAt : 0)

  return (
    <div className={`td-break-bar is-${kind}`} data-testid="break-bar" data-kind={kind}>
      <span className="td-break-icon" aria-hidden="true">
        {kind === 'work' ? '🍅' : '☕'}
      </span>

      {kind === 'reminder' && (
        <span className="td-break-text">
          <b>{minutes} minutes</b> without a break — stand up, and look at something further away.
        </span>
      )}
      {kind === 'break' && (
        <span className="td-break-text" data-testid="break-countdown">
          <b>Break — {formatClock(left)}</b> left. Walk away; the terminals can wait.
        </span>
      )}
      {kind === 'work' && (
        <span className="td-break-text">
          <b>Break over.</b> {minutes} minutes to the next one.
        </span>
      )}

      <span className="td-break-actions">
        {kind === 'reminder' && (
          <>
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
          </>
        )}

        {kind === 'break' && (
          <>
            <button
              className="td-btn"
              data-testid="break-lock"
              onClick={onTakeBreakAndLock}
              title="Cover the screen for the rest of the break"
            >
              Lock screen
            </button>
            <button className="td-btn td-btn-primary" data-testid="break-end" onClick={onEndBreak}>
              Back to work
            </button>
          </>
        )}

        {kind === 'work' && (
          <button className="td-btn td-btn-primary" data-testid="break-done" onClick={onDismiss}>
            Start the next round
          </button>
        )}

        {kind !== 'work' && (
          <button
            className="td-icon-btn"
            data-testid="break-dismiss"
            title="Not now"
            onClick={kind === 'break' ? onEndBreak : onDismiss}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  )
}
