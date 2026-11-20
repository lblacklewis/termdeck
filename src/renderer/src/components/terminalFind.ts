/**
 * Finding text in what the terminal has already printed.
 *
 * The search reads the buffer, not the DOM: every line is cells, so a query is
 * matched against `translateToString(true)` and each hit is painted as an xterm
 * *decoration* — the same mechanism `highlight.ts` uses for URLs and paths. Nothing
 * is written into the data stream, so what a copy gives back, what `save output`
 * writes and what the remote sent all stay identical.
 *
 * The whole scrollback is searched — the count would lie otherwise — but only the
 * rows on screen are painted: a long buffer can hold thousands of hits, and one
 * decoration per hit would cost far more than the search is worth.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'

/** Writes arrive in bursts; one pass after the output settles is what the eye sees. */
const SCAN_DELAY_MS = 120

/**
 * Every hit, then the one being looked at.
 *
 * Fixed pairs rather than theme colours: a decoration takes `#RRGGBB` and nothing
 * else, and a hit has to stay readable whatever palette the pane is using — the same
 * reasoning the output highlighter's own schemes follow.
 */
const HIT_STYLE = { fg: '#fff3bf', bg: '#8a6d00' }
const ACTIVE_STYLE = { fg: '#3b2f00', bg: '#fcc419' }

/** What the pane shows beside the box. */
export interface FindStatus {
  /** 1-based position of the active hit; 0 when there is none. */
  index: number
  /** Hits across the whole scrollback. */
  total: number
  /** Hits painted right now — the ones on screen. */
  visible: number
}

export interface TerminalFinder {
  /** Replace the query and search again. An empty string clears the search. */
  setQuery(query: string): void
  next(): void
  previous(): void
  clear(): void
  status(): FindStatus
  /** Repaint now, for a settings or theme change. */
  refresh(): void
  dispose(): void
}

interface Hit {
  /** Absolute buffer line: 0 is the oldest line in the scrollback. */
  row: number
  col: number
  width: number
}

