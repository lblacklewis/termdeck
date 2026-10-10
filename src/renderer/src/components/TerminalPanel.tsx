import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { SessionInfo } from '@shared/types'
import { useTerminal, type TerminalHandle } from './useTerminal'
import { useClipboard, needsPasteConfirmation } from './useClipboard'
import { useSettings } from './useSettings'
import { getStamps, getTerminal, onTerminalRender } from './terminalRegistry'

interface TerminalPanelProps {
  /** Absent for a pane restored from a saved layout. */
  session?: SessionInfo
  /** Shown when there is no live session. */
  title?: string
  /** Saved session to reconnect to, for a restored pane. */
  savedSessionId?: string
  /**
   * Explicitly restored-and-disconnected. Set by the restore path rather than
   * inferred from a missing session, so a panel restored from storage renders
   * its placeholder on its first paint — before any app state has loaded.
   */
  disconnected?: boolean
  onSessionEnded: (sessionId: string) => void
  /** Reconnect a restored pane. */
  onReconnect?: (savedSessionId: string, title: string) => void
}

/**
 * One pane of the layout: an xterm.js terminal bound to one backend session,
 * with Termius-style clipboard behaviour attached to its container.
 *
 * Settings are subscribed to here rather than received as props: dockview
 * instantiates panels from a factory that captures its arguments once, so props
 * would freeze at creation time and a settings change would never reach an
 * already-open pane.
 */
