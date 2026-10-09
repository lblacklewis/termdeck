import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DockviewComponent, type DockviewApi, type GroupPanelPartInitParameters } from 'dockview'

import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CreateSessionResult,
  type CredentialStatus,
  type HostKeyPrompt,
  type LayoutState,
  type SavedSession,
  type SessionFolder,
  type SessionInfo,
  type SessionTree as Tree,
  type Snippet,
  type SshConnectPayload,
  type TerminalPanelMeta
} from '@shared/types'
import { ReactContentRenderer, ReactWatermarkRenderer, refreshPanelParams } from './components/ReactRenderer'
import { TerminalPanel } from './components/TerminalPanel'
import { WelcomePanel } from './components/WelcomePanel'
import { ConnectionDialog } from './components/ConnectionDialog'
import {
  SessionTree,
  type ContextMenuState,
  type DragPayload,
  type TabMenuState
} from './components/SessionTree'
import { SessionEditor } from './components/SessionEditor'
import { SettingsDialog } from './components/SettingsDialog'
import { HostKeyDialog } from './components/HostKeyDialog'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { ConnectionsWindow } from './components/ConnectionsWindow'
import { PasswordPrompt } from './components/PasswordPrompt'
import { SnippetBar } from './components/SnippetBar'
import { SnippetEditor } from './components/SnippetEditor'
import { KnownHostsPage } from './components/KnownHostsPage'
import { SnippetsPage } from './components/SnippetsPage'
import { LogsPage, type LogEntry } from './components/LogsPage'
import { HostsPage } from './components/HostsPage'
import { Drawer } from './components/Drawer'
import { NavRail, type PageId } from './components/NavRail'
import { readScrollback } from './components/terminalRegistry'
import {
  broadcastSummary,
  isBroadcasting,
  onBroadcastChange,
  toggleBroadcasting
} from './components/broadcast'
import { useShortcuts } from './components/useShortcuts'
import { useTheme } from './components/useTheme'

const api = window.termdeck

/**
 * What dockview carries for a terminal panel. A pane restored from a saved
 * layout has no live session, so it holds only a title and the saved session id.
 */
interface TerminalPanelParams extends TerminalPanelMeta {
  savedSessionId?: string
  onEnded?: (sessionId: string) => void
}

interface HostKeyRequest {
  prompt: HostKeyPrompt
  /** Payload to retry with once the key is accepted. */
  payload: SshConnectPayload
  keyType: string
  keyData: string
}

const EMPTY_TREE: Tree = { folders: [], sessions: [] }

