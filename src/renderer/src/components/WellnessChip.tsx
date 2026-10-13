import { type JSX } from 'react'
import { formatClock, useCountdown } from './useCountdown'

interface WellnessChipProps {
  phase: 'work' | 'break'
  /** When the current half ends; 0 for a work round that has no fixed end. */
  endsAt: number
  /** Length of one work round, for the tooltip. */
  round: number
  title: string
  onClick: () => void
}

/**
 * The pomodoro, visible in the drawer's footer.
 *
 * A cycle you cannot see is a cycle you forget about, and the drawer is where the
 * eye already is while working. During a break the chip counts the seconds down;
 * during work it shows the round length, because the timer there is driven by
 * focused time rather than by the clock.
 */
export function WellnessChip({
  phase,
  endsAt,
  round,
  title,
  onClick
}: WellnessChipProps): JSX.Element {
  const left = useCountdown(phase === 'break' ? endsAt : 0)

  return (
    <button
      className={`td-wellness-chip is-${phase}`}
      data-testid="wellness-chip"
      data-phase={phase}
      title={title}
      onClick={onClick}
    >
      <span aria-hidden="true">{phase === 'break' ? '☕' : '🍅'}</span>
      <span data-testid="wellness-clock">{phase === 'break' ? formatClock(left) : `${round}m`}</span>
    </button>
  )
}
