import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { SessionExitInfo, SessionInfo } from '@shared/types'
import { useTerminal, type TerminalHandle } from './useTerminal'
import { useClipboard, needsPasteConfirmation } from './useClipboard'
import { useSettings } from './useSettings'
import { getStamps, getTerminal, onTerminalRender } from './terminalRegistry'
import { t } from '../i18n'

/**
 * How long a connection has to survive before a drop counts as a new outage.
 *
 * Long enough to cover a transport that reports success as soon as the socket
 * opens, short enough that a link which held for a minute is treated as having
 * recovered.
 */
const STABLE_CONNECTION_MS = 10_000

/** A key combination as individual keys, the way the rest of the app draws them. */
function Keys({ keys, testId }: { keys: string; testId?: string }): JSX.Element {
  const parts = keys
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  return (
    <span className="td-keys" data-testid={testId} data-keys={keys}>
      {parts.map((part, index) => (
        <span key={part + index}>
          {index > 0 && ' + '}
          <kbd>{part}</kbd>
        </span>
      ))}
    </span>
  )
}

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
  /**
   * Reopen the session behind *this* pane after it ended.
   *
   * Different from `onReconnect`, which is about a pane restored from a saved
   * layout: this one has a live-then-dead session and no saved host to look up.
   * Resolves false when the reconnect could not be started, so the button can
   * stop saying "Reconnecting…".
   */
  onReconnectSession?: () => Promise<boolean>
  /**
   * The reconnect shortcut as currently bound, shown on both reconnect pages.
   *
   * Passed in rather than written here so a remapped key shows as the key that works.
   */
  reconnectHint?: string
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
  onReconnect,
  onReconnectSession,
  reconnectHint
}: TerminalPanelProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<TerminalHandle | null>(null)
  const [ended, setEnded] = useState<{ code: number | null } | null>(null)
  // Pending multi-line paste awaiting confirmation.
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /*
   * A new session behind this pane means it is not ended any more. Without this
   * the overlay would stay over the freshly reconnected terminal: `ended` is
   * local state, so re-rendering with a new `session` prop does not clear it.
   */
  useEffect(() => {
    /*
     * Keyed on the session *object*, not its id: a reconnect rebuilds the session
     * under the same id (that is what keeps this terminal, and your scrollback, in
     * place), so the id alone would not tell this component that it is alive again.
     */
    if (session) {
      setEnded(null)
      aliveSinceRef.current = Date.now()
    }
  }, [session])

  const { settings, theme } = useSettings()
  const { terminal, clipboard } = settings
  const showTimestamps = terminal.showTimestamps

  /*
   * Auto-retry state: which attempt is running and how long is left on its delay.
   *
   * `retryToken` exists so a manual reconnect, a new session or an unmount can
   * cancel a countdown that is already running — without it a stale loop would
   * fire a reconnect into a pane that has moved on.
   */
  const [retry, setRetry] = useState<{
    attempt: number
    of: number
    secondsLeft: number
    gaveUp?: boolean
  } | null>(null)
  const retryTokenRef = useRef(0)
  /*
   * Attempts made in the current outage, and when the current connection came up.
   *
   * The count deliberately survives a reconnect that immediately drops again: with
   * a transport that reports success as soon as the socket opens (telnet, serial),
   * "it reconnected" and "it is connected" are different claims, and counting only
   * consecutive *failures* would retry a dead host forever.
   */
  const attemptRef = useRef(0)
  const aliveSinceRef = useRef(0)

  const stopRetry = useCallback(() => {
    retryTokenRef.current += 1
    setRetry(null)
  }, [])

  useEffect(() => stopRetry, [stopRetry])

  const handleExit = useCallback(
    (info: SessionExitInfo) => {
      setEnded({ code: info.code })
      if (session) onSessionEnded(session.id)

      /*
       * A connection that dropped on its own is worth retrying; a session the user
       * ended is not. `expected` covers the pane being closed or Ctrl+D, and a
       * clean exit status covers someone typing `exit` at the prompt — a shell that
       * ended on purpose should not open itself again.
       */
      const { enabled, attempts, delaySeconds } = settings.reconnect
      const passive = !info.expected && info.code !== 0
      if (!enabled || !passive || attempts < 1 || !onReconnectSession) return

      /*
       * A connection that stayed up for a while is a fresh outage, and starts its
       * attempts over. One that dropped again straight away is the same outage
       * continuing, and carries on counting — otherwise "three attempts" would mean
       * three per reconnect, which for a flapping link is no limit at all.
       */
      if (Date.now() - aliveSinceRef.current > STABLE_CONNECTION_MS) attemptRef.current = 0

      const token = (retryTokenRef.current += 1)
      void (async () => {
        while (attemptRef.current < attempts) {
          attemptRef.current += 1
          const attempt = attemptRef.current
          for (let left = delaySeconds; left > 0; left -= 1) {
            if (retryTokenRef.current !== token) return
            setRetry({ attempt, of: attempts, secondsLeft: left })
            await new Promise((resolve) => window.setTimeout(resolve, 1000))
          }
          if (retryTokenRef.current !== token) return
          setRetry({ attempt, of: attempts, secondsLeft: 0 })
          const ok = await onReconnectSession()
          if (retryTokenRef.current !== token) return
          // Back up. If it drops again inside the stability window the next exit
          // picks the count up where this left it.
          if (ok) {
            setRetry(null)
            return
          }
        }
        // Out of attempts: leave the pane to the user, with the button still there.
        setRetry({ attempt: attempts, of: attempts, secondsLeft: 0, gaveUp: true })
      })()
    },
    [onSessionEnded, onReconnectSession, session, settings.reconnect]
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
            {t('terminalpanel.this_pane_was_restored_from', 'This pane was restored from your last layout. Nothing is reconnected automatically.')}
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
          {reconnectHint && (
            <p className="td-hint td-reconnect-hint">
              {t('terminalpanel.or_press', 'Or press')}{' '}
              <Keys keys={reconnectHint} testId="reconnect-keys" />{' '}
              {t('terminalpanel.to_reconnect_2', 'to reconnect.')}
            </p>
          )}
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
          <div className="td-paste-guard-title">{t('terminalpanel.paste', 'Paste')}{pending.split(/\r?\n/).length} lines?</div>
          <pre className="td-paste-guard-preview">{pending.slice(0, 400)}</pre>
          <div className="td-paste-guard-actions">
            <button className="td-btn" onClick={() => setPending(null)}>
              {t('terminalpanel.cancel', 'Cancel')}
            </button>
            <button
              className="td-btn td-btn-primary"
              onClick={() => {
                innerRef.current?.paste(pending)
                setPending(null)
              }}
            >
              {t('terminalpanel.paste_2', 'Paste')}
            </button>
          </div>
        </div>
      )}

      {ended !== null && (
        <div className="td-terminal-overlay" data-testid="session-ended-overlay">
          <div className="td-terminal-overlay-card">
            <div className="td-terminal-overlay-title" data-testid="session-ended-title">
              {retry && !retry.gaveUp
                ? t('terminalpanel.reconnecting', 'Reconnecting…')
                : t('terminalpanel.session_ended', 'Session ended')}
              {ended.code !== null ? ` · exit ${ended.code}` : ''}
            </div>
            {retry ? (
              <p className="td-terminal-overlay-hint" data-testid="reconnect-progress">
                {retry.gaveUp
                  ? t(
                      'terminalpanel.auto_gave_up',
                      'Gave up after {n} attempts. Retry by hand, or close the pane.',
                      { n: retry.of }
                    )
                  : t(
                      'terminalpanel.auto_retry',
                      'Attempt {attempt} of {of} — connecting in {seconds}s',
                      { attempt: retry.attempt, of: retry.of, seconds: retry.secondsLeft }
                    )}
              </p>
            ) : (
              <p className="td-terminal-overlay-hint">
                {t(
                  'terminalpanel.ended_hint',
                  'This pane is still here, and so is everything above it. Reconnect to keep working in it.'
                )}
              </p>
            )}
            {onReconnectSession && (
              <div className="td-terminal-overlay-actions">
                <button
                  className="td-btn td-btn-primary"
                  data-testid="reconnect-session"
                  disabled={busy}
                  onClick={() => {
                    stopRetry()
                    // A deliberate retry starts the count over.
                    attemptRef.current = 0
                    setBusy(true)
                    void onReconnectSession().finally(() => setBusy(false))
                  }}
                >
                  {busy
                    ? t('terminalpanel.reconnecting', 'Reconnecting…')
                    : t('terminalpanel.reconnect', 'Reconnect')}
                </button>
                {retry && !retry.gaveUp && (
                  <button
                    className="td-btn"
                    data-testid="reconnect-cancel"
                    onClick={stopRetry}
                  >
                    {t('terminalpanel.cancel_retry', 'Stop retrying')}
                  </button>
                )}
                {reconnectHint && (
                  <span className="td-reconnect-hint" data-testid="reconnect-keys-hint">
                    {t('terminalpanel.or_press', 'Or press')}{' '}
                    <Keys keys={reconnectHint} testId="reconnect-keys" />
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