export function App(): JSX.Element {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const dockApiRef = useRef<DockviewApi | null>(null)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [tree, setTree] = useState<Tree>(EMPTY_TREE)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  // Applies the theme to the document (CSS custom properties) as it changes.
  useTheme(settings.theme)

  /*
   * Apply the interface scale.
   *
   * Skipped on the first render: the main process already applied the stored
   * scale before the window was shown.
   *
   * Every scale change has to go through here, including the settings drawer's
   * live preview, because a zoom change does not alter the container's CSS size —
   * the ResizeObserver watching it stays silent, while dockview's internal grid
   * is left at its 100x100 placeholder and every pane paints into a 65px box with
   * an empty terminal. The layout sync is re-asserted once the zoom has landed.
   */
  const scaleAppliedRef = useRef(false)
  const applyUiScale = useCallback((scale: number): void => {
    const sync = (): void => {
      // Two frames: one for the zoom to be applied, one for the viewport to
      // settle at the new size before dockview is asked to re-measure.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => dockSyncRef.current?.())
      })
    }
    void api
      .setUiScale(scale)
      .then(async () => {
        sync()
        // A zoom change is asynchronous in Chromium; a second, later sync covers
        // the case where the first pair of frames lands before it takes effect.
        await new Promise((resolve) => window.setTimeout(resolve, 120))
        sync()
      })
      .catch(() => {
        // A scale that cannot be applied is not worth interrupting the user for.
      })
  }, [])

  useEffect(() => {
    if (!scaleAppliedRef.current) {
      scaleAppliedRef.current = true
      return
    }
    applyUiScale(settings.uiScale)
  }, [settings.uiScale, applyUiScale])
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>({
    backend: 'local',
    detail: '',
    encrypted: true,
    sessionCount: 0,
    credentialCount: 0
  })
  const [knownTags, setKnownTags] = useState<string[]>([])
  const [tagFilter, setTagFilter] = useState<string[]>([])

  const [appMeta, setAppMeta] = useState<Awaited<ReturnType<typeof api.appInfo>> | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  /** Collapsed to a slim strip rather than hidden entirely. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorSession, setEditorSession] = useState<SavedSession | null>(null)
  const [editorParentId, setEditorParentId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [hostKeyRequest, setHostKeyRequest] = useState<HostKeyRequest | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** Error from a toast-style connection attempt (no dialog on screen). */
  const [alert, setAlert] = useState<{ message: string; code?: string; sessionId?: string } | null>(
    null
  )
  /** Session id currently being connected, so the tree can show a spinner. */
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [snippetBarVisible, setSnippetBarVisible] = useState(true)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** Right-click on a pane tab, which has its own item set. */
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null)
  /**
   * Set when a saved session cannot authenticate: connection failures for a
   * missing or rejected password offer a prompt instead of sending the user off
   * to edit the session.
   */
  const [passwordPrompt, setPasswordPrompt] = useState<{
    session: SavedSession
    reason?: string
    retry?: boolean
  } | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)
  /** Which rail section is showing. */
  const [page, setPage] = useState<PageId>('terminal')
  /** Mirrors the broadcast module, which owns the mode. */
  const [broadcasting, setBroadcasting] = useState(isBroadcasting)
  /** Session-scoped activity log; never persisted. */
  const [logEntries, setLogEntries] = useState<LogEntry[]>([])

  /** Append to the activity log, trimming the oldest beyond a cap. */
  const log = useCallback((level: LogEntry['level'], message: string) => {
    setLogEntries((prev) =>
      [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), level, message }, ...prev].slice(
        0,
        300
      )
    )
  }, [])
  const [snippetEditor, setSnippetEditor] = useState<{ snippet: Snippet | null; group: string } | null>(
    null
  )
  /**
   * Credentials carried from the quick-connect dialog into the session editor,
   * so "Save as session" does not make the user retype the password.
   */
  const [prefillCredential, setPrefillCredential] = useState<
    { password?: string; passphrase?: string } | undefined
  >(undefined)

  /** Open the saved-session form, for editing or for a new one in a folder. */
  const openEditor = useCallback((session: SavedSession | null, parentId: string | null) => {
    setEditorSession(session)
    setEditorParentId(parentId)
    setEditorOpen(true)
  }, [])

  // Dockview keeps callbacks for the component's lifetime, so route them via refs.
  const removeSessionState = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
  }, [])
  const endedRef = useRef(removeSessionState)
  endedRef.current = removeSessionState

  // The dockview factory and connect helpers are registered once, so they read
  // the current tree through a ref rather than a captured value.
  const treeRef = useRef<Tree>(EMPTY_TREE)
  treeRef.current = tree

  /**
   * Layout is read once, before the dockview bootstrap effect runs, and read
   * through a ref there so that effect keeps its empty dependency list.
   */
  /** Set by the connect helpers; called by a restored pane's Reconnect button. */
  const reconnectRef = useRef<(savedSessionId: string, title: string) => void>(() => {})
  /** Latest connectSaved, so the reconnect effect need not re-run every render. */
  const connectSavedRef = useRef<(session: SavedSession, password?: string) => Promise<void>>(
    async () => {}
  )
  /**
   * Maps a live session id to the saved session it came from, so a connected
   * session can adopt the placeholder pane that the restored layout left behind.
   */
  const savedIdForSessionRef = useRef<Map<string, string>>(new Map())
  /** Guards against the initial hydration being written straight back. */
  const hydratedRef = useRef(false)
  /**
   * Forces dockview to re-layout against its container's real size.
   *
   * A pane added before the dock has been measured inherits a 100x100
   * placeholder and never grows, which leaves the terminal painting in a 65px
   * box. `addSession` calls this after adding a panel.
   */
  const dockSyncRef = useRef<(() => void) | null>(null)

  const refreshTree = useCallback(async () => {
    const [next, tags] = await Promise.all([api.loadSessionTree(), api.allTags()])
    setTree(next)
    setKnownTags(tags)
  }, [])
  const refreshCredentials = useCallback(async () => {
    setCredentialStatus(await api.credentialStatus())
  }, [])

  useEffect(() => {
    void api.appInfo().then(setAppMeta)
    void api.loadSettings().then(setSettings)
    void refreshTree()
    void refreshCredentials()

    // Restore the saved arrangement: which rail section, and whether the side
    // bar and snippet bar were showing. The docking layout itself is applied by
    // the dockview bootstrap effect, which reads it from the same ref.
    void api.loadLayout().then((layout) => {
      setPage(layout.page)
      setSidebarVisible(layout.sidebarVisible)
      setSidebarCollapsed(layout.sidebarCollapsed)
      setSnippetBarVisible(layout.snippetBarVisible)
      hydratedRef.current = true
    })

    // Adopt settings saved from anywhere (another window, or the settings
    // dialog) so the shortcut map and app-level options stay current. Terminals
    // subscribe on their own, since dockview panel props are captured once.
    const offSettings = api.onSettingsChanged(setSettings)

    // The sidebar cannot observe the session store directly, so it follows the
    // main process's broadcasts instead of relying on each caller to refresh it.
    const offTree = api.onTreeChanged(setTree)
    const offTags = api.onTagsChanged(setKnownTags)

    return () => {
      offSettings()
      offTree()
      offTags()
    }
  }, [refreshTree, refreshCredentials])

  const closeSession = useCallback(
    (sessionId: string) => {
      api.closeSession(sessionId)
      const panel = dockApiRef.current?.getPanel(sessionId)
      if (panel) dockApiRef.current?.removePanel(panel)
      removeSessionState(sessionId)
    },
    [removeSessionState]
  )

  // ---- dockview bootstrap -------------------------------------------------

  useEffect(() => {
    const container = dockRef.current
    if (!container) return

    /*
     * A container with no size yet is not usable: dockview would measure 0x0 and
     * every view it creates inherits that. Wait for a real box in that case.
     */
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      const waiter = new ResizeObserver(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          waiter.disconnect()
          start()
        }
      })
      waiter.observe(container)
      return () => waiter.disconnect()
    }

    return start()

    function start(): (() => void) | undefined {
    // Bound locally: TypeScript cannot carry the null-check above into a nested
    // function, and this also pins the element the dock is built against.
    const host = container as HTMLDivElement
    const dock = new DockviewComponent(host, {
      createComponent: (options) => {
        if (options.name === 'terminal') {
          return new ReactContentRenderer((params: GroupPanelPartInitParameters) => {
            const panelParams = params.params as TerminalPanelParams
            return (
              <TerminalPanel
                session={panelParams.session}
                title={panelParams.title}
                savedSessionId={panelParams.savedSessionId}
                disconnected={panelParams.disconnected}
                onReconnect={(id, name) => reconnectRef.current(id, name)}
                onSessionEnded={(id) => endedRef.current(id)}
              />
            )
          })
        }
        return new ReactContentRenderer(() => <WelcomePanel />)
      },
      createWatermarkComponent: () =>
        new ReactWatermarkRenderer(() => (
          <div className="td-watermark-inner">
            <div className="td-watermark-title">No session</div>
            <div className="td-watermark-hint">
              Open a saved session, or press <kbd>Ctrl</kbd>+<kbd>T</kbd> to connect.
            </div>
          </div>
        )),
      dndEdges: {
        size: { value: 24, type: 'pixels' },
        activationSize: { value: 12, type: 'pixels' }
      }
    })

    dockApiRef.current = dock.api

    /*
     * Size dockview before any panel exists.
     *
     * A panel created while the dock still believes it is 100x100 builds its
     * internal views at that size and never grows them again: `layout()` does not
     * repair it afterwards, because the views were constructed against the stale
     * model. Laying out immediately after construction means the first panel is
     * always built against the real box, which is what keeps the terminal from
     * painting in a 65px tall container.
     */
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      dock.layout(host.clientWidth, host.clientHeight, true)
    }

    if (window.localStorage.getItem('tdDebug') === '1') {
      ;(window as unknown as Record<string, unknown>)['__tdDockApi'] = dock.api
      // The component itself: `api.layout` is not the same function as
      // `dock.layout`, and probes need the latter.
      ;(window as unknown as Record<string, unknown>)['__tdDock'] = dock
    }

    const removed = dock.api.onDidRemovePanel((panel) => {
      if (panel.id !== 'welcome') api.closeSession(panel.id)
      removeSessionState(panel.id)
    })

    // Persist on every layout change, debounced: dragging a divider fires many.
    let saveTimer: number | undefined
    let dirty = false

    /**
     * Serialise to a string before sending. dockview's `toJSON()` result is not
     * structured-cloneable, so passing it over IPC fails outright and the layout
     * would be silently lost.
     */
    const layoutJson = (): string | null => {
      try {
        return JSON.stringify(dock.api.toJSON())
      } catch {
        return null
      }
    }

    const persist = (): void => {
      const json = layoutJson()
      dirty = false
      if (json) void api.saveLayout({ dockview: json })
    }

    const disposition = dock.api.onDidLayoutChange(() => {
      dirty = true
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(persist, 400)
    })

    /**
     * Restore the previous arrangement.
     *
     * Awaited rather than read from a ref: this effect runs before the effect
     * that hydrates app state, so a ref would always still be null here and the
     * saved layout would never be applied.
     *
     * Sessions are deliberately not reconnected. Each restored terminal becomes
     * a placeholder with a Reconnect button, because silently spawning shells or
     * SSH connections on launch would be a surprise.
     */
    let cancelled = false
    void api.loadLayout().then((layout) => {
      if (cancelled) return
      let restored = false
      if (layout.dockview) {
        try {
          dock.fromJSON(JSON.parse(layout.dockview))
          restored = dock.api.panels.length > 0
        } catch {
          // A layout saved by an incompatible version must not block startup.
          restored = false
        }
      }

      if (restored) {
        for (const panel of dock.api.panels) {
          if (panel.api.component !== 'terminal') continue
          panel.api.updateParameters({
            session: undefined,
            disconnected: true,
            savedSessionId: panel.id,
            title: panel.title || 'Session'
          })
          // dockview does not notify the content renderer of a params change, so
          // ask it to re-render with the disconnected props.
          refreshPanelParams(panel.id)
        }
      } else {
        dock.api.addPanel({ id: 'welcome', component: 'welcome', title: 'Welcome' })
      }
    })

    /**
     * Keep the docking layout in step with its container's real size.
     *
     * dockview measures itself when a panel is added, and at that moment the pane
     * has not been laid out yet: its internal views stay at a 100x100 placeholder
     * and never expand, so the terminal ends up painting in a 65px box. Asking
     * dockview to re-layout whenever the container's size settles (and once more
     * after mount) is what corrects it.
     *
     * Two things make this fiddly. The container is sampled on a later frame
     * rather than synchronously, because a resize can still be in flight —
     * `setZoomFactor` updates zoom asynchronously, and a pass taken during that
     * window records a size the page never had, which pinned the grid at 100x100
     * and collapsed every pane. And it has to keep re-asserting rather than stop
     * at the first size that looks settled: an intermediate value repeats for a
     * frame or two, and one early exit leaves the grid wrong for good.
     */
    let settleFrame = 0

    const syncLayout = (): void => {
      if (settleFrame) window.cancelAnimationFrame(settleFrame)
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = 0
        const width = host.clientWidth
        const height = host.clientHeight
        if (width === 0 || height === 0) return
        // `force` matters: without it dockview treats the size as unchanged and
        // leaves its internal grid at the placeholder it measured on mount.
        dock.layout(width, height, true)
        if (window.localStorage.getItem('tdDebug') === '1') {
          const trail = ((window as unknown as Record<string, unknown>)['__tdDockTrail'] ??=
            []) as Array<Record<string, unknown>>
          const grid = document.querySelector('.dv-grid-view')
          const group = document.querySelector('.dv-groupview')
          trail.push({
            at: Math.round(performance.now()),
            dpr: window.devicePixelRatio,
            asked: `${width}x${height}`,
            grid: grid ? `${grid.clientWidth}x${grid.clientHeight}` : null,
            group: group ? `${group.clientWidth}x${group.clientHeight}` : null
          })
          if (trail.length > 60) trail.shift()
        }
      })
    }
    // Reachable from addSession: a pane added before the dock has been measured
    // would otherwise stay glued to the placeholder size forever.
    dockSyncRef.current = syncLayout
    const dockObserver = new ResizeObserver(syncLayout)
    dockObserver.observe(host)

    /*
     * Drive the re-layout for a short window after mount.
     *
     * Verified in isolation and in the app: a DockviewComponent constructed while
     * its container is a 100x100 placeholder keeps its grid pinned at 100x100 even
     * after the container grows, and `layout(w, h, true)` is what releases it.
     * A ResizeObserver alone was not enough — on some runs the container reaches
     * its real size without a further resize event reaching the observer, so
     * nothing asks for the re-layout and every pane stays in a 100px box. Polling
     * briefly is bounded, cheap, and independent of which event arrives.
     */
    const layoutWatchdog = window.setInterval(syncLayout, 100)
    const layoutWatchdogStop = window.setTimeout(() => window.clearInterval(layoutWatchdog), 5000)
    if (window.localStorage.getItem('tdDebug') === '1') {
      ;(window as unknown as Record<string, unknown>)['__tdDockLayout'] = syncLayout
    }

    return () => {
      cancelled = true
      window.clearTimeout(saveTimer)
      if (settleFrame) window.cancelAnimationFrame(settleFrame)
      window.clearInterval(layoutWatchdog)
      window.clearTimeout(layoutWatchdogStop)
      dockObserver.disconnect()
      // Flush on teardown: the debounce window is wider than the gap between the
      // last change and app quit, so a pending save would otherwise be lost.
      if (dirty) persist()
      disposition.dispose()
      removed.dispose()
      dock.dispose()
      dockApiRef.current = null
      dockSyncRef.current = null
    }
    }
  }, [removeSessionState])

  // ---- persist the arrangement -------------------------------------------

  useEffect(() => {
    // Skip until the saved layout has been applied, otherwise the first render
    // would overwrite it with defaults.
    if (!hydratedRef.current) return
    void api.saveLayout({ page, sidebarVisible, sidebarCollapsed, snippetBarVisible })
  }, [page, sidebarVisible, sidebarCollapsed, snippetBarVisible])

  // ---- session creation ---------------------------------------------------

  const addSession = useCallback((session: SessionInfo) => {
    const dockApi = dockApiRef.current
    if (!dockApi) return

    setSessions((prev) => [...prev, session])

    // A restored pane for this saved session is still sitting there as a
    // placeholder; give it the live session instead of adding a second tab.
    const fromSaved = savedIdForSessionRef.current.get(session.id)
    const existing = fromSaved ? dockApi.getPanel(fromSaved) : undefined
    if (existing) {
      savedIdForSessionRef.current.delete(session.id)
      existing.api.updateParameters({
        session,
        disconnected: false,
        savedSessionId: undefined,
        title: session.title
      })
      refreshPanelParams(existing.id)
      existing.api.setTitle(session.title)
      existing.api.setActive()
      return
    }

    const placeholder = dockApi.getPanel('welcome')
    if (placeholder) dockApi.removePanel(placeholder)

    dockApi.addPanel({
      id: session.id,
      component: 'terminal',
      title: session.title,
      params: {
        session,
        onEnded: (id: string) => endedRef.current(id)
      }
    })

    /*
     * Re-layout until the new pane has a real size.
     *
     * dockview measures itself when the panel is added. If that happens before
     * the dock has been laid out — which is exactly what a session opened while
     * the window is still settling does — the pane keeps a 100x100 placeholder
     * and never grows, so its terminal paints in a 65px box. Retrying until the
     * panel reports a plausible width makes that self-correcting instead of
     * leaving a permanently broken pane.
     */
    let attempts = 0
    const settle = (): void => {
      dockSyncRef.current?.()
      const panel = dockApi.getPanel(session.id)
      const wide = panel ? panel.api.width : 0
      if (attempts++ < 20 && wide < 200 && dockSyncRef.current) {
        window.setTimeout(settle, 60)
      }
    }
    settle()
  }, [])

  /**
   * Save a session that was created by a quick connect.
   *
   * Connections made from the quick-connect drawer are no longer anonymous: they
   * land in Sessions as an unfiled entry (no folder), with the credential the
   * user typed stored in the same encrypted vault as any other session.
   *
   * Skipped when a session for the same user@host:port already exists, so
   * reconnecting repeatedly does not litter the tree.
   */
  const autoSaveQuickConnect = useCallback(
    async (session: SessionInfo, payload: SshConnectPayload) => {
      if (payload.savedSessionId) return
      const already = treeRef.current.sessions.some(
        (s) =>
          s.host === payload.host &&
          (s.port ?? 22) === (payload.port ?? 22) &&
          s.username === payload.username
      )
      if (already) return

      const label = payload.title?.trim() || `${payload.username}@${payload.host}`
      try {
        await api.saveSession({
          name: label,
          host: payload.host,
          port: payload.port ?? 22,
          username: payload.username,
          authMethod: payload.auth.useAgent
            ? 'agent'
            : payload.auth.privateKeyPath
              ? 'key'
              : 'password',
          privateKeyPath: payload.auth.privateKeyPath,
          tags: [],
          // No folder: unfiled sessions sit directly in the Sessions list.
          parentId: null,
          // Saves the password in the encrypted credential store, so the next
          // connect needs no prompt at all.
          credential:
            payload.auth.password || payload.auth.passphrase
              ? { password: payload.auth.password, passphrase: payload.auth.passphrase }
              : undefined
        })
        log('info', `Saved ${label} to Sessions`)
        setToast(`Saved ${label} to Sessions`)
      } catch (err) {
        // A failure to save must not make a working connection look broken.
        log('warn', `Could not save ${label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [log]
  )

  /** Applies a connection result, surfacing host-key decisions to the user. */
  const handleResult = useCallback(
    (result: CreateSessionResult, payload: SshConnectPayload) => {
      setConnectingId(null)

      if (result.ok) {
        addSession(result.session)
        void autoSaveQuickConnect(result.session, payload)
        setDialogOpen(false)
        setConnectError(null)
        setAlert(null)
        return
      }

      const { error } = result
      if (error.code === 'HOST_KEY_REQUIRED' && error.prompt) {
        // The prompt carries the exact key that was presented, so approving it
        // records precisely what the user was shown.
        setHostKeyRequest({
          prompt: error.prompt,
          payload,
          keyType: error.prompt.keyType,
          keyData: error.prompt.keyData ?? ''
        })
        setDialogOpen(false)
        return
      }

      // Ask for the password in place rather than telling the user to go and
      // edit the session: this is the common case for a new saved session.
      const savedSession = payload.savedSessionId
        ? treeRef.current.sessions.find((s) => s.id === payload.savedSessionId)
        : undefined
      if (error.code === 'CREDENTIAL_REQUIRED' && savedSession) {
        setAlert(null)
        setPasswordPrompt({ session: savedSession, reason: error.message })
        setDialogOpen(false)
        return
      }

      // A failure that did not come from the dialog must be visible: previously
      // it was only stored in `connectError`, which only the dialog renders, so
      // connecting from the sidebar failed silently.
      if (dialogOpen) setConnectError(error.message)
      else
        setAlert({
          message: error.message,
          code: error.code,
          // Remember which session failed so the alert can offer a retry that
          // collects the password.
          sessionId: payload.savedSessionId
        })
    },
    [addSession, dialogOpen]
  )

  const connectSaved = useCallback(
    async (session: SavedSession, password?: string) => {
      const payload: SshConnectPayload = {
        host: session.host,
        port: session.port,
        username: session.username,
        title: session.name,
        // Credentials for a saved session are read by the main process from the
        // encrypted store; an explicit password here is a one-off typed by the
        // user in the connect prompt and takes precedence.
        savedSessionId: session.id,
        auth:
          session.authMethod === 'agent'
            ? { useAgent: true }
            : session.authMethod === 'key'
              ? { privateKeyPath: session.privateKeyPath }
              : password !== undefined
                ? { password }
                : {}
      }

      setAlert(null)
      setConnectingId(session.id)
      try {
        const result = await api.createSshSession(payload)
        // Remember where this session came from so addSession can reuse the
        // placeholder pane the restored layout created for it.
        if (result.ok) savedIdForSessionRef.current.set(result.session.id, session.id)
        handleResult(result, payload)
      } catch (err) {
        // A transport-level rejection would otherwise leave the row spinning.
        setConnectingId(null)
        setAlert({ message: err instanceof Error ? err.message : String(err) })
      }
    },
    [handleResult]
  )

  /**
   * Lets a restored pane reconnect. The pane is keyed by the id of the saved
   * session it was created for; once connected, addSession adopts that pane
   * instead of opening a second tab.
   *
   * Registered through a ref because the dockview factory is created once and
   * cannot see later renders.
   */
  useEffect(() => {
    connectSavedRef.current = connectSaved
    reconnectRef.current = (savedSessionId, title) => {
      const saved = treeRef.current.sessions.find((s) => s.id === savedSessionId)
      if (!saved) {
        setAlert({
          message: `“${title}” is no longer saved, so this pane cannot be restored. Close it, or save the session again.`
        })
        return
      }
      void connectSavedRef.current(saved)
    }
  }, [connectSaved])

  // Broadcast mode lives outside React so terminal input handlers see the current
  // value; this keeps the button in step with it.
  useEffect(() => onBroadcastChange(setBroadcasting), [])

  // ---- tree mutations -----------------------------------------------------

  /**
   * Mutations only need to report failures: the main process broadcasts the new
   * tree, and the subscription above applies it. Refreshing here as well would
   * just duplicate that work.
   */
  const move = useCallback(async (payload: DragPayload, parentId: string | null) => {
    try {
      if (payload.kind === 'session') await api.moveSession(payload.id, parentId)
      else await api.moveFolder(payload.id, parentId)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const createFolder = useCallback(async (parentId: string | null) => {
    try {
      await api.saveFolder({ name: 'New folder', parentId })
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Connect with a password typed in the prompt, optionally remembering it. */
  const submitPassword = useCallback(
    async (password: string, remember: boolean) => {
      const request = passwordPrompt
      if (!request) return
      setPromptBusy(true)
      try {
        if (remember) {
          await api.saveSession({
            id: request.session.id,
            host: request.session.host,
            credential: { password }
          })
        }
        setPasswordPrompt(null)
        await connectSaved(request.session, password)
      } catch (err) {
        setAlert({ message: err instanceof Error ? err.message : String(err) })
      } finally {
        setPromptBusy(false)
      }
    },
    [connectSaved, passwordPrompt]
  )

  /** Sessions that use password auth are the ones a prompt can help. */
  const promptableSession = useCallback((sessionId: string | undefined): SavedSession | null => {
    if (!sessionId) return null
    const session = treeRef.current.sessions.find((s) => s.id === sessionId)
    return session && session.authMethod === 'password' ? session : null
  }, [])

  // ---- snippets -----------------------------------------------------------
  /** The panel that should receive typed input, or null when none is open. */
  const activeTerminalId = useCallback((): string | null => {
    const active = dockApiRef.current?.activePanel
    return active && active.id !== 'welcome' ? active.id : null
  }, [])

  const sendSnippet = useCallback(
    (snippet: Snippet) => {
      const sessionId = activeTerminalId()
      if (!sessionId) {
        setAlert({
          message: `Cannot run “${snippet.label}”: no active terminal. Connect to a host first.`
        })
        return
      }
      // Sent verbatim. Whether the shell executes it is decided by the newline
      // the user did or did not include — never added on their behalf.
      api.writeSession(sessionId, snippet.command)
    },
    [activeTerminalId]
  )

  const saveSnippet = useCallback(
    async (input: Partial<Snippet> & { label: string; command: string }) => {
      try {
        const next = await api.saveSnippet(input)
        setSettings(next)
        setSnippetEditor(null)
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

  const deleteSnippet = useCallback(async (id: string) => {
    try {
      setSettings(await api.deleteSnippet(id))
      setSnippetEditor(null)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const duplicateSession = useCallback(async (session: SavedSession) => {
    try {
      await api.saveSession({
        name: `${session.name} copy`,
        host: session.host,
        port: session.port,
        username: session.username,
        authMethod: session.authMethod,
        privateKeyPath: session.privateKeyPath,
        tags: session.tags,
        notes: session.notes,
        parentId: session.parentId,
        // Ask the main process to duplicate the stored secret too, so the copy
        // can actually connect without retyping the password.
        copyCredentialFrom: session.id
      })
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // ---- context menu -------------------------------------------------------

  const contextMenuItems = useCallback(
    (menu: ContextMenuState): MenuItem[] => {
      if (menu.target.kind === 'session') {
        const { session } = menu.target
        return [
          { id: 'connect', label: 'Connect' },
          { id: 'edit', label: 'Edit…' },
          { id: 'duplicate', label: 'Duplicate' },
          { id: 'copyHost', label: 'Copy host', separatorBefore: true },
          { id: 'delete', label: 'Delete', danger: true, separatorBefore: true }
        ]
      }
      if (menu.target.kind === 'folder') {
        return [
          { id: 'newSessionHere', label: 'New session here' },
          { id: 'newFolderHere', label: 'New subfolder' },
          { id: 'renameFolder', label: 'Rename…', separatorBefore: true },
          { id: 'deleteFolder', label: 'Delete folder', danger: true, separatorBefore: true }
        ]
      }
      return [
        { id: 'newFolderRoot', label: 'New folder' },
        { id: 'newSessionRoot', label: 'New session' }
      ]
    },
    []
  )

  const runContextAction = useCallback(
    (menu: ContextMenuState, actionId: string) => {
      const target = menu.target
      if (target.kind === 'session') {
        const { session } = target
        if (actionId === 'connect') void connectSaved(session)
        else if (actionId === 'edit') openEditor(session, session.parentId)
        else if (actionId === 'duplicate') void duplicateSession(session)
        else if (actionId === 'copyHost')
          void api.copyToClipboard(`${session.username}@${session.host}:${session.port}`)
        else if (actionId === 'delete') void api.deleteSession(session.id)
        return
      }

      if (target.kind === 'folder') {
        const { folder } = target
        if (actionId === 'newSessionHere') openEditor(null, folder.id)
        else if (actionId === 'newFolderHere') void createFolder(folder.id)
        else if (actionId === 'renameFolder') {
          const name = window.prompt('Folder name', folder.name)
          if (name && name.trim()) void api.saveFolder({ id: folder.id, name: name.trim() })
        } else if (actionId === 'deleteFolder') void api.deleteFolder(folder.id)
        return
      }

      if (actionId === 'newFolderRoot') void createFolder(null)
      else if (actionId === 'newSessionRoot') openEditor(null, null)
    },
    [connectSaved, createFolder, duplicateSession, openEditor]
  )

  // ---- pane output --------------------------------------------------------

  /** Copy a pane's whole scrollback, not just what is on screen. */
  const copyPanelOutput = useCallback(
    async (panelId: string, title: string) => {
      const text = readScrollback(panelId)
      if (text === null) {
        setToast(`No terminal output for “${title}”`)
        return
      }
      try {
        await api.copyToClipboard(text)
        setToast(`Copied ${text.split('\n').length} lines from “${title}”`)
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

  /** Write a pane's whole scrollback to a text file the user picks. */
  const savePanelOutput = useCallback(
    async (panelId: string, title: string) => {
      const text = readScrollback(panelId)
      if (text === null) {
        setToast(`No terminal output for “${title}”`)
        return
      }
      try {
        // A readable default name: the pane title with anything awkward for a
        // filesystem replaced.
        const safe = title.replace(/[^\w.@-]+/g, '_').replace(/^_+|_+$/g, '') || 'terminal'
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const result = await api.saveTextFile({
          suggestedName: `${safe}-${stamp}.txt`,
          content: text
        })
        if (result.ok) {
          log('info', `Saved output of ${title} to ${result.path}`)
          setToast(`Saved to ${result.path}`)
        } else if (!result.cancelled) {
          setToast(`Could not save: ${result.message}`)
        }
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err))
      }
    },
    [log]
  )

  // ---- tab context menu ---------------------------------------------------

  /**
   * Resolve a right-click on a pane tab.
   *
   * dockview has no tab context-menu event, but each tab element carries
   * `data-tab-panel-id`, which is exactly the panel id we need.
   */
  const onDockContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    const tab = target.closest('[data-tab-panel-id]')
    if (!tab) return
    const panelId = tab.getAttribute('data-tab-panel-id')
    if (!panelId) return
    const panel = dockApiRef.current?.getPanel(panelId)
    if (!panel) return
    e.preventDefault()
    e.stopPropagation()
    setTabMenu({ x: e.clientX, y: e.clientY, panelId, title: panel.title || 'Session' })
  }, [])

  /** Close every tab in a group except the ones to keep. */
  const closePanels = useCallback(
    (ids: string[]) => {
      const dockApi = dockApiRef.current
      if (!dockApi) return
      for (const id of ids) {
        if (id === 'welcome') continue
        closeSession(id)
      }
    },
    [closeSession]
  )

  const tabMenuItems = useMemo((): MenuItem[] => {
    if (!tabMenu) return []
    const dockApi = dockApiRef.current
    const panel = dockApi?.getPanel(tabMenu.panelId)
    const group = panel?.group
    const panels = group ? group.panels : []
    const index = panels.findIndex((p) => p.id === tabMenu.panelId)
    const closable = panels.filter((p) => p.id !== 'welcome')

    return [
      { id: 'copyTitle', label: 'Copy tab name' },
      { id: 'copyText', label: 'Copy all output' },
      { id: 'saveText', label: 'Save output to file…' },
      {
        id: 'toggleTimestamps',
        label: settings.terminal.showTimestamps ? 'Hide timestamps' : 'Show timestamps',
        hint: settings.terminal.showTimestamps ? 'on' : 'off',
        separatorBefore: true
      },
      { id: 'close', label: 'Close', separatorBefore: true, disabled: closable.length === 0 },
      {
        id: 'closeOthers',
        label: 'Close other tabs',
        disabled: closable.filter((p) => p.id !== tabMenu.panelId).length === 0
      },
      {
        id: 'closeRight',
        label: 'Close tabs to the right',
        disabled: index < 0 || index >= panels.length - 1
      },
      { id: 'closeAll', label: 'Close all tabs', danger: true, separatorBefore: true }
    ]
  }, [tabMenu, settings.terminal.showTimestamps])

  const runTabAction = useCallback(
    (actionId: string) => {
      if (!tabMenu) return
      const dockApi = dockApiRef.current
      const panel = dockApi?.getPanel(tabMenu.panelId)
      const group = panel?.group
      const panels = group ? group.panels : []
      const index = panels.findIndex((p) => p.id === tabMenu.panelId)

      if (actionId === 'copyTitle') {
        void api.copyToClipboard(tabMenu.title)
        setToast(`Copied “${tabMenu.title}”`)
        return
      }
      if (actionId === 'toggleTimestamps') {
        // Saved immediately so the choice survives a restart; the broadcast then
        // updates every open pane through useSettings.
        const next = !settings.terminal.showTimestamps
        void api
          .saveSettings({
            ...settings,
            terminal: { ...settings.terminal, showTimestamps: next }
          })
          .then(setSettings)
        setToast(next ? 'Timestamps shown' : 'Timestamps hidden')
        return
      }
      if (actionId === 'copyText') {
        void copyPanelOutput(tabMenu.panelId, tabMenu.title)
        return
      }
      if (actionId === 'saveText') {
        void savePanelOutput(tabMenu.panelId, tabMenu.title)
        return
      }
      if (actionId === 'close') closePanels([tabMenu.panelId])
      else if (actionId === 'closeOthers') {
        closePanels(panels.filter((p) => p.id !== tabMenu.panelId).map((p) => p.id))
      } else if (actionId === 'closeRight') {
        closePanels(panels.slice(index + 1).map((p) => p.id))
      } else if (actionId === 'closeAll') {
        closePanels(panels.map((p) => p.id))
      }
    },
    [tabMenu, closePanels, copyPanelOutput, savePanelOutput, settings]
  )

  // ---- shortcuts ----------------------------------------------------------

  const cycleTab = useCallback((delta: number) => {
    const dockApi = dockApiRef.current
    if (!dockApi) return
    const group = dockApi.activeGroup
    if (!group) return
    const panels = group.panels
    if (panels.length < 2) return
    const index = panels.findIndex((p) => p.id === dockApi.activePanel?.id)
    const next = panels[(index + delta + panels.length) % panels.length]
    next?.api.setActive()
  }, [])

  useShortcuts(settings.keybindings, {
    newConnection: () => setDialogOpen(true),
    closeSession: () => {
      const active = dockApiRef.current?.activePanel
      if (active && active.id !== 'welcome') closeSession(active.id)
    },
    openSettings: () => setSettingsOpen(true),    toggleSidebar: () => setSidebarVisible((v) => !v),
    openConnections: () => setConnectionsOpen(true),
    toggleSnippets: () => setSnippetBarVisible((v) => !v),
    toggleBroadcast: () => setBroadcasting(toggleBroadcasting()),
    copy: () => {
      const active = dockApiRef.current?.activePanel
      if (!active) return
      // The terminal writes its own selection on change; Ctrl+Shift+C re-copies
      // from the window selection as a fallback.
      const text = window.getSelection()?.toString()
      if (text) void api.copyToClipboard(text)
    },
    paste: () => {
      void api.readClipboard().then((text) => {
        const active = dockApiRef.current?.activePanel
        if (active && text) api.writeSession(active.id, text)
      })
    },
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1)
  })

  const platformLabel = useMemo(
    () => (appMeta ? `${appMeta.platform} · Electron ${appMeta.versions.electron}` : ''),
    [appMeta]
  )

  return (
    <div className="td-root">
      <NavRail
        active={page}
        onSelect={(next) => {
          // Settings is drawer-only: it has no page of its own, so selecting it
          // opens the drawer over whatever page is showing.
          if (next === 'settings') {
            setSettingsOpen(true)
            return
          }
          setSettingsOpen(false)
          setPage(next)
          // The terminal page is the only one that wants the session list.
          if (next === 'terminal') setSidebarVisible(true)
        }}
        badges={{ terminal: sessions.length }}
        appInfo={appMeta}
        settingsOpen={settingsOpen}
      />

      {page === 'known-hosts' && <KnownHostsPage />}

      {page === 'snippets' && (
        <SnippetsPage
          snippets={settings.snippets}
          canSend={activeTerminalId() !== null}
          onSend={sendSnippet}
          onEdit={(snippet) => setSnippetEditor({ snippet, group: snippet.group })}
          onNew={(group) => setSnippetEditor({ snippet: null, group })}
          onDelete={(id) => void deleteSnippet(id)}
          onReorder={(ids) => void api.reorderSnippets(ids).then(setSettings)}
        />
      )}

      {page === 'logs' && <LogsPage entries={logEntries} onClear={() => setLogEntries([])} />}

      {page === 'hosts' && (
        <HostsPage
          tree={tree}
          sessions={sessions}
          knownTags={knownTags}
          onConnect={(s) => void connectSaved(s)}
          onEdit={(s) => openEditor(s, s.parentId)}
        />
      )}

      {sidebarVisible && sidebarCollapsed && (
        <aside className="td-sidebar is-collapsed" data-testid="sidebar-collapsed">
          <button
            className="td-icon-btn"
            title="Expand the sidebar"
            data-testid="sidebar-expand"
            onClick={() => setSidebarCollapsed(false)}
          >
            »
          </button>
          <button
            className="td-icon-btn td-icon-btn-accent"
            title="New connection"
            data-testid="collapsed-connect"
            onClick={() => setDialogOpen(true)}
          >
            +
          </button>
          <button
            className="td-icon-btn"
            title="Open a local shell"
            data-testid="collapsed-local"
            disabled={!appMeta?.localShellAvailable}
            onClick={() =>
              void api.createLocalSession({}).then((r) => {
                if (r.ok) addSession(r.session)
                else setAlert({ message: r.error.message })
              })
            }
          >
            &gt;_
          </button>
          <button
            className={`td-icon-btn${broadcasting ? ' is-active' : ''}`}
            title={broadcasting ? `Broadcasting — ${broadcastSummary()}` : 'Broadcast input'}
            aria-pressed={broadcasting}
            onClick={() => setBroadcasting(toggleBroadcasting())}
          >
            ⇶
          </button>
          <span className="td-collapsed-spacer" />
          <button
            className="td-icon-btn"
            title={`Open sessions (${sessions.length})`}
            onClick={() => setConnectionsOpen(true)}
          >
            ⧉
            {sessions.length > 0 && <span className="td-badge">{sessions.length}</span>}
          </button>
          <button
            className="td-icon-btn"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </aside>
      )}

      {sidebarVisible && !sidebarCollapsed && (
        <aside className="td-sidebar">
          <div className="td-brand">
            <span className="td-brand-mark">▚</span>
            <span className="td-brand-name">TermDeck</span>
            <span className="td-spacer" />
            <button
              className="td-icon-btn"
              title="Collapse the sidebar to a slim strip"
              data-testid="sidebar-collapse"
              onClick={() => setSidebarCollapsed(true)}
            >
              «
            </button>
          </div>

          <div className="td-sidebar-actions">
            <button className="td-btn td-btn-primary" onClick={() => setDialogOpen(true)}>
              + Connect
            </button>
            <button
              className="td-btn"
              onClick={() =>
                void api.createLocalSession({}).then((r) => {
                  if (r.ok) addSession(r.session)
                  else setAlert({ message: r.error.message })
                })
              }
              disabled={!appMeta?.localShellAvailable}
              title={
                appMeta && !appMeta.localShellAvailable
                  ? 'Local shell needs @lydell/node-pty for this platform'
                  : 'Open a local shell'
              }
            >
              Local shell
            </button>
          </div>

          <SessionTree
            tree={tree}
            activeSessionId={dockApiRef.current?.activePanel?.id ?? null}
            selectedSavedId={selectedSavedId}
            connectingId={connectingId}
            tagFilter={tagFilter}
            availableTags={knownTags}
            onSelectSession={(s) => setSelectedSavedId(s.id)}
            onOpenSession={(s) => void connectSaved(s)}
            onEditSession={(s) => openEditor(s, s.parentId)}
            onDeleteSession={(id) => void api.deleteSession(id)}
            onDuplicateSession={(s) => void duplicateSession(s)}
            onNewSession={() => openEditor(null, null)}
            onContextMenu={setContextMenu}
            onCreateFolder={(parentId) => void createFolder(parentId)}
            onRenameFolder={(id, name) => void api.saveFolder({ id, name })}
            onDeleteFolder={(id) => void api.deleteFolder(id)}
            onToggleFolder={(id, expanded) =>
              void api.saveFolder({ id, name: folderName(tree, id), expanded })
            }
            onMove={(payload, parentId) => void move(payload, parentId)}
            onToggleTag={(tag) =>
              setTagFilter((prev) =>
                prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
              )
            }
          />

          <div className="td-sidebar-section">Open sessions</div>
          <ul className="td-session-list">
            {sessions.length === 0 && (
              <li className="td-session-empty">
                None yet — double-click a saved session to connect.
              </li>
            )}
            {sessions.map((s) => (
              <li key={s.id} className="td-session-item">
                <button
                  className="td-session-open"
                  onClick={() => dockApiRef.current?.getPanel(s.id)?.api.setActive()}
                >
                  <span className={`td-dot td-dot-${s.kind}`} />
                  <span className="td-session-title" title={s.title}>
                    {s.title}
                  </span>
                </button>
                <button
                  className="td-session-close"
                  title="Close session"
                  onClick={() => closeSession(s.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="td-sidebar-footer">
            <button
              className="td-icon-btn"
              title="Connections window"
              data-testid="open-connections"
              onClick={() => setConnectionsOpen(true)}
            >
              ⧉
              {sessions.length > 0 && <span className="td-badge">{sessions.length}</span>}
            </button>
            <button
              className="td-icon-btn"
              title="Snippet bar"
              data-testid="toggle-snippets"
              onClick={() => setSnippetBarVisible((v) => !v)}
            >
              ⌨
            </button>
            <button
              className={`td-icon-btn${broadcasting ? ' is-active' : ''}`}
              title={
                broadcasting
                  ? `Broadcasting — ${broadcastSummary()}. Click to send to the focused pane only.`
                  : 'Broadcast input: send typing to every open session at once'
              }
              data-testid="toggle-broadcast"
              aria-pressed={broadcasting}
              onClick={() => setBroadcasting(toggleBroadcasting())}
            >
              ⇶
            </button>
            <button
              className="td-icon-btn"
              title="Settings"
              data-testid="open-settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
            <span>{platformLabel}</span>
          </div>
        </aside>
      )}

      {/*
        The workspace stays mounted on every page and is only hidden when another
        rail section is showing. Rendering it conditionally unmounted the
        container, which disposed the docking component; a session connected
        while another page was open then created its panel inside a detached
        container, so it appeared under "Open sessions" but never painted.
      */}
      <div className={'td-content' + (page === 'terminal' ? '' : ' is-hidden')}>
        <main className="td-main">
          <div
            className="td-dockview dockview-theme-abyss"
            ref={dockRef}
            onContextMenu={onDockContextMenu}
          />
        </main>

        {/* Bottom bar of saved commands; hidden until the user shows it again. */}
        {snippetBarVisible && (
          <SnippetBar
            snippets={settings.snippets}
            canSend={activeTerminalId() !== null}
            onSend={sendSnippet}
            onEdit={(snippet) => setSnippetEditor({ snippet, group: snippet.group })}
            onNew={(group) => setSnippetEditor({ snippet: null, group })}
            onDelete={(id) => void deleteSnippet(id)}
            onHide={() => setSnippetBarVisible(false)}
          />
        )}

        {!snippetBarVisible && (
          <button
            className="td-snippet-restore"
            title="Show snippet bar"
            onClick={() => setSnippetBarVisible(true)}
          >
            ⌃
          </button>
        )}
      </div>

      {dialogOpen && (
        <ConnectionDialog
          error={connectError}
          onCancel={() => {
            setDialogOpen(false)
            setConnectError(null)
          }}
          onResult={handleResult}
          onSaveAsSession={(payload) => {
            setDialogOpen(false)
            // Prefill the editor from the quick-connect form; the password the
            // user typed is carried through so saving it is one click.
            setEditorSession({
              id: '',
              name: `${payload.username}@${payload.host}`,
              host: payload.host,
              port: payload.port ?? 22,
              username: payload.username,
              authMethod: payload.auth.useAgent
                ? 'agent'
                : payload.auth.privateKeyPath
                  ? 'key'
                  : 'password',
              privateKeyPath: payload.auth.privateKeyPath,
              tags: [],
              parentId: null,
              createdAt: Date.now(),
              updatedAt: Date.now()
            } as SavedSession)
            setPrefillCredential({
              password: payload.auth.password,
              passphrase: payload.auth.passphrase
            })
            setEditorParentId(null)
            setEditorOpen(true)
          }}
        />
      )}

      {editorOpen && (
        <Drawer
          open
          size="md"
          title={editorSession && editorSession.id ? 'Edit session' : 'New session'}
          testId="session-drawer"
          onClose={() => {
            setEditorOpen(false)
            setPrefillCredential(undefined)
          }}
        >
          <SessionEditor
            session={editorSession && editorSession.id ? editorSession : null}
            defaultParentId={editorParentId}
            folders={tree.folders}
            knownTags={knownTags}
            prefill={prefillCredential}
            onCancel={() => {
              setEditorOpen(false)
              setPrefillCredential(undefined)
            }}
            onSaved={() => {
              setEditorOpen(false)
              setPrefillCredential(undefined)
              void refreshCredentials()
              log('info', `Saved session ${editorSession?.name ?? ''}`.trim())
            }}
            onDeleted={() => {
              setEditorOpen(false)
              setPrefillCredential(undefined)
              void refreshCredentials()
              log('warn', `Deleted session ${editorSession?.name ?? ''}`.trim())
            }}
          />
        </Drawer>
      )}

      <Drawer
        open={settingsOpen}
        size="lg"
        title="Settings"
        testId="settings-drawer"
        onClose={() => {
          setSettingsOpen(false)
          void refreshCredentials()
        }}
      >
        <SettingsDialog
          settings={settings}
          credentialStatus={credentialStatus}
          onApplyScale={applyUiScale}
          onClose={() => {
            setSettingsOpen(false)
            void refreshCredentials()
          }}
          onSaved={setSettings}
          onCredentialChanged={(status) => {
            setCredentialStatus(status)
            void refreshCredentials()
          }}
        />
      </Drawer>

      {hostKeyRequest && (
        <HostKeyDialog
          prompt={hostKeyRequest.prompt}
          onCancel={() => setHostKeyRequest(null)}
          onTrust={() => {
            const request = hostKeyRequest
            setHostKeyRequest(null)
            void api
              .trustHostKey({
                host: request.prompt.host,
                port: request.prompt.port,
                keyType: request.keyType,
                keyData: request.keyData
              })
              .then(() => api.createSshSession({ ...request.payload, hostKeyPolicy: 'ask' }))
              .then((result) => handleResult(result, request.payload))
              .catch((err) =>
                setConnectError(err instanceof Error ? err.message : String(err))
              )
          }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu)}
          onSelect={(actionId) => runContextAction(contextMenu, actionId)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          testId="tab-menu"
          onSelect={runTabAction}
          onClose={() => setTabMenu(null)}
        />
      )}

      {connectionsOpen && (
        <Drawer
          open
          size="xl"
          title="Connections"
          testId="connections-drawer"
          onClose={() => setConnectionsOpen(false)}
        >
          <ConnectionsWindow
            sessions={sessions}
            activeSessionId={dockApiRef.current?.activePanel?.id ?? null}
            onFocus={(id) => {
              dockApiRef.current?.getPanel(id)?.api.setActive()
              setConnectionsOpen(false)
            }}
            onCloseSession={(id) => closeSession(id)}
            onDismiss={() => setConnectionsOpen(false)}
            embedded
          />
        </Drawer>
      )}

      {snippetEditor && (
        <SnippetEditor
          snippet={snippetEditor.snippet}
          defaultGroup={snippetEditor.group}
          groups={[...new Set(settings.snippets.map((s) => s.group || 'Ungrouped'))]}
          onCancel={() => setSnippetEditor(null)}
          onSaved={(input) => void saveSnippet(input)}
          onDeleted={(id) => void deleteSnippet(id)}
        />
      )}

      {/* Connection failures from outside the dialog have nowhere else to show. */}
      {alert && (
        <div className="td-alert" role="alert" data-testid="connect-alert">
          <div className="td-alert-body">
            <strong>Connection failed</strong>
            <p>{alert.message}</p>
          </div>
          <div className="td-alert-actions">
            {/* Offer the fix, not just the diagnosis. */}
            {promptableSession(alert.sessionId) && (
              <button
                className="td-btn td-btn-sm td-btn-primary"
                data-testid="alert-enter-password"
                onClick={() => {
                  const session = promptableSession(alert.sessionId)
                  setAlert(null)
                  if (session) setPasswordPrompt({ session, retry: true, reason: alert.message })
                }}
              >
                Enter password
              </button>
            )}
            <button className="td-btn td-btn-sm" onClick={() => setAlert(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {passwordPrompt && (
        <PasswordPrompt
          session={passwordPrompt.session}
          reason={passwordPrompt.reason}
          retry={passwordPrompt.retry}
          busy={promptBusy}
          onCancel={() => setPasswordPrompt(null)}
          onSubmit={({ password, remember }) => void submitPassword(password, remember)}
        />
      )}

      {toast && (
        <div className="td-toast" onMouseDown={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}

function folderName(tree: Tree, id: string): string {
  return tree.folders.find((f) => f.id === id)?.name ?? ''
}
