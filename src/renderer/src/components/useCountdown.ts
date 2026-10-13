import { useEffect, useState, type JSX } from 'react'

/**
 * Counts down to a wall-clock timestamp.
 *
 * The bar and the chip both need a seconds display, and both are small: keeping
 * the tick inside them means the rest of the app re-renders when the *phase*
 * changes rather than once a second.
 */
export function useCountdown(endsAt: number): number {
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (!endsAt) {
      setLeft(0)
      return
    }
    const tick = (): void => setLeft(Math.max(0, Math.round((endsAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [endsAt])

  return left
}

/** `4:05` for anything a pomodoro can run to. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}
