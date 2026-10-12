import { type JSX } from 'react'
import { ModalShell } from './ModalShell'

interface BreakReminderProps {
  /** How long the user had been working, for the wording. */
  minutes: number
  /** Put it off for a while: the countdown starts again from a short interval. */
  onSnooze: () => void
  /** The break was taken. */
  onDone: () => void
}

/**
 * "You have been at this for a while."
 *
 * Two honest choices and nothing else: take the break, or be asked again shortly.
 * An earlier version ran a little game here to make the break something you *do* —
 * it was more annoying than the problem it solved, so the reminder went back to
 * being a reminder.
 */
export function BreakReminder({ minutes, onSnooze, onDone }: BreakReminderProps): JSX.Element {
  return (
    <ModalShell onDismiss={onSnooze} testId="break-reminder">
      <div className="td-modal-head">
        <h2>Time to stand up</h2>
        <button className="td-icon-btn" title="Snooze" data-testid="break-close" onClick={onSnooze}>
          ✕
        </button>
      </div>

      <p className="td-quit-text">You have been at the terminal for {minutes} minutes.</p>
      <p className="td-hint">
        Stand up, roll your shoulders, and look at something more than a metre away for a moment —
        that is the part that helps. The timer starts again from now either way.
      </p>

      <div className="td-modal-foot">
        <button className="td-btn" data-testid="break-snooze" onClick={onSnooze}>
          Remind me in 10 minutes
        </button>
        <span className="td-spacer" />
        <button
          className="td-btn td-btn-primary"
          data-testid="break-done"
          onClick={onDone}
          autoFocus
        >
          I am taking a break
        </button>
      </div>
    </ModalShell>
  )
}