export function attachFinder(
  term: Terminal,
  onStatus?: (status: FindStatus) => void
): TerminalFinder {
  let query = ''
  let hits: Hit[] = []
  /** Index into `hits`; -1 while nothing is active. */
  let active = -1
  let decorations: IDecoration[] = []
  let markers: IMarker[] = []
  let timer = 0
  let disposed = false
  /** Last status handed out, so scrolling does not re-render React for nothing. */
  let reported = ''

  const clearPaint = (): void => {
    for (const decoration of decorations) decoration.dispose()
    /*
     * A marker whose decoration was refused is not disposed with it, and the buffer
     * keeps markers until they are — one per hit, for the life of the pane.
     */
    for (const marker of markers) marker.dispose()
    decorations = []
    markers = []
  }

  const status = (): FindStatus =>
    hits.length === 0
      ? { index: 0, total: 0, visible: 0 }
      : { index: active + 1, total: hits.length, visible: decorations.length }

  const report = (): void => {
    if (!onStatus) return
    const next = status()
    const key = next.index + '/' + next.total + '/' + next.visible
    if (key === reported) return
    reported = key
    onStatus(next)
  }

  /** Every occurrence of the query in the buffer, in reading order. */
  const collect = (): Hit[] => {
    const found: Hit[] = []
    if (query === '') return found

    const needle = query.toLowerCase()
    const buffer = term.buffer.active

    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)
      if (!line) continue
      const text = line.translateToString(true)
      if (text === '') continue

      /*
       * Case-insensitive: a search box that missed a hit because the remote printed
       * it in capitals would be reported as a bug, not as a missing option. The
       * column and width come from the folded string, which is one column per cell,
       * so they stay aligned with the row even when it holds wide characters.
       */
      const haystack = text.toLowerCase()
      let from = haystack.indexOf(needle)
      while (from !== -1) {
        found.push({ row, col: from, width: query.length })
        from = haystack.indexOf(needle, from + needle.length)
      }
    }

    return found
  }

  const paint = (): void => {
    clearPaint()

    const buffer = term.buffer.active
    // vim and friends live in the alternate buffer; xterm refuses decorations there.
    if (buffer.type === 'alternate') return

    const cursorLine = buffer.baseY + buffer.cursorY
    const first = buffer.viewportY
    const last = Math.min(buffer.length, first + term.rows)

    hits.forEach((hit, index) => {
      if (hit.row < first || hit.row >= last) return
      const style = index === active ? ACTIVE_STYLE : HIT_STYLE
      paintHit(term, markers, decorations, hit.row - cursorLine, hit.col, hit.width, style)
    })
  }

  /** Scroll the active hit into view rather than moving it under the user. */
  const reveal = (): void => {
    const hit = hits[active]
    if (!hit) return
    const buffer = term.buffer.active
    if (hit.row < buffer.viewportY || hit.row >= buffer.viewportY + term.rows) {
      term.scrollToLine(Math.max(0, hit.row - Math.floor(term.rows / 2)))
    }
  }

  const scan = (): void => {
    const previous = active >= 0 && active < hits.length ? hits[active] : null
    hits = collect()

    if (hits.length === 0) {
      active = -1
    } else if (previous) {
      /*
       * Hold on to the hit the user is looking at: output arriving above it must not
       * silently move the count to a different match under their eyes.
       */
      const same = hits.findIndex((hit) => hit.row === previous.row && hit.col === previous.col)
      active = same !== -1 ? same : Math.min(active, hits.length - 1)
    } else {
      active = Math.max(0, Math.min(active, hits.length - 1))
    }

    paint()
    report()
  }

  const schedule = (): void => {
    if (disposed || timer !== 0) return
    timer = window.setTimeout(() => {
      timer = 0
      scan()
    }, SCAN_DELAY_MS)
  }

  const step = (delta: number): void => {
    if (hits.length === 0) return
    // From "nothing active" a step forward lands on the first hit and a step back
    // on the last, which is what wrapping means here.
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active
    active = (from + delta + hits.length) % hits.length
    reveal()
    paint()
    report()
  }

  const subscriptions = [
    term.onWriteParsed(schedule),
    // Scrolling brings rows into view that were found while they were off screen.
    term.onScroll(schedule),
    term.onResize(schedule)
  ]
  // A hidden pane (an inactive tab) is unmeasured; its decorations are rebuilt when
  // it comes back, which is what this event is for.
  const onShown = (): void => schedule()
  window.addEventListener('termdeck:panel-shown', onShown)

  return {
    setQuery(next: string): void {
      if (disposed) return
      query = next
      hits = collect()

      if (hits.length === 0) {
        active = -1
      } else {
        // Start from where the user is looking instead of jumping to the top of a
        // long scrollback; a query typed at the bottom should find the nearest hit.
        const from = hits.findIndex((hit) => hit.row >= term.buffer.active.viewportY)
        active = from === -1 ? 0 : from
        reveal()
      }

      paint()
      report()
    },
    next(): void {
      step(1)
    },
    previous(): void {
      step(-1)
    },
    clear(): void {
      query = ''
      hits = []
      active = -1
      clearPaint()
      report()
    },
    status,
    refresh(): void {
      if (disposed) return
      scan()
    },
    dispose(): void {
      disposed = true
      if (timer !== 0) window.clearTimeout(timer)
      timer = 0
      for (const subscription of subscriptions) subscription.dispose()
      window.removeEventListener('termdeck:panel-shown', onShown)
      clearPaint()
    }
  }
}

function paintHit(
  term: Terminal,
  markers: IMarker[],
  decorations: IDecoration[],
  lineOffset: number,
  x: number,
  width: number,
  style: { fg: string; bg: string }
): void {
  const marker = term.registerMarker(lineOffset)
  if (!marker) return
  const decoration = term.registerDecoration({
    marker,
    x,
    width,
    backgroundColor: style.bg,
    foregroundColor: style.fg,
    // Under the selection, so a hit the user selects still reads as selected.
    layer: 'bottom'
  })
  if (!decoration) {
    marker.dispose()
    return
  }
  markers.push(marker)
  decorations.push(decoration)
}