export function TerminalPanel({
  session,
  title,
  savedSessionId,
  disconnected,
  onSessionEnded,
  onReconnect
}: TerminalPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<TerminalHandle | null>(null)
  const [ended, setEnded] = useState<{ code: number | null } | null>(null)
  // Pending multi-line paste awaiting confirmation.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { settings, theme } = useSettings()
  const { terminal, clipboard } = settings
  const showTimestamps = terminal.showTimestamps

  const handleExit = useCallback(
    (info: { code: number | null; signal: string | null }) => {
      setEnded({ code: info.code })
      if (session) onSessionEnded(session.id)
    },
    [onSessionEnded, session]
  )

  const { handle: innerRef, container } = useTerminal(containerRef, session?.id ?? 'disconnected', {
    terminal,
    clipboard,
    theme,
    onExit: handleExit
  })

  // Mirror the inner handle so the clipboard target can read it synchronously.
  useEffect(() => {
    terminalRef.current = innerRef.current
  })

  const paste = useCallback(
    (text: string) => {
      if (needsPasteConfirmation(text, clipboard)) {
        setPending(text)
        return
      }
      innerRef.current?.paste(text)
    },
    [clipboard, innerRef]
  )

  // `container` is a resolved element, so the listeners bind as soon as the
  // terminal is in the DOM rather than never.
  useClipboard(container, clipboard, {
    copy: (text) => void window.termdeck.copyToClipboard(text),
    paste,
    getSelection: () => innerRef.current?.getSelection() ?? ''
  })

  // dockview hides panels rather than unmounting them, so a pane that becomes
  // visible again must re-measure; otherwise the backend keeps a stale size.
  useEffect(() => {
    const onShown = (): void => innerRef.current?.refit()
    window.addEventListener('termdeck:panel-shown', onShown)
    return () => window.removeEventListener('termdeck:panel-shown', onShown)
  }, [innerRef])

  const focusTerminal = useCallback(() => innerRef.current?.focus(), [innerRef])

  /**
   * Height of one terminal row, measured from the rendered screen.
   *
   * Taken from the DOM rather than computed from `fontSize * lineHeight`:
   * xterm rounds the cell height to whole device pixels, and `lineHeight` is a
   * bare multiplier (1.2) that CSS would treat as `1.2px` if used directly.
   * Measuring keeps the gutter aligned to every row instead of drifting.
   */
  const [rowHeight, setRowHeight] = useState(0)
  /** Vertical gap between the pane top and xterm's first row. */
  const [topOffset, setTopOffset] = useState(0)
  const [stampLines, setStampLines] = useState<Array<string | null>>([])
  /**
   * Width of the stamp column, measured from a real stamp.
   *
   * Not an `em` value: the gutter sets a smaller font size than the terminal, and
   * a column narrower than `[HH:MM:SS]` clips the closing bracket on every line.
   * Measuring the rendered string makes the column fit whatever font and size are
   * actually in use.
   */
  const [stampWidth, setStampWidth] = useState(0)
  /** The gutter element, so its row offset can be corrected without a render. */
  const gutterRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!showTimestamps || !session) {
      setStampLines([])
      return
    }
    // Driven by the terminal's own render event rather than a rAF loop: a loop
    // started here can have its first frame cancelled by this effect's cleanup,
    // which left the gutter permanently empty.
    /**
     * Recompute the gutter's row offset from freshly measured geometry.
     *
     * xterm insets its own screen box inside the pane (its viewport wrapper plus
     * the host padding), so the gutter needs the same offset to line up with row 1.
     * It is written straight onto the element as well as into state: state needs a
     * render to arrive, and in between the gutter can paint a row higher than the
     * terminal — visible, and intermittently visible to the alignment check.
     */
    const syncGutterOffset = (): void => {
      const screen = container?.querySelector('.xterm-screen') as HTMLElement | null
      const pane = container?.closest('.td-terminal') as HTMLElement | null
      if (!screen || !pane) return
      const offset = screen.getBoundingClientRect().top - pane.getBoundingClientRect().top
      if (offset < 0) return
      gutterRef.current?.style.setProperty('--td-stamp-top', `${offset}px`)
      setTopOffset((prev) => (Math.abs(prev - offset) < 0.5 ? prev : offset))
    }

    const repaint = (): void => {
      const term = getTerminal(session.id)
      const stamps = getStamps(session.id)
      if (!term || !stamps) return
      const buffer = term.buffer.active
      const lines: Array<string | null> = []
      for (let r = 0; r < term.rows; r++) {
        // `viewportY` is the buffer line at the top of the viewport, so this
        // follows scrolling rather than assuming a fixed offset. `labelAt` blanks
        // the repeats inside one second, so the column shows transitions.
        lines.push(stamps.labelAt(buffer.viewportY + r))
      }
      setStampLines((prev) =>
        prev.length === lines.length && prev.every((v, i) => v === lines[i]) ? prev : lines
      )
      /*
       * Size the column from what is actually rendered, not from an `em` multiple:
       * the gutter's font is smaller than the terminal's, so an em estimate came
       * out narrower than the stamp and clipped the closing bracket. The measurer
       * is a real stamp element, so it carries the same font, letter-spacing and
       * padding.
       *
       * `scrollWidth` is the text alone, and the element is `border-box`, so the
       * gutter's own left/right padding has to be added back or the inline width
       * would squeeze the text by exactly that much. Two pixels of slack on top,
       * because the gutter clips its overflow: one pixel short cuts a glyph rather
       * than looking slightly tight.
       */
      const measurer = container?.querySelector('.td-terminal-stamp-measure') as HTMLElement | null
      if (measurer) {
        const styles = getComputedStyle(measurer)
        const padding =
          parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
        const width = measurer.scrollWidth + padding + 2
        if (width > 0) setStampWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width))
      }
      const screen = container?.querySelector('.xterm-screen') as HTMLElement | null
      if (screen) {
        const next = screen.getBoundingClientRect().height / term.rows
        if (next > 1) setRowHeight((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
      }
      syncGutterOffset()
    }
    // Paint once immediately, then follow every terminal render. The screen box
    // also moves when the pane is refitted without producing a render, so its
    // geometry is watched directly — but only the offset is recomputed there, so
    // this cannot feed back into the layout it is measuring.
    repaint()
    const offRender = onTerminalRender(session.id, repaint)
    const screenEl = container?.querySelector('.xterm-screen')
    const geometry = screenEl ? new ResizeObserver(syncGutterOffset) : null
    if (screenEl && geometry) geometry.observe(screenEl)
    return () => {
      offRender()
      geometry?.disconnect()
    }
  }, [showTimestamps, session, container])

  // A pane restored from a saved layout has no backend session: nothing is
  // reconnected on launch, because silently spawning shells or SSH connections
  // would be a surprise. Offer the one click instead.
  if (!session || disconnected) {
    return (
      <div className="td-terminal td-terminal-restored" data-testid="restored-pane">
        <div className="td-welcome-inner">
          <div className="td-watermark-title">{title || 'Session'}</div>
          <p className="td-hint">
            This pane was restored from your last layout. Nothing is reconnected automatically.
          </p>
          <button
            className="td-btn td-btn-primary"
            data-testid="reconnect-pane"
            disabled={busy}
            onClick={() => {
              if (!onReconnect || !savedSessionId) return
              setBusy(true)
              onReconnect(savedSessionId, title || 'Session')
            }}
          >
            {busy ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="td-terminal" onMouseDown={focusTerminal}>
      {showTimestamps && stampLines.length > 0 && (
        <div
          className="td-terminal-stamps"
          data-testid="timestamp-gutter"
          aria-hidden="true"
          ref={gutterRef}
          style={{
            fontSize: `${Math.max(9, terminal.fontSize - 3)}px`,
            // An explicit px height: a bare `lineHeight` multiplier would be
            // interpreted as pixels by CSS and collapse the rows.
            lineHeight: rowHeight > 0 ? `${rowHeight}px` : 'normal',
            // Published as a variable so the stylesheet owns the padding while the
            // measured offset still aligns row 1 with the terminal.
            ['--td-stamp-top' as string]: `${topOffset}px`,
            // Measured in the effect above; 0 means "not measured yet".
            ...(stampWidth > 0 ? { width: `${stampWidth}px` } : {})
          }}
        >
          {stampLines.map((label, i) => (
            <div className="td-terminal-stamp" key={i}>
              {label ?? '\u00a0'}
            </div>
          ))}
          {/* Renders one full-width stamp to measure against. Inset far off the
              gutter's own box so it can never paint, but still laid out. */}
          <div className="td-terminal-stamp-measure" aria-hidden="true">
            [00:00:00]
          </div>
        </div>
      )}
      <div className="td-terminal-host" ref={containerRef} />

      {pending !== null && (
        <div className="td-paste-guard">
          <div className="td-paste-guard-title">Paste {pending.split(/\r?\n/).length} lines?</div>
          <pre className="td-paste-guard-preview">{pending.slice(0, 400)}</pre>
          <div className="td-paste-guard-actions">
            <button className="td-btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              className="td-btn td-btn-primary"
              onClick={() => {
                innerRef.current?.paste(pending)
                setPending(null)
              }}
            >
              Paste
            </button>
          </div>
        </div>
      )}

      {ended !== null && (
        <div className="td-terminal-banner">
          <span>Session ended{ended.code !== null ? ` with exit code ${ended.code}` : ''}.</span>
          <span className="td-terminal-banner-hint">Drag or close this tab, then reconnect.</span>
        </div>
      )}
    </div>
  )
}
