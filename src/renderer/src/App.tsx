import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { DockviewComponent, type DockviewApi, type GroupPanelPartInitParameters } from 'dockview'

import {
  DEFAULT_SETTINGS,
  SIDEBAR_SECTION_LABELS,
  stepScale,
  type AppSettings,
  type CreateSessionResult,
  type CredentialStatus,
  type HistoryEntry,
  type HistorySessionSummary,
  type HostKeyPrompt,
  type HostsView,
  type LayoutState,
  type LockStatus,
  type QuitRequest,
  type SavedSession,
  type SessionFolder,
  type SessionInfo,
  type SessionTree as Tree,
  type SidebarSectionId,
  type SidebarSide,
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
import { QuitConfirmDialog } from './components/QuitConfirmDialog'
import { BreakBar } from './components/BreakBar'
import { WellnessChip } from './components/WellnessChip'
import { LockScreen } from './components/LockScreen'
import { HistoryPanel, SectionFrame, SftpPanel } from './components/DrawerSections'
import { SnippetBar } from './components/SnippetBar'
import { SnippetEditor } from './components/SnippetEditor'
import { KnownHostsPage } from './components/KnownHostsPage'
import { SnippetsPage } from './components/SnippetsPage'
import { LogsPage, type LogEntry } from './components/LogsPage'
import { HostsPage } from './components/HostsPage'
import { Drawer } from './components/Drawer'
import { NamePrompt } from './components/NamePrompt'
import { ConfirmDialog } from './components/ConfirmDialog'
import { TileDialog } from './components/TileDialog'
import { tilePanels, type TileMode } from './components/tile'
import { WelcomeScreen } from './components/WelcomeScreen'
import { ShareDialog } from './components/ShareDialog'
import { NavRail, type PageId } from './components/NavRail'
import { getTerminal, readScrollback, setFitsPaused } from './components/terminalRegistry'
import {
  broadcastSummary,
  isBroadcasting,
  onBroadcastChange,
  setVisibleSessions,
  sinkIds,
  toggleBroadcasting,
  writesBySink
} from './components/broadcast'
import { useShortcuts, matchesBinding } from './components/useShortcuts'
import { refitAll } from './components/terminalRegistry'
import { useTheme } from './components/useTheme'
import { onLanguageChange, setLanguage, t } from './i18n'

const api = window.termdeck

/**
 * How long a toast stays before it dismisses itself.
 *
 * Long enough to read a short sentence, short enough that it is gone before the
 * next action — the state it reports is usually visible in the window anyway.
 */
const TOAST_MS = 1200

/** Terminal font size, matching the range the settings control offers. */
const FONT_SIZE_MIN = 8
const FONT_SIZE_MAX = 32

/**
 * What the wellness bar is saying.
 *
 * `reminder` is the plain nudge; `break` and `work` are the two halves of a
 * pomodoro round ("break is running", "break is over, back to it").
 */
interface BreakBarState {
  kind: 'reminder' | 'break' | 'work'
  minutes: number
}

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
   * The active language, published to the module the strings come from.
   *
   * Applied from an effect rather than during render, and re-rendered on any
   * change: the settings dialog previews a language imperatively (the same way it
   * previews a theme), so an unconditional `setLanguage(saved)` on every render
   * would immediately undo the preview. This way the stored value is written when
   * it *changes*, and everything else — the preview, the revert — flows through the
   * subscription and redraws the whole shell.
   */
  useEffect(() => setLanguage(settings.language), [settings.language])
  const [, forceLanguageRender] = useState(0)
  useEffect(() => onLanguageChange(() => forceLanguageRender((n) => n + 1)), [])

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
  /**
   * Re-arm the docking geometry watchdog.
   *
   * Set by the dockview bootstrap. A zoom change is the one thing that can move
   * the container's CSS size without a resize event reaching dockview, so the
   * watchdog has to be restarted after every one of them.
   */
  const rearmLayoutRef = useRef<() => void>(() => {})
  const applyUiScale = useCallback((scale: number): void => {
    const sync = (): void => {
      // Two frames: one for the zoom to be applied, one for the viewport to
      // settle at the new size before dockview is asked to re-measure.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          rearmLayoutRef.current()
          dockSyncRef.current?.()
        })
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

  /**
   * True while something is being dragged or animated that resizes the workspace.
   *
   * Panes re-measure on a size change, and re-measuring means reflowing xterm and
   * telling the main process to resize the pty. That is right for a window resize
   * and wrong for the thirty frames of a sash drag — so the fits wait for the
   * gesture to end, and then every pane measures once. See `setFitsPaused`.
   */
  const [layoutGesture, setLayoutGesture] = useState(false)

  /*
   * Watch for the gestures that resize the workspace and hold the pane fits
   * while they run.
   *
   * Three different things move a pane's box without a window resize, and all
   * three used to end up in the fit loop on every frame:
   *   - dragging a sash between panes or between groups,
   *   - dragging a panel tab to re-dock it,
   *   - and the rail's own collapse, which animates its width and so squeezes
   *     every pane beside it (caught by the transition hooks rather than by
   *     wrapping each of the three places that toggle the rail).
   *
   * The listeners are capture-phase so nothing inside the layout can stop them.
   */
  useEffect(() => {
    const isSplitter = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      return !!el?.closest?.('[class*="dv-sash"], .dv-resize-handle, .dv-resize-container')
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (isSplitter(event.target)) setLayoutGesture(true)
    }
    const onDragStart = (event: DragEvent): void => {
      // dockview's tabs are HTML5-draggable; that drag re-docks the whole panel.
      const el = event.target as HTMLElement | null
      if (el?.closest?.('.dv-tab')) setLayoutGesture(true)
    }
    const onRailTransition = (event: TransitionEvent): void => {
      const el = event.target as HTMLElement | null
      if (event.propertyName !== 'width' || !el?.classList?.contains('td-rail')) return
      setLayoutGesture(event.type !== 'transitionend' && event.type !== 'transitioncancel')
    }
    const endPointer = (): void => setLayoutGesture(false)

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('dragstart', onDragStart, true)
    window.addEventListener('pointerup', endPointer, true)
    // A drag the browser cancels (the pointer left the window, a touch was
    // interrupted) never delivers pointerup, and a gesture that never ends would
    // leave every pane frozen at the size it had mid-drag.
    window.addEventListener('pointercancel', endPointer, true)
    window.addEventListener('dragend', endPointer, true)
    window.addEventListener('transitionrun', onRailTransition, true)
    window.addEventListener('transitionend', onRailTransition, true)
    window.addEventListener('transitioncancel', onRailTransition, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('dragstart', onDragStart, true)
      window.removeEventListener('pointerup', endPointer, true)
      window.removeEventListener('pointercancel', endPointer, true)
      window.removeEventListener('dragend', endPointer, true)
      window.removeEventListener('transitionrun', onRailTransition, true)
      window.removeEventListener('transitionend', onRailTransition, true)
      window.removeEventListener('transitioncancel', onRailTransition, true)
      // Never leave the panes frozen because the shell went away mid-gesture.
      setFitsPaused(false)
    }
  }, [])

  useEffect(() => {
    setFitsPaused(layoutGesture)
  }, [layoutGesture])
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
  /**
   * The rail's list drawer is hidden and only icons remain.
   *
   * The rail and its list are one column, so this single flag covers what used to
   * be "sidebar visible" and "sidebar collapsed" separately.
   */
  const [railCollapsed, setRailCollapsed] = useState(false)
  /** True once the stored layout has been applied and may be written back. */
  const [layoutReady, setLayoutReady] = useState(false)
  /** How many dockview panes are open; drives the broadcast control's visibility. */
  const [panelCount, setPanelCount] = useState(0)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorSession, setEditorSession] = useState<SavedSession | null>(null)
  const [editorParentId, setEditorParentId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [hostKeyRequest, setHostKeyRequest] = useState<HostKeyRequest | null>(null)
  /** Which side of the share dialog is open, if either. */
  const [shareMode, setShareMode] = useState<'export' | 'import' | null>(null)
  /**
   * A destructive action waiting for a yes.
   *
   * Deleting a group takes its hosts with it — every host inside it, and inside
   * every sub-group — so a group that still holds something is never removed from
   * a single click on a menu item.
   */
  const [confirmAction, setConfirmAction] = useState<
    { kind: 'delete-folder'; id: string; name: string; hosts: number; groups: number } | null
  >(null)
  const [toast, setToast] = useState<string | null>(null)

  /*
   * A toast is a glance, not a panel: it goes away on its own.
   *
   * It used to stay until clicked, which meant a message from ten minutes ago sat
   * at the bottom of the window looking like the current state of things. Clicking
   * still dismisses it early, and a new message restarts the timer because the
   * effect is keyed on the text.
   */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])
  /** Error from a toast-style connection attempt (no dialog on screen). */
  const [alert, setAlert] = useState<{ message: string; code?: string; sessionId?: string } | null>(
    null
  )
  /** Session id currently being connected, so the tree can show a spinner. */
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [snippetBarVisible, setSnippetBarVisible] = useState(true)
  /**
   * How the Hosts page lists hosts.
   *
   * Lives here rather than in the page because the page is unmounted whenever
   * another rail section is showing — a local state meant the card view lasted
   * exactly until the user looked at something else.
   */
  const [hostsView, setHostsView] = useState<HostsView>('list')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** Right-click on a pane tab, which has its own item set. */
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)

  /**
   * "Arrange panes": which panes, and in what shape.
   *
   * `tilePanes` holds the panes as they stood when the dialog opened, so a pane that
   * closes while it is up cannot be arranged after the fact.
   */
  const [tilePanes, setTilePanes] = useState<{ id: string; title: string }[] | null>(null)
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
  /**
   * A folder waiting to be named.
   *
   * Creating a folder used to make one called "New folder" straight away and
   * renaming used an inline field in the Hosts page header — or, from the drawer,
   * the browser's `prompt()`, which Electron's renderer refuses, so that path did
   * nothing at all. Both now go through one centred dialog owned here, because the
   * three places a folder is made or renamed (the Hosts page, the drawer tree, and
   * the tree's own buttons) do not share anywhere to put a field.
   */
  const [namePrompt, setNamePrompt] = useState<
    { kind: 'new-folder'; parentId: string | null } | { kind: 'rename-folder'; id: string; name: string } | null
  >(null)
  /**
   * A quit the main process is holding open for confirmation.
   *
   * Set either by the window close (X, Alt+F4) arriving over IPC, or by the quit
   * shortcut in the renderer. Non-null means the dialog is on screen.
   */
  const [quitRequest, setQuitRequest] = useState<QuitRequest | null>(null)

  /** Focus mode: full screen with the app's own chrome out of the way. */
  const [focusMode, setFocusMode] = useState(false)
  /** Which drawer section is mid-drag, for the reorder affordance. */
  const [draggingSection, setDraggingSection] = useState<SidebarSectionId | null>(null)
  /**
   * The same value as a ref.
   *
   * `dragstart` and `drop` are separate events in one gesture, and React state
   * does not reach the next handler synchronously — the drop would read `null`
   * and do nothing.
   */
  const draggingSectionRef = useRef<SidebarSectionId | null>(null)
  /** Drawer section menu (reorder affordance lives on the header's right-click). */
  const [sectionMenu, setSectionMenu] = useState<{
    x: number
    y: number
    id: SidebarSectionId
  } | null>(null)
  /** Non-null while the lock screen is up. */
  const [locked, setLocked] = useState(false)
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null)
  /** Non-null while the wellness nudge is on screen. */
  const [breakBar, setBreakBar] = useState<BreakBarState | null>(null)
  /** Pomodoro phase, for the countdown chip in the drawer. */
  const [wellness, setWellness] = useState<{ phase: 'work' | 'break'; endsAt: number }>({
    phase: 'work',
    endsAt: 0
  })
  /** Seconds of *focused* use since the last reminder. */
  const focusedSecondsRef = useRef(0)
  const breakDueRef = useRef(false)
  const breakBarRef = useRef(false)
  /** Pomodoro: which half of the cycle we are in, and when the break ends. */
  const phaseRef = useRef<'work' | 'break'>('work')
  const breakEndsAtRef = useRef(0)
  /** Last time any session produced output; the nudge waits for quiet. */
  const lastActivityRef = useRef(Date.now())
  /**
   * The active pane, as React state.
   *
   * dockview's `activePanel` cannot be read reactively, and switching tabs does
   * not necessarily change the panel *count* — so anything derived from "what the
   * user is looking at" (the SFTP listing, the tree's active row) needs this to
   * re-render.
   */
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
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

  /**
   * Sessions whose process has ended, by session id.
   *
   * Keyed on the session rather than the pane on purpose: a pane that reconnects
   * gets a *new* session id, so the flag clears itself and `Ctrl+D` starts meaning
   * EOF again the moment there is a shell to send it to.
   */
  const endedSessionsRef = useRef(new Set<string>())
  /** Latest session list, for callbacks created once (see `isPaneDead`). */
  const sessionsRef = useRef<SessionInfo[]>([])
  sessionsRef.current = sessions

  // The dockview factory and connect helpers are registered once, so they read
  // the current tree through a ref rather than a captured value.
  const treeRef = useRef<Tree>(EMPTY_TREE)
  treeRef.current = tree
  /** Latest settings, so callbacks created once can read the current list. */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  /**
   * Layout is read once, before the dockview bootstrap effect runs, and read
   * through a ref there so that effect keeps its empty dependency list.
   */
  /** Set by the connect helpers; called by a restored pane's Reconnect button. */
  const reconnectRef = useRef<(panelId: string, savedSessionId: string, title: string) => void>(
    () => {}
  )
  /** Latest connectSaved, so the reconnect effect need not re-run every render. */
  const connectSavedRef = useRef<(session: SavedSession, password?: string) => Promise<void>>(
    async () => {}
  )
  /**
   * Saved session id → the pane whose Reconnect button was pressed for it.
   *
   * A pane remembers the saved session it came from in its own params, but that
   * field can be stale for a layout written by an older build (see
   * `reconnectRef`), so the pane that actually asked is recorded here and adopted
   * once its connection is up.
   */
  const pendingPaneRef = useRef<Map<string, string>>(new Map())
  /**
   * Maps a panel id to the live session it currently displays.
   *
   * They are equal for a pane that was simply connected, but a reload keeps the
   * pane and swaps the session behind it, so everything that closes or activates
   * a pane by id has to resolve through here — otherwise closing a reloaded pane
   * closes a backend that is already gone and leaks the live one.
   */
  const liveSessionRef = useRef<Map<string, string>>(new Map())
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

    // Restore the saved arrangement: which rail section, and whether the rail was
    // shrunk and the snippet bar was showing. The docking layout itself is applied
    // by the dockview bootstrap effect, which reads it from the same ref.
    //
    // Until this lands, the rail is *disabled*. The restore is asynchronous, so a
    // click that arrives before it is silently overwritten a moment later by the
    // stored value — the first toggle after launch would just not take, which is
    // exactly the kind of bug that reads as "the button is broken sometimes".
    void api.loadLayout().then((layout) => {
      setPage(layout.page)
      setRailCollapsed(layout.railCollapsed)
      setSnippetBarVisible(layout.snippetBarVisible)
      setHostsView(layout.hostsView)
      hydratedRef.current = true
      setLayoutReady(true)
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

  /**
   * The panel that shows a given session.
   *
   * Usually the session id *is* the panel id; after a reload the pane keeps its
   * old id and only the session behind it changed, so the reverse lookup is what
   * makes the sidebar's activate/close actions keep working.
   */
  const resolvePanelId = useCallback((sessionId: string): string => {
    if (dockApiRef.current?.getPanel(sessionId)) return sessionId
    for (const [panelId, live] of liveSessionRef.current) {
      if (live === sessionId) return panelId
    }
    return sessionId
  }, [])

  /** The live session behind a pane id. */
  const liveIdFor = useCallback(
    (panelId: string): string => liveSessionRef.current.get(panelId) ?? panelId,
    []
  )

  /**
   * Is there nothing running behind this pane?
   *
   * `Ctrl`+`D` asks this before it closes anything, and the honest answer is "no
   * live session", not "a session ended in front of me": a dropped SSH link, a
   * restored placeholder from the last layout and a shell exited a minute ago all
   * leave a pane with nothing behind it, and only the middle one used to be
   * recognised. The marked set stays as a fast path for the pane that just saw its
   * process exit.
   */
  const isPaneDead = useCallback(
    (panelId: string): boolean => {
      const live = liveIdFor(panelId)
      if (endedSessionsRef.current.has(live) || endedSessionsRef.current.has(panelId)) return true
      return !sessionsRef.current.some((s) => s.id === live)
    },
    [liveIdFor]
  )

  const closeSession = useCallback(
    (sessionId: string) => {
      const panelId = resolvePanelId(sessionId)
      const live = liveIdFor(panelId)
      api.closeSession(live)
      const panel = dockApiRef.current?.getPanel(panelId)
      if (panel) dockApiRef.current?.removePanel(panel)
      liveSessionRef.current.delete(panelId)
      endedSessionsRef.current.delete(live)
      endedSessionsRef.current.delete(panelId)
      removeSessionState(live)
      removeSessionState(panelId)
    },
    [liveIdFor, removeSessionState, resolvePanelId]
  )
  /** Close a pane's backend without touching the panel, for the remove handler. */
  const closeBackendRef = useRef<(panelId: string) => void>(() => {})
  closeBackendRef.current = (panelId: string) => {
    api.closeSession(liveIdFor(panelId))
    liveSessionRef.current.delete(panelId)
  }

  // ---- dockview bootstrap -------------------------------------------------

  useEffect(() => {
    const container = dockRef.current
    if (!container) return

    /*
     * Build as soon as there is any box at all.
     *
     * A "wait until it looks settled" test was tried here — including one that
     * waited for two identical ticks — and it made things worse rather than
     * better: while the dock does not exist, the watchdog that corrects sizes
     * cannot run either, so a container that never settles leaves no dock at all.
     * Building immediately and letting the watchdog converge is the version that
     * works.
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
                onReconnect={(id, name) => reconnectRef.current(options.id, id, name)}
                onSessionEnded={(id) => {
                  endedSessionsRef.current.add(id)
                  endedRef.current(id)
                }}
              />
            )
          })
        }
        return new ReactContentRenderer(() => <WelcomePanel />)
      },
      createWatermarkComponent: () =>
        new ReactWatermarkRenderer(() => (
          <div className="td-watermark-inner">
            <div className="td-watermark-title">{t('app.no_session', 'No session')}</div>
            <div className="td-watermark-hint">
              {t('app.open_a_saved_session_or_pres', 'Open a saved session, or press')}<kbd>{t('app.ctrl', 'Ctrl')}</kbd>+<kbd>T</kbd> {t('app.to_connect', 'to connect.')}
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
      /*
       * Why `Ctrl`+`D` does or does not consider a pane dead. "It closed the wrong
       * pane" and "it refused to close a dead one" look identical from outside, and
       * the inputs to that decision are three different pieces of state.
       */
      ;(window as unknown as Record<string, unknown>)['__tdPaneLiveness'] = (id: string) => ({
        live: liveIdFor(id),
        marked: endedSessionsRef.current.has(liveIdFor(id)),
        sessions: sessionsRef.current.map((s) => s.id),
        dead: isPaneDead(id)
      })
      // The component itself: `api.layout` is not the same function as
      // `dock.layout`, and probes need the latter.
      ;(window as unknown as Record<string, unknown>)['__tdDock'] = dock
      // Broadcast fan-out state, so a probe can tell "this pane was never
      // registered" apart from "it was written to and the shell stayed quiet".
      ;(window as unknown as Record<string, unknown>)['__tdBroadcast'] = {
        sinks: sinkIds,
        writes: writesBySink
      }
    }

    const removed = dock.api.onDidRemovePanel((panel) => {
      if (panel.id !== 'welcome') closeBackendRef.current(panel.id)
      removeSessionState(panel.id)
    })

    /*
     * Which pane is in front, as state.
     *
     * Switching tabs does not necessarily change the panel count, so nothing
     * else would re-render — and the drawer's SFTP listing is keyed off exactly
     * this. Without it, switching tabs could leave one host's files on screen
     * while another host's terminal has focus.
     */
    const activeChanged = dock.api.onDidActivePanelChange((event) => {
      setActivePanelId(event.panel?.id ?? null)
    })
    setActivePanelId(dock.api.activePanel?.id ?? null)

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
    const disposition = dock.api.onDidLayoutChange(() => {      dirty = true
      // How many panes a keystroke would reach, for the broadcast control. Counted
      // from the layout rather than from the session list, because a restored
      // placeholder is a pane too and the two must not disagree.
      setPanelCount(dock.api.panels.length)
      /*
       * Publish which panes are actually on screen.
       *
       * `panel.api.isVisible` is dockview's own answer, and it excludes the
       * non-selected tabs of a group — those are open sessions with live
       * backends, but typing into them would be typing into something the user
       * cannot see.
       */
      setVisibleSessions(
        dock.api.panels
          .filter((panel) => panel.api.isVisible)
          .map((panel) => {
            // A live pane's panel id *is* its session id; a restored placeholder
            // carries the saved id instead and has no session to write to.
            const params = panel.api.getParameters<TerminalPanelMeta>() ?? {}
            return params.session?.id ?? panel.id
          })
      )
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
      /*
       * The parsed state is kept because it is the only place a saved-session link
       * can be read back from: `panel.api.getParameters()` is empty on a panel that
       * came out of `fromJSON` until something calls `updateParameters` on it.
       */
      let persisted: { panels?: Record<string, { params?: TerminalPanelMeta }> } | null = null
      if (layout.dockview) {
        try {
          const state = JSON.parse(layout.dockview)
          persisted = state
          dock.fromJSON(state)
          restored = dock.api.panels.length > 0
        } catch {
          // A layout saved by an incompatible version must not block startup.
          restored = false
        }
      }
      setPanelCount(dock.api.panels.length)

      if (restored) {
        for (const panel of dock.api.panels) {
          if (panel.api.component !== 'terminal') continue
          const recorded = persisted?.panels?.[panel.id]?.params?.savedSessionId
          panel.api.updateParameters({
            session: undefined,
            disconnected: true,
            /*
             * Keep the saved session the layout recorded, and only fall back to the
             * panel's own id: that id is the *live* session the pane happened to be
             * showing when the layout was written, and a layout that has it here is
             * one from before the link was recorded. `reconnectRef` copes with
             * those by title.
             */
            savedSessionId: recorded ?? panel.id,
            title: panel.title || 'Session'
          })
          // dockview does not notify the content renderer of a params change, so
          // ask it to re-render with the disconnected props.
          refreshPanelParams(panel.id)
        }
      } else {
        dock.api.addPanel({ id: 'welcome', component: 'welcome', title: t('app.welcome', 'Welcome') })
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

    const gridSize = (): { w: number; h: number } | null => {
      const grid = document.querySelector('.dv-grid-view') as HTMLElement | null
      return grid ? { w: grid.clientWidth, h: grid.clientHeight } : null
    }

    const applyLayout = (): void => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (width === 0 || height === 0) return
      /*
       * No "is it big enough?" guard here, deliberately.
       *
       * One was tried — skip anything under 200px, on the theory that a
       * placeholder-sized container must not be handed to `dock.layout` — and it
       * caused the very failure it was meant to prevent. `dock.layout()` does not
       * only read the container: it *resizes the docking surface to the numbers it
       * is given*. Once that surface is collapsed, the container reads the
       * collapsed size too, so the guard skipped every call from then on and the
       * state became permanent — 65px panes with blank terminals, surviving
       * reloads and window resizes. Without the guard the next tick lays out the
       * real size again as soon as the surface is released.
       */
      // `force` matters: without it dockview treats the size as unchanged and
      // leaves its internal grid at the placeholder it measured on mount.
      dock.layout(width, height, true)

      /*
       * Then ask every terminal to re-measure.
       *
       * Correcting the layout is only half the job: a terminal that was fitted
       * against the collapsed box keeps that size, and its own watchdog may have
       * stopped by then — so the pane stays 65px with a blank terminal even though
       * the container is now right. One idempotent refit per tick is cheap next to
       * the terminal's own rendering, and it is what makes the correction actually
       * visible.
       */
      refitAll()

      if (window.localStorage.getItem('tdDebug') === '1') {
        const trail = ((window as unknown as Record<string, unknown>)['__tdDockTrail'] ??=
          []) as Array<Record<string, unknown>>
        const grid = document.querySelector('.dv-grid-view')
        const group = document.querySelector('.dv-groupview')
        trail.push({
          at: Math.round(performance.now()),
          dpr: window.devicePixelRatio,
          asked: `${width}x${height}`,
          dock: `${host.clientWidth}x${host.clientHeight}`,
          grid: grid ? `${grid.clientWidth}x${grid.clientHeight}` : null,
          group: group ? `${group.clientWidth}x${group.clientHeight}` : null
        })
        if (trail.length > 60) trail.shift()
      }
    }

    /**
     * Apply on the next frame, coalescing a burst of resize events.
     *
     * `requestAnimationFrame` is throttled — or not delivered at all — when the
     * window is not being painted, which is exactly when a pane can be left
     * collapsed. The watchdog below therefore calls `applyLayout` directly rather
     * than through here; this path is for the observer, where the coalescing is
     * the point.
     */
    const syncLayout = (): void => {
      if (settleFrame) window.cancelAnimationFrame(settleFrame)
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = 0
        applyLayout()
      })
    }
    /*
     * Reachable from `addSession` and from a scale change: a pane added before the
     * dock has been measured would otherwise stay glued to the placeholder size.
     *
     * This is `applyLayout`, not the coalesced `syncLayout`, and deliberately
     * synchronous. `requestAnimationFrame` is throttled when the window is not
     * being painted, and a deferred call that never runs is exactly how a pane ends
     * up 65px tall with a blank terminal.
     */
    dockSyncRef.current = applyLayout
    const dockObserver = new ResizeObserver(syncLayout)
    dockObserver.observe(host)

    /*
     * Drive the re-layout until the grid actually agrees with its container.
     *
     * Verified in isolation and in the app: a DockviewComponent constructed while
     * its container is a 100x100 placeholder keeps its grid pinned at 100x100 even
     * after the container grows, and `layout(w, h, true)` is what releases it.
     *
     * Neither a ResizeObserver nor a fixed polling window is enough on its own.
     * The observer is not delivered on some runs at all, and a fixed window
     * expires while the arrangement is still settling — which is what happens when
     * something else changed the zoom first: the grid then keeps an *inline* size
     * the container never had, and because the container never changes again
     * nothing notices. A pane in that grid is 65px tall with a blank terminal.
     *
     * Calling `dock.layout` **directly** here rather than on the next frame is
     * load-bearing. `requestAnimationFrame` is throttled, or not delivered at all,
     * when the window is not being painted — so a deferred layout call can simply
     * never run, leaving the pane collapsed for as long as the window exists. That
     * is what made the same failure appear and disappear between runs.
     */
    const layoutWatchdog = window.setInterval(() => {
      /*
       * Guarded: an exception from `dock.layout` would escape the interval
       * callback, and a throwing interval is silently terminated — the watchdog
       * would stop for good and every pane would stay collapsed with no error
       * anywhere. Retrying on the next tick is the useful behaviour.
       */
      try {
        applyLayout()
      } catch {
        /* the next tick tries again */
      }
    }, 100)
    rearmLayoutRef.current = syncLayout
    syncLayout()
    if (window.localStorage.getItem('tdDebug') === '1') {
      ;(window as unknown as Record<string, unknown>)['__tdDockLayout'] = syncLayout
    }

    return () => {
      cancelled = true
      window.clearTimeout(saveTimer)
      if (settleFrame) window.cancelAnimationFrame(settleFrame)
      window.clearInterval(layoutWatchdog)
      dockObserver.disconnect()
      // Flush on teardown: the debounce window is wider than the gap between the
      // last change and app quit, so a pending save would otherwise be lost.
      if (dirty) persist()
      disposition.dispose()
      removed.dispose()
      activeChanged.dispose()
      dock.dispose()
      dockApiRef.current = null
      dockSyncRef.current = null
    }
    }
  }, [removeSessionState])

  // ---- persist the arrangement -------------------------------------------

  useEffect(() => {
    // Skip until the saved layout has been applied, otherwise the first render
    // would overwrite it with defaults. Gated on the rendered flag as well as the
    // ref: the ref is set synchronously inside the load callback while the state
    // lands later, and a write in between would store the pre-restore values.
    if (!hydratedRef.current || !layoutReady) return
    void api.saveLayout({ page, railCollapsed, snippetBarVisible, hostsView })
  }, [page, railCollapsed, snippetBarVisible, hostsView, layoutReady])

  // ---- session creation ---------------------------------------------------

  /**
   * Re-layout until a freshly added pane has a real size.
   *
   * dockview measures itself when the panel is added. If that happens before the
   * dock has been laid out — which is exactly what a pane added while the window
   * is still settling does — the pane keeps a 100x100 placeholder and never
   * grows, so its terminal paints in a 65px box and shows nothing. Retrying
   * until the panel reports a plausible size makes that self-correcting instead
   * of leaving a permanently broken pane.
   *
   * The retry continues while the *pane* is small, not only while the width is
   * small: a pane whose width is right but whose height collapsed is the same
   * bug, and it used to stop retrying right there. A duplicated tab lands in an
   * existing group and hits this just as readily as a first connection does,
   * which is why it is shared rather than open-coded at each call site.
   */
  const settlePanel = useCallback((panelId: string) => {
    const dockApi = dockApiRef.current
    if (!dockApi) return
    let attempts = 0
    const settle = (): void => {
      dockSyncRef.current?.()
      const panel = dockApi.getPanel(panelId)
      const tiny = !panel || panel.api.width < 200 || panel.api.height < 200
      if (attempts++ < 30 && tiny) window.setTimeout(settle, 100)
    }
    settle()
  }, [])

  /**
   * A restored placeholder still standing for this saved session, if any.
   *
   * Found through its params rather than its id: a pane restored from the layout
   * keeps the id it had when it was saved (which was the live session's), so the
   * saved session's id is not something a panel can be looked up by.
   */
  const restoredPaneFor = useCallback((savedSessionId: string): string | undefined => {
    const dockApi = dockApiRef.current
    if (!dockApi) return undefined
    const direct = dockApi.getPanel(savedSessionId)
    if (direct) return direct.id
    return dockApi.panels.find((panel) => {
      const params = panel.api.getParameters<TerminalPanelMeta>() ?? {}
      return params.disconnected === true && params.savedSessionId === savedSessionId
    })?.id
  }, [])

  const addSession = useCallback(
    (session: SessionInfo, fromSaved?: string) => {
      const dockApi = dockApiRef.current
      if (!dockApi) return

      setSessions((prev) => [...prev, session])

      // A restored pane for this saved session is still sitting there as a
      // placeholder; give it the live session instead of adding a second tab.
      const adoptId = fromSaved
        ? (pendingPaneRef.current.get(fromSaved) ?? restoredPaneFor(fromSaved))
        : undefined
      if (fromSaved) pendingPaneRef.current.delete(fromSaved)
      const existing = adoptId ? dockApi.getPanel(adoptId) : undefined
      if (existing) {
        liveSessionRef.current.set(existing.id, session.id)
        existing.api.updateParameters({
          session,
          disconnected: false,
          /*
           * The link to the saved session is kept rather than cleared. This pane is
           * live, but the layout is serialised from these params, and that link is
           * what lets the pane restored from that layout reconnect again.
           */
          savedSessionId: fromSaved,
          title: session.title
        })
        refreshPanelParams(existing.id)
        existing.api.setTitle(session.title)
        existing.api.setActive()
        return
      }

      const placeholder = dockApi.getPanel('welcome')
      if (placeholder) dockApi.removePanel(placeholder)

      liveSessionRef.current.set(session.id, session.id)
      const panel = dockApi.addPanel({
        id: session.id,
        component: 'terminal',
        title: session.title,
        params: {
          session,
          onEnded: (id: string) => endedRef.current(id)
        }
      })

      /*
       * Record which saved session this pane belongs to.
       *
       * `addPanel`'s params reach the renderer but are not kept by dockview's own
       * panel state, and the layout is serialised from that state — so without this
       * second call a pane restored from the layout has nothing but its own (by
       * then dead) live session id to go on, and its Reconnect button can never
       * find the session it came from.
       */
      if (fromSaved) {
        panel.api.updateParameters({
          session,
          savedSessionId: fromSaved,
          title: session.title,
          onEnded: (id: string) => endedRef.current(id)
        })
      }

      /*
       * Then drive the layout until the pane agrees with its container; see
       * `settlePanel` for why one layout pass is not enough.
       */
      settlePanel(session.id)
    },
    [restoredPaneFor, settlePanel]
  )

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
        addSession(result.session, payload.savedSessionId)
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

      /*
       * A rejected password goes straight to the prompt for that one host.
       *
       * The alert below already offered "Enter password", which is one click more
       * than the situation needs, and in a batch of hosts added with a shared
       * password the wrong one is expected rather than exceptional. Only for
       * password auth: re-typing a password cannot fix a bad key or a dead agent.
       */
      if (error.code === 'AUTH_FAILED' && savedSession?.authMethod === 'password') {
        setAlert(null)
        setPasswordPrompt({ session: savedSession, retry: true, reason: error.message })
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
   * Lets a restored pane reconnect, in the pane it was pressed in.
   *
   * The pane remembers the saved session it came from in its own params — but a
   * layout written before that was recorded keeps the *live* session id there,
   * which is gone by the next launch, so the lookup falls back to the pane's own
   * title. That title is the saved session's name, and a single exact match is
   * the session it came from; two matches would be a guess, and quietly
   * connecting the wrong host is worse than saying it cannot be done.
   *
   * Registered through a ref because the dockview factory is created once and
   * cannot see later renders.
   */
  useEffect(() => {
    connectSavedRef.current = connectSaved
    reconnectRef.current = (panelId, savedSessionId, title) => {
      const sessions = treeRef.current.sessions
      const byId = sessions.find((s) => s.id === savedSessionId)
      const matches = byId ? [byId] : sessions.filter((s) => s.name === title)
      if (matches.length !== 1) {
        setAlert({
          message: `“${title}” is no longer saved, so this pane cannot be restored. Close it, or save the session again.`
        })
        return
      }
      pendingPaneRef.current.set(matches[0].id, panelId)
      void connectSavedRef.current(matches[0])
    }
  }, [connectSaved])

  // Broadcast mode lives outside React so terminal input handlers see the current
  // value; this keeps the button in step with it.
  useEffect(() => onBroadcastChange(setBroadcasting), [])

  // ---- quitting -----------------------------------------------------------

  /**
   * The main process holds a window close until the user answers, and this is
   * what puts the question on screen: the window's X, Alt+F4 and "Close window"
   * from the taskbar all arrive here as one event.
   */
  useEffect(() => {
    return api.onQuitRequested((request) => setQuitRequest(request))
  }, [])

  /**
   * The quit shortcut asks the same question as the X button.
   *
   * The count comes from the main process rather than from the pane list in
   * state: a pane that was reloaded keeps its panel id while its session id has
   * changed, and the main process is the only side that knows every live backend.
   */
  const requestQuit = useCallback(() => {
    void api
      .listSessions()
      .then((live) => setQuitRequest({ sessions: live.length }))
      .catch(() => setQuitRequest({ sessions: 0 }))
  }, [])

  // ---- focus mode ---------------------------------------------------------

  /**
   * Full screen with the app's own chrome out of the way.
   *
   * Main is the authority on the state: the shortcut is handled there (so the
   * default menu's own F11 cannot swallow it), and the user can leave full screen
   * by other means, so the renderer follows what the window actually reports.
   */
  useEffect(() => api.onFullScreenChanged(setFocusMode), [])
  useEffect(() => {
    // Tolerant of a missing handler: focus mode simply stays off rather than
    // throwing an unhandled rejection out of an effect.
    void api
      .isFullScreen()
      .then(setFocusMode)
      .catch(() => setFocusMode(false))
  }, [])

  const toggleFocus = useCallback(() => {
    void api
      .setFullScreen(!focusMode)
      .then(setFocusMode)
      .catch(() => setToast('Full screen is unavailable in this window.'))
  }, [focusMode])

  // ---- lock screen --------------------------------------------------------

  useEffect(() => {
    void api.lockStatus().then(setLockStatus)
  }, [])

  const lockNow = useCallback(() => setLocked(true), [])

  const unlock = useCallback(async (password: string): Promise<boolean> => {
    const ok = await api.verifyLock(password)
    if (ok) setLocked(false)
    return ok
  }, [])

  // ---- command history ----------------------------------------------------
  // Per session, kept for a week by the main process. The panel follows the
  // active pane unless the user points it at an older session with its picker.

  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historySessions, setHistorySessions] = useState<HistorySessionSummary[]>([])
  const [historyPick, setHistoryPick] = useState<string | null>(null)
  const [historyTick, setHistoryTick] = useState(0)

  useEffect(() => api.onHistoryChanged(() => setHistoryTick((t) => t + 1)), [])

  /** The live session behind the active pane, whatever kind it is. */
  const activeLiveSessionId = useMemo(() => {
    if (!activePanelId || activePanelId === 'welcome') return null
    return liveSessionRef.current.get(activePanelId) ?? activePanelId
  }, [activePanelId])

  /**
   * The same session, but only when it is an SSH login.
   *
   * The SFTP panel keys its listing off this: it must list the host the user is
   * looking at, and nothing at all for a local shell.
   */
  const activeSshSessionId = useMemo(
    () =>
      sessions.find((s) => s.id === activeLiveSessionId)?.kind === 'ssh'
        ? activeLiveSessionId
        : null,
    [activeLiveSessionId, sessions]
  )

  // Following the active pane is the default; a pick from the selector is a
  // deliberate look at another session, and switching panes starts over.
  useEffect(() => setHistoryPick(null), [activeLiveSessionId])

  const historySessionId = historyPick ?? activeLiveSessionId

  useEffect(() => {
    let cancelled = false
    void api.historySessions().then((list) => {
      if (!cancelled) setHistorySessions(list)
    })
    if (!historySessionId) {
      setHistoryEntries([])
      return
    }
    void api.listHistory(historySessionId).then((entries) => {
      if (!cancelled) setHistoryEntries(entries)
    })
    return () => {
      cancelled = true
    }
  }, [historySessionId, historyTick])

  /** Send a command from history to the pane the user is looking at. */
  const sendHistory = useCallback((command: string) => {
    const active = dockApiRef.current?.activePanel
    const sessionId = active && active.id !== 'welcome' ? active.id : null
    if (!sessionId) {
      setAlert({ message: t('app.no_active_terminal_connect_t', 'No active terminal. Connect to a host first.') })
      return
    }
    // The command was run once already, so Enter is part of it.
    api.writeSession(sessionId, `${command}\r`)
  }, [])

  const forgetHistory = useCallback((entries: HistoryEntry[]) => {
    setHistoryEntries(entries)
    setHistoryTick((t) => t + 1)
  }, [])

  const deleteHistoryEntry = useCallback(
    (id: string) => {
      if (!historySessionId) return
      void api.deleteHistoryEntry(historySessionId, id).then(forgetHistory)
    },
    [forgetHistory, historySessionId]
  )

  const clearHistory = useCallback(() => {
    if (!historySessionId) return
    void api.clearHistory(historySessionId).then(forgetHistory)
  }, [forgetHistory, historySessionId])

  // ---- wellness timer: reminder and pomodoro ------------------------------

  /**
   * Record a finished stretch of work.
   *
   * `longestMinutes` is the number that actually says something about a day, so
   * it is what gets kept; `pomodoros` only moves in pomodoro mode.
   */
  const recordBreak = useCallback(
    (workedMinutes: number) => {
      const stats = settingsRef.current.breakStats
      const pomodoro = settingsRef.current.break.mode === 'pomodoro'
      void api
        .saveSettings({
          ...settingsRef.current,
          breakStats: {
            longestMinutes: Math.max(stats.longestMinutes, workedMinutes),
            breaks: stats.breaks + 1,
            pomodoros: stats.pomodoros + (pomodoro ? 1 : 0),
            lastBreakAt: Date.now()
          }
        })
        .then(setSettings)
        .catch(() => {
          /* losing the stat must not block the break */
        })
      log('info', `Break taken after ${workedMinutes} min of continuous work`)
    },
    [log]
  )

  /**
   * One timer, two behaviours.
   *
   * `reminder` counts focused work and nudges once it has gone on long enough;
   * `pomodoro` runs fixed rounds — work, then a break of its own length, then the
   * next round. Both share the idle gate below, because interrupting a running
   * command is the one thing a wellness timer must not do.
   *
   * Two gates, both deliberate:
   *
   *  - only while the window has focus, because a reminder that fires at someone
   *    who walked away twenty minutes ago is noise rather than care;
   *  - only once the terminals have been quiet for `idleSeconds`, because landing
   *    a banner on top of the command someone is in the middle of is worse than
   *    not reminding them at all. `lastActivityRef` is driven by session output,
   *    which covers both a running command and the echo of typing.
   *
   * A pomodoro break, once it has started, counts in wall-clock time: the whole
   * point is that you are away from the keyboard, so requiring focus would stop
   * the clock exactly when you are doing the right thing.
   */
  useEffect(() => {
    const { enabled, mode, minutes, breakMinutes, idleSeconds } = settings.break
    if (!enabled) {
      focusedSecondsRef.current = 0
      breakDueRef.current = false
      breakBarRef.current = false
      phaseRef.current = 'work'
      setBreakBar(null)
      setWellness({ phase: 'work', endsAt: 0 })
      return
    }

    const timer = window.setInterval(() => {
      // ---- pomodoro ------------------------------------------------------
      if (mode === 'pomodoro') {
        if (phaseRef.current === 'break') {
          const left = Math.max(0, (breakEndsAtRef.current - Date.now()) / 1000)
          if (left > 0) return
          // Break over: record it and start the next round.
          recordBreak(Math.max(1, Math.round(settingsRef.current.break.minutes)))
          phaseRef.current = 'work'
          focusedSecondsRef.current = 0
          breakDueRef.current = false
          setWellness({ phase: 'work', endsAt: 0 })
          breakBarRef.current = true
          setBreakBar({ kind: 'work', minutes: settingsRef.current.break.minutes })
          return
        }

        if (document.hasFocus()) focusedSecondsRef.current += 1
        if (focusedSecondsRef.current < minutes * 60) return

        // The round is done; wait for the terminals to go quiet before saying so,
        // and the break starts when it appears.
        if (breakBarRef.current) return
        if (Date.now() - lastActivityRef.current < idleSeconds * 1000) return
        breakEndsAtRef.current = Date.now() + breakMinutes * 60 * 1000
        phaseRef.current = 'break'
        breakBarRef.current = true
        setWellness({ phase: 'break', endsAt: breakEndsAtRef.current })
        setBreakBar({ kind: 'break', minutes: breakMinutes })
        return
      }

      // ---- reminder ------------------------------------------------------
      if (!document.hasFocus()) return
      if (!breakDueRef.current) {
        focusedSecondsRef.current += 1
        if (focusedSecondsRef.current >= minutes * 60) breakDueRef.current = true
        return
      }
      if (breakBarRef.current) return
      if (Date.now() - lastActivityRef.current >= idleSeconds * 1000) {
        breakBarRef.current = true
        setBreakBar({ kind: 'reminder', minutes: Math.round(focusedSecondsRef.current / 60) })
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [recordBreak, settings.break])

  /** Sessions' output, as the signal for "the terminals are busy". */
  useEffect(() => api.onSessionData(() => (lastActivityRef.current = Date.now())), [])

  /**
   * A break happened: record it, then start counting again.
   *
   * `kind: 'lock'` covers the screen as well, which is the only version of this
   * that actually gets someone to stand up.
   */
  const takeBreak = useCallback(
    (kind: 'break' | 'lock') => {
      const workedMinutes = Math.max(1, Math.round(focusedSecondsRef.current / 60))
      recordBreak(workedMinutes)

      focusedSecondsRef.current = 0
      breakDueRef.current = false
      breakBarRef.current = false
      // In pomodoro mode "break taken" also ends the break: the next round starts
      // now rather than waiting out a timer nobody is watching.
      phaseRef.current = 'work'
      setWellness({ phase: 'work', endsAt: 0 })
      setBreakBar(null)
      if (kind === 'lock') setLocked(true)
      else setToast(`Break recorded — ${workedMinutes} min. The timer starts again from now.`)
    },
    [recordBreak]
  )

  const snoozeBreak = useCallback((snoozeMinutes: number) => {
    // "Later" means later, not a full second interval: the countdown resumes
    // `snoozeMinutes` short of the threshold.
    focusedSecondsRef.current = Math.max(
      0,
      settingsRef.current.break.minutes * 60 - snoozeMinutes * 60
    )
    breakDueRef.current = false
    breakBarRef.current = false
    setBreakBar(null)
    setToast(`Reminder snoozed for ${snoozeMinutes} minutes.`)
  }, [])

  /** Hide the nudge without pretending a break was taken. */
  const dismissBreak = useCallback(() => {
    breakBarRef.current = false
    setBreakBar(null)
  }, [])

  /**
   * Give up on a pomodoro break and start the next round now.
   *
   * The work round behind it is still recorded: it happened, and losing it
   * because the break was cut short would make the counter lie.
   */
  const endPomodoroBreak = useCallback(() => {
    if (phaseRef.current === 'break') {
      recordBreak(Math.max(1, Math.round(settingsRef.current.break.minutes)))
    }
    phaseRef.current = 'work'
    focusedSecondsRef.current = 0
    breakDueRef.current = false
    breakBarRef.current = false
    setWellness({ phase: 'work', endsAt: 0 })
    setBreakBar(null)
  }, [recordBreak])

  // ---- drawer sections ----------------------------------------------------

  const sectionState = settings.sidebar.sections
  const visibleSections = useMemo(
    () => sectionState.filter((section) => section.visible),
    [sectionState]
  )

  /** Drawer width: settings is the truth, except while a drag is in progress. */
  const [liveDrawerWidth, setLiveDrawerWidth] = useState<number | null>(null)
  const drawerWidth = liveDrawerWidth ?? settings.sidebar.width

  const saveSidebar = useCallback((patch: Partial<AppSettings['sidebar']>) => {
    const current = settingsRef.current
    void api
      .saveSettings({ ...current, sidebar: { ...current.sidebar, ...patch } })
      .then(setSettings)
  }, [])

  const saveSections = useCallback(
    (sections: AppSettings['sidebar']['sections']) => saveSidebar({ sections }),
    [saveSidebar]
  )

  /**
   * Move a section to the slot another one occupies.
   *
   * Reading the list from `settingsRef` rather than from the render closure
   * matters when two drops land in the same tick: the state update from the first
   * has not rendered yet, and a stale list would drop the first move.
   */
  const moveSection = useCallback(
    (from: SidebarSectionId, to: SidebarSectionId) => {
      if (from === to) return
      const next = [...settingsRef.current.sidebar.sections]
      const fromIndex = next.findIndex((s) => s.id === from)
      const toIndex = next.findIndex((s) => s.id === to)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      saveSections(next)
    },
    [saveSections]
  )

  const patchSection = useCallback(
    (id: SidebarSectionId, patch: Partial<AppSettings['sidebar']['sections'][number]>) => {
      saveSections(
        settingsRef.current.sidebar.sections.map((s) => (s.id === id ? { ...s, ...patch } : s))
      )
    },
    [saveSections]
  )

  const setSectionVisible = useCallback(
    (id: SidebarSectionId, visible: boolean) => patchSection(id, { visible }),
    [patchSection]
  )

  /**
   * Drag the drawer's inner edge.
   *
   * The width is held locally during the gesture and saved on release: a settings
   * save writes the file and broadcasts to every window, which is not something
   * to do on every pointer move. A drawer docked to the right grows the other way,
   * so the delta is inverted for it.
   */
  const startDrawerResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = drawerWidth
      const direction = settingsRef.current.sidebar.side === 'right' ? -1 : 1
      let last = startWidth

      const move = (e: PointerEvent): void => {
        last = Math.min(
          560,
          Math.max(200, Math.round(startWidth + (e.clientX - startX) * direction))
        )
        setLiveDrawerWidth(last)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        setLiveDrawerWidth(null)
        saveSidebar({ width: last })
        // The panes were held still for the whole drag; now they measure once.
        setFitsPaused(false)
      }

      // Widening the drawer narrows every pane beside it, frame by frame.
      setFitsPaused(true)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [drawerWidth, saveSidebar]
  )

  /** Which edge a drop at this x means. There are only two lanes. */
  const laneAt = useCallback(
    (clientX: number): SidebarSide => (clientX > window.innerWidth / 2 ? 'right' : 'left'),
    []
  )

  /**
   * Move the whole drawer to the other edge of the window.
   *
   * Dragged by its grip in the footer and dropped on one of the two lanes: the
   * rail column means the left edge, the workspace means the right. Dropping
   * "somewhere in the middle" is not a question worth asking — whichever half of
   * the window the pointer is over is the answer.
   */
  const dockDrawer = useCallback(
    (clientX: number) => {
      const side = laneAt(clientX)
      if (settingsRef.current.sidebar.side === side) return
      saveSidebar({ side })
      setToast(`Drawer moved to the ${side}.`)
    },
    [laneAt, saveSidebar]
  )

  /** Flip the drawer to the other edge, for the menu and the grip's double-click. */
  const flipDrawer = useCallback(() => {
    const side: SidebarSide = settingsRef.current.sidebar.side === 'left' ? 'right' : 'left'
    saveSidebar({ side })
    setToast(`Drawer moved to the ${side}.`)
  }, [saveSidebar])

  const [drawerDropHint, setDrawerDropHint] = useState<SidebarSide | null>(null)
  /** True while the drawer's grip is being dragged to the other edge. */
  const [draggingDrawer, setDraggingDrawer] = useState(false)
  /** True while the pointer is over the half the drawer is *not* on. */
  const overDropLane = useCallback(
    (clientX: number): boolean => laneAt(clientX) !== settingsRef.current.sidebar.side,
    [laneAt]
  )

  /**
   * While a heading or the grip is being dragged, follow the pointer.
   *
   * The hint is blank over the half the drawer already occupies: there is nothing
   * to announce, and a highlighted lane that would do nothing reads as broken.
   */
  const onDrawerDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingDrawer && draggingSection === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDrawerDropHint(overDropLane(event.clientX) ? laneAt(event.clientX) : null)
    },
    [draggingDrawer, draggingSection, laneAt, overDropLane]
  )

  /**
   * The drawer's drop target is the whole window, not the drawer.
   *
   * A real drag ends wherever the pointer is, and the pointer is over the
   * workspace — outside the 268px `<aside>` — so a listener on the drawer itself
   * never saw the drop that the user had plainly aimed at the other edge.
   *
   * Section headings stop their own drops (see `SectionFrame`): a reorder is a
   * reorder, and only a drop on the window around them moves the drawer.
   */
  const onDrawerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!draggingDrawer && draggingSection === null) return
      event.preventDefault()
      dockDrawer(event.clientX)
      draggingSectionRef.current = null
      setDraggingSection(null)
      setDraggingDrawer(false)
      setDrawerDropHint(null)
    },
    [dockDrawer, draggingDrawer, draggingSection]
  )

  const sectionMenuItems = useMemo((): MenuItem[] => {
    if (!sectionMenu) return []
    const other = settings.sidebar.side === 'left' ? 'right' : 'left'
    const items: MenuItem[] = [
      {
        id: 'hide',
        label: `${t('sidertab.hide', 'Hide')} ${t(
          'sidertab.' + sectionMenu.id,
          SIDEBAR_SECTION_LABELS[sectionMenu.id]
        )}`
      },
      // The deterministic way to move the drawer: the drag gesture is a drag, and
      // a drag is not something everyone reaches for.
      { id: 'dock', label: `Move drawer to the ${other} side`, separatorBefore: true }
    ]
    const hidden = sectionState.filter((s) => !s.visible)
    if (hidden.length > 0) {
      items.push({ id: 'show-heading', label: t('app.show_section', 'Show section'), separatorBefore: true, disabled: true })
      for (const section of hidden) {
        items.push({
          id: `show:${section.id}`,
          label: t('sidertab.' + section.id, SIDEBAR_SECTION_LABELS[section.id])
        })
      }
    }
    return items
  }, [sectionMenu, sectionState, settings.sidebar.side])

  const runSectionAction = useCallback(
    (actionId: string) => {
      if (!sectionMenu) return
      if (actionId === 'dock') {
        flipDrawer()
        return
      }
      if (actionId === 'hide') setSectionVisible(sectionMenu.id, false)
      else if (actionId.startsWith('show:')) {
        setSectionVisible(actionId.slice('show:'.length) as SidebarSectionId, true)
      }
    },
    [flipDrawer, sectionMenu, setSectionVisible]
  )

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

  /** Move one session into a folder (or out of every folder with null). */
  const moveSessionTo = useCallback(async (sessionId: string, parentId: string | null) => {
    try {
      await api.moveSession(sessionId, parentId)
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Move a whole group, which is how nesting is rearranged on the Hosts page. */
  const moveFolderTo = useCallback(async (folderId: string, parentId: string | null) => {
    const folder = treeRef.current.folders.find((f) => f.id === folderId)
    if (!folder) return
    try {
      await api.saveFolder({ id: folderId, name: folder.name, parentId })
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const createFolder = useCallback(async (parentId: string | null, name: string) => {
    try {
      await api.saveFolder({ name, parentId })
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /** Ask for a folder's name, either to create one or to rename one. */
  const askFolderName = useCallback(
    (target: { kind: 'new-folder'; parentId: string | null } | { kind: 'rename-folder'; id: string }) => {
      if (target.kind === 'new-folder') {
        setNamePrompt({ kind: 'new-folder', parentId: target.parentId })
        return
      }
      const folder = treeRef.current.folders.find((f) => f.id === target.id)
      if (!folder) return
      setNamePrompt({ kind: 'rename-folder', id: folder.id, name: folder.name })
    },
    []
  )

  const submitFolderName = useCallback(
    (name: string) => {
      const target = namePrompt
      setNamePrompt(null)
      if (!target) return
      if (target.kind === 'new-folder') void createFolder(target.parentId, name)
      else
        void api.saveFolder({ id: target.id, name }).catch((err: unknown) => {
          setToast(err instanceof Error ? err.message : String(err))
        })
    },
    [createFolder, namePrompt]
  )

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

  /**
   * Move a snippet to another group without opening the editor.
   *
   * `saveSnippet` is merge-per-field, so passing the two required fields keeps
   * the description and creation time while changing only the group.
   */
  const setSnippetGroup = useCallback(async (id: string, group: string) => {
    const snippet = settingsRef.current.snippets.find((s) => s.id === id)
    if (!snippet) return
    try {
      setSettings(await api.saveSnippet({ id, label: snippet.label, command: snippet.command, group }))
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err))
    }
  }, [])

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
          { id: 'connect', label: t('app.connect', 'Connect') },
          { id: 'edit', label: t('app.edit', 'Edit…') },
          { id: 'duplicate', label: t('app.duplicate', 'Duplicate') },
          { id: 'copyHost', label: t('app.copy_host', 'Copy host'), separatorBefore: true },
          { id: 'delete', label: t('app.delete', 'Delete'), danger: true, separatorBefore: true }
        ]
      }
      if (menu.target.kind === 'folder') {
        return [
          { id: 'newSessionHere', label: t('app.new_session_here', 'New session here') },
          { id: 'newFolderHere', label: t('app.new_subfolder', 'New subfolder') },
          { id: 'renameFolder', label: t('app.rename', 'Rename…'), separatorBefore: true },
          { id: 'deleteFolder', label: t('app.delete_folder', 'Delete folder'), danger: true, separatorBefore: true }
        ]
      }
      return [
        { id: 'newFolderRoot', label: t('app.new_folder', 'New folder') },
        { id: 'newSessionRoot', label: t('app.new_session', 'New session') }
      ]
    },
    []
  )

  // ---- deleting groups ----------------------------------------------------

  /**
   * Everything inside a folder, counting downwards.
   *
   * Deleting a folder removes its whole subtree, so the question "does this
   * contain anything?" has to be about the subtree and not just the folder's own
   * children.
   */
  const folderContents = useCallback((folderId: string): { hosts: number; groups: number } => {
    const { folders, sessions } = treeRef.current
    /*
     * Seeded with the folder itself, because a host filed *directly* in it has
     * this id as its parent — collecting only the descendants below it reported
     * "0 hosts" for the most common shape of all, and the group then went without
     * a question.
     */
    const inside = new Set<string>([folderId])
    const stack = [folderId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      for (const child of folders) {
        if (child.parentId === id && !inside.has(child.id)) {
          inside.add(child.id)
          stack.push(child.id)
        }
      }
    }
    return {
      hosts: sessions.filter((s) => s.parentId !== null && inside.has(s.parentId)).length,
      groups: inside.size - 1
    }
  }, [])

  /**
   * Delete a group, asking first when it would take hosts with it.
   *
   * The store deletes a folder together with every host inside it, which is the
   * right behaviour but was never questioned: one mis-click on "Delete folder"
   * threw away a whole client's worth of hosts silently. An empty group is still
   * removed straight away — there is nothing to lose, and a dialog for it is noise.
   */
  const requestDeleteFolder = useCallback(
    (id: string) => {
      const folder = treeRef.current.folders.find((f) => f.id === id)
      const { hosts, groups } = folderContents(id)
      if (hosts === 0) {
        void api.deleteFolder(id)
        return
      }
      setConfirmAction({
        kind: 'delete-folder',
        id,
        name: folder?.name ?? 'This group',
        hosts,
        groups
      })
    },
    [folderContents]
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
        else if (actionId === 'newFolderHere') askFolderName({ kind: 'new-folder', parentId: folder.id })
        else if (actionId === 'renameFolder') askFolderName({ kind: 'rename-folder', id: folder.id })
        else if (actionId === 'deleteFolder') requestDeleteFolder(folder.id)
        return
      }

      if (actionId === 'newFolderRoot') askFolderName({ kind: 'new-folder', parentId: null })
      else if (actionId === 'newSessionRoot') openEditor(null, null)
    },
    [askFolderName, connectSaved, duplicateSession, openEditor, requestDeleteFolder]
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

  /**
   * Re-establish a pane's session, in place.
   *
   * This is the recovery path for a terminal that is still on screen but no
   * longer usable — the common case being an idle SSH connection the server has
   * timed out. A pane that came from a saved session reconnects through the
   * saved entry; anything else is rebuilt by the main process from the options
   * its live session was started with, so an SSH pane reloads as SSH.
   *
   * The old path created a *local* session for every pane that was not a saved
   * entry, which is how "reload" turned an SSH terminal into a PowerShell prompt.
   */
  const reloadPanel = useCallback(
    (panelId: string) => {
      const dockApi = dockApiRef.current
      const panel = dockApi?.getPanel(panelId)
      if (!dockApi || !panel) return

      const params = panel.api.getParameters<TerminalPanelMeta>() ?? {}
      const savedSessionId = params.savedSessionId
      const title = panel.title || params.title || 'Session'
      const previous = liveSessionRef.current.get(panelId) ?? params.session?.id

      const saved = savedSessionId
        ? treeRef.current.sessions.find((s) => s.id === savedSessionId)
        : undefined
      if (saved && !previous) {
        // A restored placeholder: its saved host is the only thing to go on.
        setToast(`Reconnecting “${title}”…`)
        void connectSavedRef.current(saved)
        return
      }

      if (!previous) {
        if (saved) {
          setToast(`Reconnecting “${title}”…`)
          void connectSavedRef.current(saved)
          return
        }
        setAlert({
          message: `“${title}” has no live connection to reload, and no saved host to reconnect to. Open it again from the sidebar.`
        })
        return
      }

      setToast(`Reloading “${title}”…`)
      void api.duplicateSession(previous).then((result) => {
        if (!result.ok) {
          /*
           * Nothing left to duplicate.
           *
           * A dropped link, an exited shell and a session the main process has
           * already forgotten all land here — and this is exactly where people
           * press "Reconnect" on a dead pane. The old code showed the backend's
           * error and stopped, which read as "reconnect failed" with no way
           * forward. Falling back to the saved host is what the click meant.
           */
          if (saved) {
            setToast(`Reconnecting “${title}”…`)
            void connectSavedRef.current(saved)
            return
          }
          setAlert({ message: result.error.message })
          return
        }
        const next = result.session
        // Drop the old backend, keep the pane: removing the panel would lose its
        // position in the arrangement, which is exactly what a reload must not do.
        api.closeSession(previous)
        removeSessionState(previous)
        // The pane keeps its id, so record which session now sits behind it.
        liveSessionRef.current.set(panelId, next.id)
        setSessions((prev) => [...prev.filter((s) => s.id !== previous), next])
        panel.api.updateParameters({
          session: next,
          disconnected: false,
          /*
           * `savedSessionId` deliberately survives a reload. Clearing it here was
           * how a reconnected pane lost the one thing that could reconnect it
           * again: after the next drop there was no saved host left to fall back
           * on, and "Reconnect" could only fail.
           */
          savedSessionId,
          title: next.title
        })
        refreshPanelParams(panel.id)
        panel.api.setTitle(next.title)
        panel.api.setActive()
      })
    },
    [removeSessionState]
  )

  /**
   * Open a second connection to the same host, as its own tab.
   *
   * "Duplicate this channel" rather than "duplicate this tab": the useful thing
   * is another live login to the same box, which then behaves independently.
   *
   * The connection itself is rebuilt by the main process from the options the
   * original session was started with (`session:duplicate`). That is the whole
   * point: it is the only place that knows the credentials. Resolving the host
   * here from the saved-session list — by `savedSessionId`, and failing that by
   * title — was the previous approach, and every connection that was not started
   * from a saved entry (a quick connect, or a pane reconnected after a restart)
   * fell through to *a local shell*, which is what "the copy is not even SSH"
   * looked like.
   */
  const duplicateConnection = useCallback(
    (panelId: string) => {
      const dockApi = dockApiRef.current
      const panel = dockApi?.getPanel(panelId)
      if (!dockApi || !panel) return

      const params = panel.api.getParameters<TerminalPanelMeta>() ?? {}
      const title = panel.title || params.title || 'Session'

      /** Put the new session on screen as its own tab. */
      const open = (session: SessionInfo): void => {
        setSessions((prev) => [...prev, session])
        liveSessionRef.current.set(session.id, session.id)
        dockApi.addPanel({
          id: session.id,
          component: 'terminal',
          title: session.title,
          params: { session, onEnded: (id: string) => endedRef.current(id) }
        })
        // A tab added to an existing group has the same collapse risk as the
        // first connection, so it goes through the same convergence loop.
        settlePanel(session.id)
        setToast(`Opened a second login to “${title}”`)
      }

      if (panel.api.component !== 'terminal') {
        setToast('Nothing to duplicate on the welcome tab.')
        return
      }

      /*
       * The panel id, not the session stored in its parameters.
       *
       * dockview only populates `getParameters()` when `updateParameters()` has
       * been called: a panel added with `addPanel({ params })` hands them to the
       * renderer but reads back as `{}`. Keying off that object is what made the
       * old version always take its local-shell fallback.
       *
       * The panel id *is* the live session id for a connected pane; for a restored
       * placeholder it is a stale one, and the main process rejects it, which is
       * the honest answer for a pane that is not connected.
       */
      const current = liveSessionRef.current.get(panelId) ?? panelId

      setToast(`Opening a second channel to “${title}”…`)
      void api
        .duplicateSession(current)
        .then((result) => {
          if (result.ok) {
            open(result.session)
            return
          }
          setAlert({ message: result.error.message })
        })
        .catch((err) => {
          setAlert({ message: err instanceof Error ? err.message : String(err) })
        })
    },
    [settlePanel]
  )

  /**
   * Double-clicking a tab opens a second connection to the same host.
   *
   * Same lookup as the context menu: dockview has no tab double-click event, but
   * every tab element carries `data-tab-panel-id`. Only the tab strip matches, so
   * a double-click in the terminal still selects a word as usual.
   *
   * Declared after `duplicateConnection` because it closes over it.
   */
  const onDockDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      const tab = target.closest('[data-tab-panel-id]')
      if (!tab) return
      const panelId = tab.getAttribute('data-tab-panel-id')
      if (!panelId) return
      // The tab's close button is inside the tab; a double-click there is a
      // double close, not a duplicate.
      if (target.closest('.dv-default-tab-action')) return
      e.preventDefault()
      e.stopPropagation()
      duplicateConnection(panelId)
    },
    [duplicateConnection]
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
      {
        id: 'tilePanes',
        label: t('app.arrange_panes', 'Arrange panes…'),
        hint: t('app.tile_every_window', 'tile / split every window'),
        separatorBefore: true
      },
      {
        id: 'duplicateConnection',
        label: t('app.duplicate_connection', 'Duplicate connection'),
        hint: t('app.same_host_new_tab', 'same host, new tab'),
      },
      {
        id: 'reload',
        label: t('app.reload_reconnect', 'Reload / reconnect'),
        hint: t('app.fresh_session', 'fresh session'),
      },
      { id: 'copyTitle', label: t('app.copy_tab_name', 'Copy tab name'), separatorBefore: true },
      { id: 'copyText', label: t('app.copy_all_output', 'Copy all output') },
      { id: 'saveText', label: t('app.save_output_to_file', 'Save output to file…') },
      {
        id: 'toggleTimestamps',
        label: settings.terminal.showTimestamps ? 'Hide timestamps' : 'Show timestamps',
        hint: settings.terminal.showTimestamps ? 'on' : 'off',
        separatorBefore: true
      },
      { id: 'close', label: t('app.close', 'Close'), separatorBefore: true, disabled: closable.length === 0 },
      {
        id: 'closeOthers',
        label: t('app.close_other_tabs', 'Close other tabs'),
        disabled: closable.filter((p) => p.id !== tabMenu.panelId).length === 0
      },
      {
        id: 'closeRight',
        label: t('app.close_tabs_to_the_right', 'Close tabs to the right'),
        disabled: index < 0 || index >= panels.length - 1
      },
      { id: 'closeAll', label: t('app.close_all_tabs', 'Close all tabs'), danger: true, separatorBefore: true }
    ]
  }, [tabMenu, settings.terminal.showTimestamps])

  /**
   * Open the "arrange panes" dialog, with the panes as they are right now.
   *
   * Read from the dock rather than from React state: the order of `api.panels` is
   * the order they appear in the layout, which is the order the user sees, and that
   * is the order the arrangement should preserve.
   */
  const openTileDialog = useCallback(() => {
    const dockApi = dockApiRef.current
    if (!dockApi) return
    setTilePanes(dockApi.panels.map((panel) => ({ id: panel.id, title: panel.title || panel.id })))
  }, [])

  /** Apply the chosen arrangement, then close the dialog. */
  const applyTile = useCallback((ids: string[], mode: TileMode, keepIds: string[]) => {
    const dockApi = dockApiRef.current
    setTilePanes(null)
    if (!dockApi) return
    tilePanels(dockApi, ids, mode, dockRef.current, keepIds)
    setToast(
      mode === 'grid'
        ? t('app.tiled_grid', 'Tiled {count} panes', { count: ids.length })
        : mode === 'columns'
          ? t('app.tiled_columns', 'Split into {count} columns', { count: ids.length })
          : t('app.tiled_rows', 'Split into {count} rows', { count: ids.length })
    )
  }, [])

  const runTabAction = useCallback(
    (actionId: string) => {
      if (!tabMenu) return
      const dockApi = dockApiRef.current
      const panel = dockApi?.getPanel(tabMenu.panelId)
      const group = panel?.group
      const panels = group ? group.panels : []
      const index = panels.findIndex((p) => p.id === tabMenu.panelId)

      if (actionId === 'tilePanes') {
        openTileDialog()
        return
      }
      if (actionId === 'duplicateConnection') {
        duplicateConnection(tabMenu.panelId)
        return
      }
      if (actionId === 'reload') {
        reloadPanel(tabMenu.panelId)
        return
      }
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
    [tabMenu, closePanels, copyPanelOutput, savePanelOutput, settings, reloadPanel, duplicateConnection]
  )

  // ---- shortcuts ----------------------------------------------------------

  /**
   * Step the interface scale up or down, on the same ladder the settings picker
   * offers, and remember it: a zoom that vanishes on restart is a mystery.
   */
  const zoomBy = useCallback(
    (direction: 1 | -1) => {
      const current = settingsRef.current.uiScale
      const next = stepScale(current, direction)
      if (next === current) {
        setToast(`Interface is already at ${Math.round(current * 100)}%.`)
        return
      }
      void api
        .saveSettings({ ...settingsRef.current, uiScale: next })
        .then(setSettings)
        .catch(() => {
          /* keeping the old scale is the safe outcome */
        })
      applyUiScale(next)
      setToast(`Interface ${Math.round(next * 100)}%`)
    },
    [applyUiScale]
  )

  /**
   * Bring a pane to the front, keeping the keyboard where it was working.
   *
   * dockview hides the pane that was active, and a hidden element cannot hold
   * focus — the browser drops it on `body`. Switching by keyboard is a keyboard
   * gesture, so the next keystroke would land nowhere at all: the session would
   * change and then nothing you typed would reach it.
   *
   * Only when the keyboard was already in a terminal, though. `Alt`+`[` while a
   * settings field has focus must not yank the caret into a pane behind it.
   */
  const activatePanel = useCallback((id: string) => {
    const panel = dockApiRef.current?.getPanel(id)
    if (!panel) return
    const fromTerminal = document.activeElement instanceof HTMLElement &&
      document.activeElement.classList.contains('xterm-helper-textarea')
    panel.api.setActive()
    if (fromTerminal) getTerminal(id)?.focus()
  }, [])

  const cycleTab = useCallback(
    (delta: number) => {
      const dockApi = dockApiRef.current
      if (!dockApi) return
      const group = dockApi.activeGroup
      if (!group) return
      const panels = group.panels
      if (panels.length < 2) return
      const index = panels.findIndex((p) => p.id === dockApi.activePanel?.id)
      const next = panels[(index + delta + panels.length) % panels.length]
      if (next) activatePanel(next.id)
    },
    [activatePanel]
  )

  /**
   * Every open session pane, in layout order.
   *
   * `Ctrl+Tab` walks the tabs of one group; this walks *all* of them, which is
   * what "switch session" has to mean once the arrangement is split into groups —
   * otherwise half the sessions are unreachable by keyboard.
   */
  const openPanels = useCallback((): string[] => {
    const dockApi = dockApiRef.current
    if (!dockApi) return []
    return dockApi.panels.filter((p) => p.id !== 'welcome').map((p) => p.id)
  }, [])

  /**
   * `Alt+[` / `Alt+]`: previous/next session, wrapping at both ends.
   *
   * With no session in front (the welcome pane) it goes to the first one forwards
   * and the last one backwards, so the first press always lands somewhere real.
   */
  const stepSession = useCallback(
    (delta: number) => {
      const dockApi = dockApiRef.current
      if (!dockApi) return
      const panels = openPanels()
      if (panels.length === 0) return
      const index = panels.indexOf(dockApi.activePanel?.id ?? '')
      const from = index < 0 ? (delta > 0 ? -1 : 0) : index
      const next = panels[(from + delta + panels.length) % panels.length]
      if (next) activatePanel(next)
    },
    [activatePanel, openPanels]
  )

  /** `Alt`+digit: the Nth open session, in the order they are laid out. */
  const jumpToSession = useCallback(
    (index: number) => {
      const target = openPanels()[index]
      if (target) activatePanel(target)
    },
    [activatePanel, openPanels]
  )

  /**
   * Show a rail section.
   *
   * The same path the rail's own icons take, so a shortcut and a click can never
   * disagree about what "Terminal" means — including the rule that selecting the
   * section you are already on toggles its drawer.
   */
  const selectPage = useCallback(
    (next: PageId) => {
      // Settings is drawer-only: it has no page of its own, so selecting it opens
      // the drawer over whatever page is showing.
      if (next === 'settings') {
        setSettingsOpen(true)
        return
      }
      setSettingsOpen(false)
      /*
       * Clicking the page you are already on toggles the column, like the rail
       * switch and `Ctrl`+`B`.
       *
       * It was made "reveal only" for a while, after a fresh install looked like it
       * had lost its sidebar — clicking "Terminal" while already on Terminal
       * collapsed it. The real problem was that the first run *started* collapsed;
       * that is fixed where the welcome screen finishes, so the gesture can do what
       * people expect again.
       */
      if (next === page) {
        setRailCollapsed((collapsed) => !collapsed)
        return
      }
      setPage(next)
      setRailCollapsed(false)
    },
    [page]
  )

  /**
   * `Alt`+digit jumps straight to a session.
   *
   * Deliberately not nine settings rows: the number is the pane's position in the
   * arrangement, which is something to match rather than to configure. The two
   * configurable bindings below walk the same list.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      const digit = Number(event.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
      event.preventDefault()
      event.stopPropagation()
      jumpToSession(digit - 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jumpToSession])

  /**
   * Terminal font size, one step at a time — `Ctrl`+`=` / `Ctrl`+`-`.
   *
   * Only the text inside the sessions: it writes `terminal.fontSize`, which every
   * pane applies live, and touches nothing else. The interface scale is a separate
   * gesture (`Ctrl`+`Shift`+`=` / `-`) because scaling the *window* is a different
   * intent from making a shell's output readable, and doing both at once meant the
   * tab bar, drawer and dialogs shrank whenever you wanted bigger terminal text.
   */
  const nudgeTerminalFont = useCallback((direction: 1 | -1) => {
    const current = settingsRef.current.terminal.fontSize
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + direction))
    if (next === current) {
      setToast(
        t('app.terminal_font_at_limit', 'Terminal font is already {size}px.', { size: current })
      )
      return
    }
    void api
      .saveSettings({ ...settingsRef.current, terminal: { ...settingsRef.current.terminal, fontSize: next } })
      .then(setSettings)
      .catch(() => {
        /* keeping the current size is the safe outcome */
      })
    setToast(t('app.terminal_font_size', 'Terminal font {size}px', { size: next }))
  }, [])

  /**
   * Interface zoom: `Ctrl`+`Shift`+`=` / `-`, plus the aliases every keyboard has.
   *
   * The configured bindings are consulted first and skipped here, so a press that
   * the shortcut table already handled cannot be counted twice. What is left is
   * what a chord cannot express: `Ctrl+Shift+=` (how you actually type a `+` on a
   * US layout) and the numpad keys, which is what people reach for anyway.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || !(event.ctrlKey || event.metaKey)) return

      const bindings = settingsRef.current.keybindings
      const bound = (id: string): string => bindings.find((b) => b.id === id)?.keys ?? ''
      // Any configured binding wins: the terminal-font pair first, then the scale
      // pair, so neither the text size nor the window is changed twice per press.
      for (const id of ['zoomIn', 'zoomOut', 'scaleUp', 'scaleDown']) {
        const keys = bound(id)
        if (keys && matchesBinding(event, keys)) return
      }

      const key = event.key
      if (key === '+' || key === '=' || key === 'Add') {
        event.preventDefault()
        zoomBy(1)
      } else if (key === '-' || key === '_' || key === 'Subtract') {
        event.preventDefault()
        zoomBy(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoomBy])

  useShortcuts(settings.keybindings, {
    newConnection: () => setDialogOpen(true),
    closeSession: () => {
      const active = dockApiRef.current?.activePanel
      if (active && active.id !== 'welcome') closeSession(active.id)
    },
    closeDeadPane: () => {
      const active = dockApiRef.current?.activePanel
      if (!active || active.id === 'welcome') return false
      if (!isPaneDead(active.id)) return false
      closeSession(active.id)
    },
    openSettings: () => setSettingsOpen(true),
    toggleSidebar: () => setRailCollapsed((v) => !v),
    openConnections: () => setConnectionsOpen(true),
    toggleSnippets: () => setSnippetBarVisible((v) => !v),
    toggleBroadcast: () => setBroadcasting(toggleBroadcasting()),
    tilePanes: () => openTileDialog(),
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
    prevTab: () => cycleTab(-1),
    prevPage: () => stepSession(-1),
    nextPage: () => stepSession(1),
    zoomIn: () => nudgeTerminalFont(1),
    zoomOut: () => nudgeTerminalFont(-1),
    scaleUp: () => zoomBy(1),
    scaleDown: () => zoomBy(-1),
    toggleFocus,
    lockApp: lockNow,
    quitApp: requestQuit
  })

  const platformLabel = useMemo(
    () => (appMeta ? `${appMeta.platform} · Electron ${appMeta.versions.electron}` : ''),
    [appMeta]
  )

  return (
    <div
      className={
        'td-root' + (focusMode ? ' is-focus' : '') + (layoutGesture ? ' is-layout-gesture' : '')
      }
      /*
       * Docking is answered at the window, not at the drawer: the pointer during a
       * real drag is out over the workspace, which is not inside the `<aside>`.
       * Both the grip and a section heading can start the gesture, so both states
       * count as "a dock is in flight" here.
       */
      onDragOver={onDrawerDragOver}
      onDrop={onDrawerDrop}
    >
      {/*
        Focus mode hides the rail and the drawer outright rather than dimming
        them: the panes get the whole window, which is the entire point of it.
        F11 (or whatever the binding is) brings them back.
      */}
      {!focusMode && (
      <NavRail
        active={page}
        collapsed={railCollapsed}
        ready={layoutReady}
        onToggleCollapsed={() => setRailCollapsed((v) => !v)}
        onSelect={selectPage}
        badges={{ terminal: sessions.length }}
        appInfo={appMeta}
        settingsOpen={settingsOpen}
      />
      )}

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
          view={hostsView}
          onViewChange={setHostsView}
          /*
           * Connecting from Hosts switches to Terminal first. The connection's
           * pane lives in the workspace, so staying on Hosts would open a session
           * the user cannot see and has to go looking for.
           */
          onConnect={(s) => {
            setPage('terminal')
            void connectSaved(s)
          }}
          onEdit={(s) => openEditor(s, s.parentId)}
          onDelete={(id) => void api.deleteSession(id)}
          onDuplicate={(s) => void duplicateSession(s)}
          onNewHost={(parentId) => openEditor(null, parentId)}
          onCreateGroup={(parentId) => askFolderName({ kind: 'new-folder', parentId })}
          onRenameGroup={(id) => askFolderName({ kind: 'rename-folder', id })}
          onDeleteGroup={(id) => requestDeleteFolder(id)}
          onMove={(sessionId, parentId) => void moveSessionTo(sessionId, parentId)}
          onMoveGroup={(folderId, parentId) => void moveFolderTo(folderId, parentId)}
          onExportShare={() => setShareMode('export')}
          onImportShare={() => setShareMode('import')}
        />
      )}

      {/*
        The rail's list drawer. It is part of the same column as the rail rather
        than a separate one, and shrinks away entirely when the rail is collapsed
        so the window reads as "icons, or icons + list".

        Only the Terminal page has it. Hosts, Known Hosts and Snippets each render
        their own full-page list, so the drawer beside them is a second, narrower
        copy of what is already on screen — and on Hosts it also carried Connect
        and Local shell, which belong to the terminal workflow rather than to a
        host manager.
      */}
      {!railCollapsed && page === 'terminal' && (
        <aside
          className={'td-sidebar' + (settings.sidebar.side === 'right' ? ' is-right' : '')}
          /*
           * `sidebar`, not `drawer`: the Drawer component (quick connect, editors,
           * settings) is `data-testid="drawer"`, and two elements answering to the
           * same name broke every probe that looks for those dialogs — the sidebar
           * matched first and the dialog was reported missing.
           */
          data-testid="sidebar"
          data-side={settings.sidebar.side}
          style={{ width: drawerWidth, flexBasis: drawerWidth }}
        >
          {/*
            The sections scroll; the footer below them does not. That is the point
            of the wrapper: with four sections open the icons used to be pushed
            past the bottom of the drawer and out of reach.
          */}
          <div className="td-sidebar-sections">
            {/*
              The sections are the user's: drag a heading to reorder, fold it with
              the triangle, drag its bottom edge to size it, right-click it to hide
              it or bring a hidden one back. `settings.sidebar.sections` keeps the
              order *including* hidden ones, so hiding a section never loses where
              the user had put it.

              The Connect / Local shell row that used to sit here is gone: it took
              the first thing you saw in the drawer to offer two actions that live
              in the footer icons now.
            */}
            {visibleSections.map((section) => (
              <SectionFrame
                key={section.id}
                id={section.id}
                title={t('sidertab.' + section.id, SIDEBAR_SECTION_LABELS[section.id])}
              testId={`section-${section.id}`}
              collapsed={section.collapsed === true}
              height={section.height}
              onToggleCollapsed={(id) => patchSection(id, { collapsed: !section.collapsed })}
              onResize={(id, height) => patchSection(id, { height: height > 0 ? height : undefined })}
              dragging={draggingSection}
              onDragStart={(id) => {
                draggingSectionRef.current = id
                setDraggingSection(id)
              }}
              onDropOn={(id) => {
                const from = draggingSectionRef.current
                draggingSectionRef.current = null
                setDraggingSection(null)
                if (from) moveSection(from, id)
              }}
              onDragEnd={() => {
                draggingSectionRef.current = null
                setDraggingSection(null)
                // The dock hint follows any drag that could dock the drawer.
                setDrawerDropHint(null)
              }}
              onContextMenu={(id, x, y) => setSectionMenu({ id, x, y })}
              actions={
                section.id === 'sessions' ? (
                  <>
                    <button
                      className="td-mini"
                      title="New session"
                      data-testid="tree-new-session"
                      onClick={() => openEditor(null, null)}
                    >
                      +
                    </button>
                    <button
                      className="td-mini"
                      title="New folder"
                      data-testid="tree-new-folder"
                      onClick={() => askFolderName({ kind: 'new-folder', parentId: null })}
                    >
                      ⊞
                    </button>
                  </>
                ) : section.id === 'history' ? (
                  <button
                    className="td-mini"
                    title="Clear history"
                    data-testid="history-clear"
                    onClick={clearHistory}
                  >
                    ⌫
                  </button>
                ) : null
              }
            >
              {section.id === 'sessions' && (
                <SessionTree
                  showHeader={false}
                  tree={tree}
                  activeSessionId={activePanelId}
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
                  onCreateFolder={(parentId) => askFolderName({ kind: 'new-folder', parentId })}
                  onRenameFolder={(id) => askFolderName({ kind: 'rename-folder', id })}
                  onDeleteFolder={(id) => requestDeleteFolder(id)}
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
              )}

              {section.id === 'openSessions' && (
                <ul className="td-session-list">
                  {sessions.length === 0 && (
                    <li className="td-session-empty">
                      {t('app.none_yet_double_click_a_save', 'None yet — double-click a saved session to connect.')}
                    </li>
                  )}
                  {sessions.map((s) => (
                    <li key={s.id} className="td-session-item">
                      <button
                        className="td-session-open"
                        onClick={() =>
                          dockApiRef.current?.getPanel(resolvePanelId(s.id))?.api.setActive()
                        }
                      >
                        <span className={`td-dot td-dot-${s.kind}`} />
                        <span className="td-session-title" title={s.title}>
                          {s.title}
                        </span>
                      </button>
                      <button
                        className="td-session-close"
                        title={t('app.close_session', 'Close session')}
                        onClick={() => closeSession(s.id)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {section.id === 'history' && (
                <HistoryPanel
                  sessionId={historySessionId}
                  sessions={historySessions}
                  entries={historyEntries}
                  canSend={activeTerminalId() !== null}
                  onPick={setHistoryPick}
                  onSend={sendHistory}
                  onDelete={deleteHistoryEntry}
                />
              )}

              {section.id === 'sftp' && (
                <SftpPanel
                  sessionId={activeSshSessionId}
                  onToast={setToast}
                  onError={(message) => setAlert({ message })}
                />
              )}
            </SectionFrame>
          ))}
          </div>

          {/*
            The drawer's own actions, pinned to the bottom of the drawer rather
            than scrolling away with the sections. The grip is how the whole drawer
            is moved to the other edge of the window.
          */}
          <div className="td-sidebar-footer">
            {/*
              * Broadcast, timestamps and arrange live down here.
              *
              * They were floating over the panes (top-right), where they covered the
              * first lines of output. The drawer footer is where the other per-session
              * controls already are, and it is never over the terminal text.
              */}
            <button
              className={`td-icon-btn${broadcasting ? ' is-on' : ''}`}
              title={
                broadcasting
                  ? `Typing goes to all ${panelCount} panes — ${broadcastSummary()}. Click to send to the focused pane only.`
                  : `Broadcast input: send typing to all ${panelCount} panes at once`
              }
              data-testid="toggle-broadcast"
              aria-pressed={broadcasting}
              onClick={() => setBroadcasting(toggleBroadcasting())}
            >
              ⇶
            </button>
            <button
              className={`td-icon-btn${settings.terminal.showTimestamps ? ' is-on' : ''}`}
              title={t('app.toggle_timestamps', 'Show a timestamp column in every pane')}
              data-testid="toggle-timestamps"
              aria-pressed={settings.terminal.showTimestamps}
              onClick={() => {
                const next = !settings.terminal.showTimestamps
                void api
                  .saveSettings({
                    ...settings,
                    terminal: { ...settings.terminal, showTimestamps: next }
                  })
                  .then(setSettings)
              }}
            >
              ⏱
            </button>
            <button
              className="td-icon-btn"
              title={t('app.arrange_panes_hint2', 'Arrange panes (tile, columns, rows)')}
              data-testid="arrange-panes"
              onClick={() => openTileDialog()}
            >
              ▦
            </button>
            <button
              className="td-icon-btn"
              title={t('app.new_connection_ctrl_t', 'New connection (Ctrl+T)')}
              data-testid="new-connection"
              onClick={() => setDialogOpen(true)}
            >
              ＋
            </button>
            <button
              className="td-icon-btn"
              title={
                appMeta && !appMeta.localShellAvailable
                  ? 'Local shell needs @lydell/node-pty for this platform'
                  : 'Open a local shell'
              }
              data-testid="local-shell"
              disabled={!appMeta?.localShellAvailable}
              onClick={() =>
                void api.createLocalSession({}).then((r) => {
                  if (r.ok) addSession(r.session)
                  else setAlert({ message: r.error.message })
                })
              }
            >
              {t('app.gt', '&gt;_')}
            </button>
            <button
              className="td-icon-btn"
              title={t('app.connections_window', 'Connections window')}
              data-testid="open-connections"
              onClick={() => setConnectionsOpen(true)}
            >
              ⧉
              {sessions.length > 0 && <span className="td-badge">{sessions.length}</span>}
            </button>
            <button
              className="td-icon-btn"
              title={t('app.snippet_bar', 'Snippet bar')}
              data-testid="toggle-snippets"
              onClick={() => setSnippetBarVisible((v) => !v)}
            >
              ⌨
            </button>
            <button
              className="td-icon-btn"
              title={t('app.settings', 'Settings')}
              data-testid="open-settings"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>

            {/*
              The pomodoro chip lives here because this is where your eye already
              is: it shows which half of the cycle is running and how long is left,
              and it is the only place the cycle is visible without the bar.
            */}
            {settings.break.enabled && settings.break.mode === 'pomodoro' && (
              <WellnessChip
                phase={wellness.phase}
                endsAt={wellness.endsAt}
                round={settings.break.minutes}
                title={t('app.pomodoro_click_for_the_setti', 'Pomodoro — click for the settings')}
                onClick={() => setSettingsOpen(true)}
              />
            )}

            {/*
              The grip: drag it onto the other half of the window and the whole
              drawer moves to that edge.
            */}
            <span
              className="td-drawer-grip"
              data-testid="drawer-grip"
              draggable
              title={t('app.drag_to_the_other_edge_to_mo', 'Drag to the other edge to move the whole drawer · double-click to swap sides')}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', 'drawer')
                setDraggingDrawer(true)
              }}
              onDragEnd={() => {
                setDraggingDrawer(false)
                setDrawerDropHint(null)
              }}
              onDoubleClick={flipDrawer}
            >
              ⠿
            </span>
            <span>{platformLabel}</span>
          </div>

          {/* Drag the inner edge to set the drawer's width. */}
          <div
            className="td-sidebar-resize"
            data-testid="drawer-resize"
            title={t('app.drag_to_resize_the_drawer', 'Drag to resize the drawer')}
            onPointerDown={startDrawerResize}
          />

          {/*
            Which edge the drawer would land on, while it is being dragged there.
            Two lanes rather than a free-floating drop: there are only two places
            the drawer can be. A section heading can start the same gesture, so
            either drag shows it.
          */}
          {(draggingDrawer || draggingSection !== null) && (
            <div
              className={`td-drawer-hint is-${drawerDropHint ?? settings.sidebar.side}`}
              aria-hidden="true"
            />
          )}
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
        {/*
          The break nudge sits *in* the layout, above the panes, rather than over
          them: it has to be ignorable, and it must not take the keyboard away.
        */}
        {breakBar && (
          <BreakBar
            kind={breakBar.kind}
            minutes={breakBar.minutes}
            endsAt={wellness.phase === 'break' ? wellness.endsAt : 0}
            snoozeMinutes={settings.break.snoozeMinutes}
            onTakeBreak={() => takeBreak('break')}
            onTakeBreakAndLock={() => takeBreak('lock')}
            onSnooze={snoozeBreak}
            onEndBreak={endPomodoroBreak}
            onDismiss={dismissBreak}
          />
        )}
        {/*
          Broadcast lives over the terminal itself rather than in the sidebar.
          It is a property of the workspace — how many panes a keystroke reaches —
          so it belongs with the panes, and it only appears once there is more than
          one to send to.
        */}
        {panelCount > 1 && !focusMode && (
          <div className="td-terminal-tools" data-testid="terminal-tools">
            {/*
              No count on the label: the button sits over the panes it talks about,
              so "all 3" was telling the reader something the screen already said.
              The number is still in the tooltip, which is where a detail belongs.
            */}
            
          </div>
        )}
        <main className="td-main">
          <div
            className="td-dockview dockview-theme-abyss"
            ref={dockRef}
            onContextMenu={onDockContextMenu}
            onDoubleClick={onDockDoubleClick}
          />
        </main>

        {/* Bottom bar of saved commands; hidden until the user shows it again. */}
        {snippetBarVisible && !focusMode && (
          <SnippetBar
            snippets={settings.snippets}
            canSend={activeTerminalId() !== null}
            onSend={sendSnippet}
            onEdit={(snippet) => setSnippetEditor({ snippet, group: snippet.group })}
            onNew={(group) => setSnippetEditor({ snippet: null, group })}
            onDelete={(id) => void deleteSnippet(id)}
            onSetGroup={(id, group) => void setSnippetGroup(id, group)}
            onReorder={(ids) => void api.reorderSnippets(ids).then(setSettings)}
            onHide={() => setSnippetBarVisible(false)}
          />
        )}

        {!snippetBarVisible && !focusMode && (
          <button
            className="td-snippet-restore"
            title={t('app.show_snippet_bar', 'Show snippet bar')}
            onClick={() => setSnippetBarVisible(true)}
          >
            ⌃
          </button>
        )}
      </div>

      {/* The drawer section menu: hide a section, or bring one back. */}
      {sectionMenu && (
        <ContextMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          items={sectionMenuItems}
          testId="section-menu"
          onSelect={runSectionAction}
          onClose={() => setSectionMenu(null)}
        />
      )}

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
            existing={tree.sessions}
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
        title={t('app.settings_2', 'Settings')}
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
          onExportShare={() => {
            setSettingsOpen(false)
            setShareMode('export')
          }}
          onImportShare={() => {
            setSettingsOpen(false)
            setShareMode('import')
          }}
          onCredentialChanged={(status) => {
            setCredentialStatus(status)
            void refreshCredentials()
          }}
          lockStatus={lockStatus ?? { hasPassword: false }}
          onLockChanged={setLockStatus}
          onPreviewBreak={() => {
            // Shown straight away, without waiting for the idle gate: this button
            // exists to see what the nudge looks like, and the settings drawer is
            // in the way of it.
            setSettingsOpen(false)
            breakDueRef.current = true
            breakBarRef.current = true
            setBreakBar({ kind: 'reminder', minutes: settings.break.minutes })
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
          title={t('app.connections', 'Connections')}
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
            <strong>{t('app.connection_failed', 'Connection failed')}</strong>
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
                {t('app.enter_password', 'Enter password')}
              </button>
            )}
            <button className="td-btn td-btn-sm" onClick={() => setAlert(null)}>
              {t('app.dismiss', 'Dismiss')}
            </button>
          </div>
        </div>
      )}

      {namePrompt && (
        <NamePrompt
          title={namePrompt.kind === 'new-folder' ? 'New group' : 'Rename group'}
          label={t('app.group_name', 'Group name')}
          initialValue={namePrompt.kind === 'rename-folder' ? namePrompt.name : ''}
          placeholder={namePrompt.kind === 'new-folder' ? 'e.g. client' : undefined}
          confirmLabel={namePrompt.kind === 'new-folder' ? 'Create' : 'Rename'}
          onCancel={() => setNamePrompt(null)}
          onSubmit={submitFolderName}
        />
      )}

      {/*
        Import and export share one dialog: they are the two ends of the same
        conversation, and the shell already owns the toast the result is reported in.
      */}
      {shareMode && (
        <ShareDialog
          mode={shareMode}
          onClose={() => setShareMode(null)}
          onMessage={(message) => setToast(message)}
        />
      )}

      {confirmAction?.kind === 'delete-folder' && (
        <ConfirmDialog
          title={t('app.delete_group', 'Delete group?')}
          danger
          testId="confirm-delete-folder"
          confirmLabel={
            confirmAction.hosts === 1 ? 'Delete 1 host' : `Delete ${confirmAction.hosts} hosts`
          }
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            const { id } = confirmAction
            setConfirmAction(null)
            void api.deleteFolder(id)
          }}
        >
          <p className="td-quit-text" data-testid="confirm-delete-folder-detail">
            “{confirmAction.name}{t('app.still_holds', '” still holds')}{confirmAction.hosts} host
            {confirmAction.hosts === 1 ? '' : 's'}
            {confirmAction.groups > 0
              ? ` across ${confirmAction.groups} sub-group${confirmAction.groups === 1 ? '' : 's'}`
              : ''}
            .
          </p>
          <p className="td-hint">
            {t('app.deleting_a_group_deletes_the', 'Deleting a group deletes the hosts inside it. This cannot be undone.')}
          </p>
        </ConfirmDialog>
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

      {tilePanes && (
        <TileDialog
          panes={tilePanes}
          onCancel={() => setTilePanes(null)}
          onApply={applyTile}
        />
      )}

      {quitRequest && (
        <QuitConfirmDialog
          sessions={quitRequest.sessions}
          onCancel={() => setQuitRequest(null)}
          onConfirm={() => {
            // Main holds the close until this arrives; the dialog must not
            // linger if the quit is somehow refused.
            setQuitRequest(null)
            api.quitApp()
          }}
        />
      )}

      {/*
        Last, so it covers everything: dialogs, drawers and the panes themselves.
        The sessions behind it keep running — this hides the screen, it does not
        suspend anything.
      */}
      {locked && (
        <LockScreen hasPassword={lockStatus?.hasPassword ?? false} onUnlock={unlock} />
      )}

      {toast && (
        <div className="td-toast" onMouseDown={() => setToast(null)}>
          {toast}
        </div>
      )}

      {/*
        First run. Rendered *over* the shell rather than instead of it, so every ref
        the rest of this component depends on still exists while it is up — the
        welcome is about settings the shell has not needed yet, not about a second
        start-up path. It covers the window, and the only thing behind it that could
        be seen is the default arrangement.
      */}
      {!settings.onboarded && (
        <WelcomeScreen
          settings={settings}
          onDone={(next) => {
            /*
             * The shell is left with its rail expanded. A profile carried over from
             * an older install can have it collapsed to icons, and the first thing
             * the user sees after this screen should be the whole window.
             */
            setRailCollapsed(false)
            setSettings(next)
          }}
        />
      )}
    </div>
  )
}

function folderName(tree: Tree, id: string): string {
  return tree.folders.find((f) => f.id === id)?.name ?? ''
}
