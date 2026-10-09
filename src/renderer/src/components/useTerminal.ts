import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

import type { ClipboardSettings, TerminalSettings, Theme } from '@shared/types'
import { buildTerminalOptions, terminalThemeFor } from './terminalTheme'
import {
  LineTimestamps,
  applyCursorBlink,
  registerStamps,
  registerTerminal,
  unregisterStamps,
  unregisterTerminal
} from './terminalRegistry'
import { registerSink, routeInput, unregisterSink } from './broadcast'

export interface TerminalHandle {
  /** Re-measure the terminal against its container and notify the backend. */
  refit(): void
  focus(): void
  getSelection(): string
  paste(text: string): void
  write(text: string): void
  /** Apply changed appearance settings to the live terminal. */
  applySettings(settings: TerminalSettings): void
  /** Repaint with a different theme palette. */
  applyTheme(theme: Theme): void
}

interface UseTerminalOptions {
  terminal: TerminalSettings
  clipboard: ClipboardSettings
  /** Active theme, so the terminal palette follows the app. */
  theme: Theme
  onExit?: (info: { code: number | null; signal: string | null }) => void
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
  options: UseTerminalOptions
): { handle: React.RefObject<TerminalHandle | null>; container: HTMLDivElement | null } {
  const handleRef = useRef<TerminalHandle | null>(null)
  // The terminal's host element, published once mounted so consumers (clipboard
  // listeners) can bind immediately instead of waiting for a re-render.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  // Latest values, without re-creating the terminal or re-binding listeners.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      ...buildTerminalOptions(optionsRef.current.terminal),
      theme: terminalThemeFor(optionsRef.current.theme)
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)

    let disposed = false
    let rafId = 0
    let lastCols = 0
    let lastRows = 0
    /** The container box the last fit was computed against. */
    let lastFitW = -1
    let lastFitH = -1

    const api = window.termdeck

    /**
     * Whether xterm's renderer has measured its cell yet.
     *
     * `FitAddon.proposeDimensions()` returns early when the rendered cell has no
     * size, so `fit()` silently does nothing and the terminal stays at xterm's
     * default 80x24 — while the pane around it is the correct 791px tall. Calling
     * `fit()` again in that window cannot help, because the early return happens
     * before any measurement; the fix is to wait until the renderer is ready.
     */
    const rendererReady = (): boolean => {
      const dims = (term as unknown as {
        _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } }
      })._core?._renderService?.dimensions?.css?.cell?.height
      return typeof dims === 'number' && dims > 0
    }

    const doFit = (): void => {
      if (disposed) return
      // An inactive dockview tab keeps its element in the DOM but at 0x0, and
      // fit() throws for a zero-size element — skip rather than spam errors.
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      if (!rendererReady()) return
      const w = container.clientWidth
      const h = container.clientHeight
      try {
        fit.fit()
      } catch {
        return
      }
      lastFitW = w
      lastFitH = h
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols
        lastRows = term.rows
        api.resizeSession(sessionId, term.cols, term.rows)
      }
    }

    /**
     * Keep the terminal fitted to its container.
     *
     * Event-driven fitting is not sufficient here. `ResizeObserver` only fires on
     * a *change*, `requestAnimationFrame` coalesces, and the pane settles over
     * several frames as dockview and the flex layout resolve — so the one fit that
     * matters can be computed against an intermediate box and never repeated,
     * leaving the pane 791px tall with the terminal still at xterm's 80x24
     * default.
     *
     * A short bounded watchdog therefore drives the fit directly: it compares the
     * height the rows need against the height available and refits while they
     * disagree, then stops. It costs a comparison per tick and is independent of
     * which layout event happens to arrive.
     */
    const fitToBox = (): void => {
      if (disposed) return
      const h = container.clientHeight
      const w = container.clientWidth
      if (h <= 0 || w <= 0) return

      doFit()

      const screen = container.querySelector('.xterm-screen') as HTMLElement | null
      const cell = screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0
      if (cell > 0 && Math.abs(term.rows * cell - h) >= cell) scheduleFit()
    }

    const scheduleFit = (): void => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(fitToBox)
    }

    const watchdog = window.setInterval(() => {
      if (disposed) return
      const h = container.clientHeight
      const screen = container.querySelector('.xterm-screen') as HTMLElement | null
      const cell = screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0
      // The renderer may not have measured its cell yet, in which case the fit did
      // nothing and has to be retried; otherwise compare rows against the box.
      const wrong = h > 0 && (!rendererReady() || cell === 0 || Math.abs(term.rows * cell - h) >= cell)
      if (wrong) scheduleFit()
    }, 120)
    const watchdogStop = window.setTimeout(() => window.clearInterval(watchdog), 6000)

    const paste = (text: string): void => {
      // term.paste() respects bracketed-paste mode, which is what a shell
      // expects; feeding the raw string via write() would corrupt multi-line
      // input in editors like vim.
      term.paste(text)
    }

    handleRef.current = {
      refit: scheduleFit,
      focus: () => term.focus(),
      getSelection: () => term.getSelection(),
      paste,
      write: (text: string) => term.write(text),
      applySettings: (settings: TerminalSettings) => {
        term.options.fontFamily = settings.fontFamily
        term.options.fontSize = settings.fontSize
        term.options.lineHeight = settings.lineHeight
        term.options.cursorStyle = settings.cursorStyle
        // Cursor blinking is driven by our own CSS (see applyCursorBlink): xterm
        // animates that class on no fixed cadence and its built-in tick is far
        // too fast. Leaving xterm's option off keeps the cursor steady and lets
        // the chosen rate apply.
        term.options.cursorBlink = false
        applyCursorBlink(container, settings.cursorBlink, settings.cursorBlinkMs)
        term.options.scrollback = settings.scrollback
        scheduleFit()
      },
      applyTheme: (theme: Theme) => {
        // xterm repaints on the next frame with the new palette.
        term.options.theme = terminalThemeFor(theme)
      }
    }

    // Expose the resolved container so consumers can attach DOM listeners now
    // rather than waiting for a re-render that never comes.
    setContainer(container)

    // Per-line timestamps for the optional gutter beside the terminal.
    const stamps = new LineTimestamps(term)
    applyCursorBlink(container, optionsRef.current.terminal.cursorBlink, optionsRef.current.terminal.cursorBlinkMs)

    // Test hook: lets the smoke harness drive a real selection, which is what
    // copy-on-select reacts to. Enabled only under localStorage.tdDebug.
    // Test hook: exposes the terminal so the smoke harness can drive a real
    // selection and inspect the buffer. Enabled only under localStorage.tdDebug.
    if (window.localStorage.getItem('tdDebug') === '1') {
      const debug = ((window as unknown as Record<string, unknown>)['__tdTerminals'] ??= {}) as Record<
        string,
        unknown
      >
      debug[sessionId] = { term, handle: handleRef.current, stamps }
    }
    // Always available: copy/save-output and the timestamp gutter read the
    // scrollback through this, and those must work outside debug builds.
    registerTerminal(sessionId, term)
    registerStamps(sessionId, stamps)

    scheduleFit()
    term.focus()

    const dataSub = term.onData((data) => {
      // Broadcast first: when it handles the keystroke, this pane must not also
      // write it, or the source pane would receive the character twice.
      if (routeInput(sessionId, data)) return
      api.writeSession(sessionId, data)
    })

    // How a keystroke typed in another pane reaches this one.
    registerSink(sessionId, (data) => api.writeSession(sessionId, data))

    // Copy-on-select: mirror any new selection straight to the OS clipboard, so
    // Ctrl+C stays free for the remote shell.
    const selectionSub = term.onSelectionChange(() => {
      if (!optionsRef.current.clipboard.copyOnSelect) return
      const selection = term.getSelection()
      if (selection) void api.copyToClipboard(selection)
    })

    // Output produced before this terminal subscribed (SSH handshakes can take
    // seconds) is replayed from the main process's rolling buffer. `seenSeq`
    // guards against rendering a chunk twice when replay and live data overlap.
    let seenSeq = 0

    const offData = api.onSessionData((id, chunk, seq) => {
      if (id !== sessionId) return
      if (seq <= seenSeq) return
      seenSeq = seq
      term.write(chunk)
      stamps.sync()
    })

    void api
      .replaySession(sessionId)
      .then((replay) => {
        if (disposed || !replay) return
        if (replay.seq > seenSeq) seenSeq = replay.seq
        if (replay.data) term.write(replay.data)
      })
      .catch(() => {
        // Session already gone; the exit event will report it.
      })

    const offError = api.onSessionError((id, message) => {
      if (id === sessionId) term.write(`\r\n\x1b[31m[termdeck] ${message}\x1b[0m\r\n`)
    })

    const offExit = api.onSessionExit((id, info) => {
      if (id !== sessionId) return
      term.write(`\r\n\x1b[33m[termdeck] session ended (exit ${info.code ?? 'n/a'})\x1b[0m\r\n`)
      optionsRef.current.onExit?.(info)
    })

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)

    /*
     * Fit once now, and once more after layout settles.
     *
     * Registering the observer alone is not enough: it only fires on a *change*,
     * and dockview can attach a panel before its group has been measured. Without
     * this first fit the terminal keeps xterm's default 80x24 forever, so it
     * paints 456px tall inside a 791px host — which left a dead band at the
     * bottom of the pane that the snippet bar appeared to cover.
     */
    scheduleFit()
    const settleTimer = window.setTimeout(scheduleFit, 120)

    // Broadcast by ReactContentRenderer.onShow when a hidden pane reappears.
    const onShown = (): void => scheduleFit()
    window.addEventListener('termdeck:panel-shown', onShown)

    return () => {
      disposed = true
      if (rafId) cancelAnimationFrame(rafId)
      window.clearTimeout(settleTimer)
      window.clearInterval(watchdog)
      window.clearTimeout(watchdogStop)
      handleRef.current = null
      unregisterTerminal(sessionId)
      unregisterStamps(sessionId)
      unregisterSink(sessionId)
      stamps.dispose()
      if (window.localStorage.getItem('tdDebug') === '1') {
        const debug = (window as unknown as Record<string, unknown>)['__tdTerminals'] as
          | Record<string, unknown>
          | undefined
        if (debug) delete debug[sessionId]
      }
      observer.disconnect()
      window.removeEventListener('termdeck:panel-shown', onShown)
      dataSub.dispose()
      selectionSub.dispose()
      offData()
      offError()
      offExit()
      term.dispose()
    }
  }, [containerRef, sessionId])

  // Apply appearance changes to the live terminal without rebuilding it, so
  // changing the font in settings updates every open pane immediately.
  useEffect(() => {
    handleRef.current?.applySettings(options.terminal)
  }, [
    options.terminal.fontFamily,
    options.terminal.fontSize,
    options.terminal.lineHeight,
    options.terminal.cursorStyle,
    options.terminal.cursorBlink,
    options.terminal.scrollback
  ])

  // Follow the active theme without rebuilding the terminal.
  useEffect(() => {
    handleRef.current?.applyTheme(options.theme)
  }, [options.theme])

  return { handle: handleRef, container }
}
