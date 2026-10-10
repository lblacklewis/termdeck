/**
 * Live terminal registry.
 *
 * A pane's current terminal is looked up by session id. This exists for the
 * features that operate on a pane's *content* — copying or saving its scrollback
 * — which need the xterm instance, not just the backend session.
 *
 * Separate from the `__tdTerminals` debug hook, which only exists under
 * `localStorage.tdDebug`; these features must work in a normal run.
 */
import type { Terminal } from '@xterm/xterm'

const terminals = new Map<string, Terminal>()

export function registerTerminal(sessionId: string, term: Terminal): void {
  terminals.set(sessionId, term)
}

export function unregisterTerminal(sessionId: string): void {
  terminals.delete(sessionId)
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return terminals.get(sessionId)
}

/**
 * The full scrollback as plain text, one line per row.
 *
 * `translateToString(true)` trims trailing blanks, which matters because xterm's
 * rows are fixed-width and would otherwise pad every line with spaces.
 */
export function readScrollback(sessionId: string): string | null {
  const term = terminals.get(sessionId)
  if (!term) return null
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  // Drop trailing blank rows so the saved file does not end in dead space.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * Cursor blink rate.
 *
 * xterm adds its `xterm-cursor-blink` class on its own internal tick but ships
 * **no CSS for that class**, so the class is toggled far faster than a comfortable
 * cadence and the cursor reads as a flicker. The app animates it here instead,
 * which makes the rate ours and configurable.
 *
 * `scale` is animated rather than `visibility` or `opacity`: the latter two are
 * also used for the "cursor is hidden" states, and overriding them would make a
 * hidden cursor reappear.
 */
export function applyCursorBlink(container: HTMLElement, blink: boolean, periodMs: number): void {
  const style = container.style
  if (!blink || periodMs <= 0) {
    style.removeProperty('--td-cursor-blink-duration')
    container.removeAttribute('data-cursor-blink')
    return
  }
  style.setProperty('--td-cursor-blink-duration', `${Math.max(120, periodMs)}ms`)
  container.setAttribute('data-cursor-blink', 'on')
}

// ---- per-line timestamps -------------------------------------------------

/**
 * `[HH:MM:SS]`, always the same width.
 *
 * Bracketed and fixed-width to match the convention the reference client
 * (WindTerm) uses, so the column reads as a gutter rather than as part of the
 * command output. Lines older than an hour used to drop the seconds, which made
 * the column change width while scrolling — the gutter now owns that saving
 * instead by being sized for the full form and letting the faint ink recede.
 */
function formatStamp(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`
}

/**
 * When each scrollback line was written.
 *
 * xterm has no per-line timestamp, so this tracks the moment a line first holds
 * text. Times are held in a parallel array and shifted whenever lines scroll off
 * the top of the buffer, which keeps the array exactly as long as the buffer and
 * needs no per-line markers.
 */
export class LineTimestamps {
  private times: Array<number | null> = []
  /** Buffer length at the last sync, so growth can be detected. */
  private seenBaseY = 0

  constructor(private readonly term: Terminal) {
    this.seenBaseY = term.buffer.active.baseY
    this.sync()
  }

  /** Call after every write; stamps newly written lines and follows scrolling. */
  sync(): void {
    const buffer = this.term.buffer.active
    const now = Date.now()

    // Lines scrolled off the top leave the buffer; drop their timestamps so the
    // array stays aligned with the buffer's line numbers.
    const scrolled = buffer.baseY - this.seenBaseY
    if (scrolled > 0) {
      this.times.splice(0, scrolled)
      this.seenBaseY = buffer.baseY
    }

    // Grow to match the buffer.
    while (this.times.length < buffer.length) this.times.push(null)

    // Stamp any line that now holds text and has no timestamp yet.
    for (let i = 0; i < buffer.length; i++) {
      if (this.times[i] !== null) continue
      const line = buffer.getLine(i)
      if (line && line.translateToString(true).length > 0) this.times[i] = now
    }
  }

  /** Timestamp for a buffer line, or null when the line was never written. */
  at(line: number): string | null {
    const t = this.times[line]
    return t === null || t === undefined ? null : formatStamp(t)
  }

  /** Total buffer lines, so a gutter can match the terminal's row count. */
  get lineCount(): number {
    return this.times.length
  }

  dispose(): void {
    this.times = []
  }
}

const stampRegistry = new Map<string, LineTimestamps>()

export function registerStamps(sessionId: string, stamps: LineTimestamps): void {
  stampRegistry.set(sessionId, stamps)
}

export function unregisterStamps(sessionId: string): void {
  stampRegistry.delete(sessionId)
}

export function getStamps(sessionId: string): LineTimestamps | undefined {
  return stampRegistry.get(sessionId)
}

/**
 * Run `listener` whenever the terminal repaints, which covers both new output
 * and scrolling.
 *
 * Used instead of a `requestAnimationFrame` loop by the timestamp gutter: a rAF
 * loop set up inside an effect can have its first frame cancelled by that
 * effect's own cleanup (React's double-invocation in development, and dockview
 * re-parenting), leaving a gutter that never populates. xterm's `onRender` is
 * driven by the terminal itself, so there is no such race.
 */
export function onTerminalRender(sessionId: string, listener: () => void): () => void {
  const term = terminals.get(sessionId)
  if (!term) return () => {}
  const sub = term.onRender(() => listener())
  return () => sub.dispose()
}
