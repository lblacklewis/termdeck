/**
 * Painting what is worth spotting in terminal output.
 *
 * What is on screen is re-read, the rules are matched against it, and every match
 * becomes an xterm *decoration* — a rectangle of cells with its own foreground and
 * background. Nothing is written into the data stream: the buffer is untouched, so
 * what the remote sent, what a copy gives back and what `save output` writes are all
 * exactly as they were. Wrapping matches in SGR escapes instead would corrupt column
 * arithmetic, break reflow, and hand colour junk to anything downstream that copy
 * pastes into — which is the thing this feature must never do.
 *
 * Two consequences of decorations are worth stating, because they are limits rather
 * than choices: a colour is `#RRGGBB` and nothing else (no bold, no underline), and a
 * decoration covers whole cells, so a rule must be a pattern that matches text in the
 * row rather than something spanning rows.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import type { TerminalSettings } from '@shared/types'
import { HIGHLIGHT_RULES, stylesFor } from '@shared/highlight'

/**
 * Writes arrive in bursts — a `make` run can push hundreds of chunks a second — and a
 * scan per chunk would spend the frame budget clearing and rebuilding decorations.
 * One scan after the output settles is what the eye sees anyway.
 */
const SCAN_DELAY_MS = 120

export interface Highlighter {
  /** Re-scan now, for a settings change. */
  refresh(): void
  dispose(): void
}

export function attachHighlighter(
  term: Terminal,
  readSettings: () => TerminalSettings
): Highlighter {
  let decorations: IDecoration[] = []
  let markers: IMarker[] = []
  let timer = 0
  let disposed = false

  const clear = (): void => {
    for (const decoration of decorations) decoration.dispose()
    /*
     * Markers are disposed with their decoration by the terminal, but a marker whose
     * decoration was refused is not, and the buffer keeps markers until they are
     * disposed — one per match, for the life of the pane.
     */
    for (const marker of markers) marker.dispose()
    decorations = []
    markers = []
  }

  const scan = (): void => {
    clear()
    if (disposed) return

    const settings = readSettings()
    if (!settings.highlightEnabled) return

    const rules = HIGHLIGHT_RULES.filter((rule) => settings.highlightRules.includes(rule.id))
    if (rules.length === 0) return

    const styles = stylesFor(settings.highlightScheme)
    const buffer = term.buffer.active
    // vim and friends live in the alternate buffer; xterm refuses decorations there.
    if (buffer.type === 'alternate') return

    const cursorLine = buffer.baseY + buffer.cursorY
    const first = buffer.viewportY
    const last = Math.min(buffer.length, first + term.rows)

    for (let y = first; y < last; y += 1) {
      const line = buffer.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      if (text === '') continue

      /*
       * One cell keeps one colour. A URL contains slashes, so without this the path
       * rule would repaint the inside of every link it was meant to leave alone.
       */
      const claimed: boolean[] = []

      for (const rule of rules) {
        const style = styles[rule.id]
        if (!style.fg && !style.bg) continue
        for (const pattern of rule.patterns) {
          pattern.lastIndex = 0
          let match = pattern.exec(text)
          while (match) {
            const start = match.index
            const width = match[0].length
            if (width === 0) {
              // A pattern that can match nothing would spin here forever.
              pattern.lastIndex += 1
            } else if (!overlaps(claimed, start, width)) {
              claim(claimed, start, width)
              paint(term, markers, decorations, y - cursorLine, start, width, style.fg, style.bg)
            }
            match = pattern.exec(text)
          }
        }
      }
    }
  }

  const schedule = (): void => {
    if (disposed || timer !== 0) return
    timer = window.setTimeout(() => {
      timer = 0
      scan()
    }, SCAN_DELAY_MS)
  }

  const subscriptions = [
    term.onWriteParsed(schedule),
    // Scrolling brings rows into view that were written while they were off screen.
    term.onScroll(schedule),
    term.onResize(schedule)
  ]
  // A hidden pane (an inactive tab) is unmeasured; its decorations are rebuilt when
  // it comes back, which is what this event is for.
  const onShown = (): void => schedule()
  window.addEventListener('termdeck:panel-shown', onShown)

  return {
    refresh(): void {
      if (disposed) return
      clear()
      scan()
    },
    dispose(): void {
      disposed = true
      if (timer !== 0) window.clearTimeout(timer)
      timer = 0
      for (const subscription of subscriptions) subscription.dispose()
      window.removeEventListener('termdeck:panel-shown', onShown)
      clear()
    }
  }
}

function paint(
  term: Terminal,
  markers: IMarker[],
  decorations: IDecoration[],
  lineOffset: number,
  x: number,
  width: number,
  fg: string | undefined,
  bg: string | undefined
): void {
  const marker = term.registerMarker(lineOffset)
  if (!marker) return
  const decoration = term.registerDecoration({
    marker,
    x,
    width,
    backgroundColor: bg,
    foregroundColor: fg,
    // Under the selection, so selecting highlighted text still reads as selected.
    layer: 'bottom'
  })
  if (!decoration) {
    marker.dispose()
    return
  }
  markers.push(marker)
  decorations.push(decoration)
}

function overlaps(claimed: boolean[], start: number, width: number): boolean {
  for (let i = start; i < start + width; i += 1) {
    if (claimed[i]) return true
  }
  return false
}

function claim(claimed: boolean[], start: number, width: number): void {
  for (let i = start; i < start + width; i += 1) claimed[i] = true
}
