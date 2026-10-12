import { useCallback, useState, type JSX } from 'react'
import { ModalShell } from './ModalShell'
import { BreakGame } from './BreakGame'

interface BreakReminderProps {
  /** How long the user had been working, for the wording. */
  minutes: number
  /** Dismiss without playing. */
  onSkip: () => void
  /** The run was finished (or the reminder was completed) — show the app again. */
  onDone: () => void
}

/**
 * "You have been at this for a while."
 *
 * The game is the point of the thing: a dialog you click away is a dialog you
 * learn to click away. This one asks for half a minute of standing up first, and
 * finishing it is what dismisses the reminder — though skipping stays available,
 * because a reminder that cannot be dismissed is just an obstacle.
 */
export function BreakReminder({ minutes, onSkip, onDone }: BreakReminderProps): JSX.Element {
  const [playing, setPlaying] = useState(false)

  const win = useCallback(() => {
    onDone()
  }, [onDone])

  return (
    <ModalShell onDismiss={onSkip} className="td-modal-break" testId="break-reminder">
      <div className="td-modal-head">
        <h2>{playing ? 'Thirty seconds to the flag' : 'Time to stand up'}</h2>
        <button className="td-icon-btn" title="Skip" data-testid="break-close" onClick={onSkip}>
          ✕
        </button>
      </div>

      {playing ? (
        <BreakGame onWin={win} />
      ) : (
        <p className="td-quit-text">
          You have been at the terminal for {minutes} minutes. Roll your shoulders, look at
          something far away, then give this thirty seconds — finishing it clears the reminder.
        </p>
      )}

      <div className="td-modal-foot">
        <button className="td-btn" data-testid="break-skip" onClick={onSkip}>
          Skip for now
        </button>
        <span className="td-spacer" />
        {playing ? (
          <button className="td-btn td-btn-primary" data-testid="break-finish" onClick={onDone}>
            I feel better
          </button>
        ) : (
          <button
            className="td-btn td-btn-primary"
            data-testid="break-play"
            onClick={() => setPlaying(true)}
          >
            Play 30 seconds
          </button>
        )}
      </div>
    </ModalShell>
  )
}
