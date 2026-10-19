import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type * as React from 'react'
import type { DockviewApi } from 'dockview'

import type {
  AppSettings,
  SavedSession,
  SessionInfo,
  SessionTree,
  TerminalPanelMeta
} from '@shared/types'
import { refreshPanelParams } from './ReactRenderer'
import { tilePanels, type TileMode } from './tile'
import type { MenuItem } from './ContextMenu'
import type { TabMenuState } from './SessionTree'
import { t } from '../i18n'

const api = window.termdeck

/**
 * Everything the pane-tab context menu needs, handed over by the shell.
 *
 * Moved out of `App` whole: this is the one place that knows how to reload a
 * pane in place, duplicate a connection, close a range of tabs and build the
 * menu those actions live in. The shell still owns the state and the dock; this
 * owns the decisions.
 */
interface TabMenuDeps {
  dockApiRef: RefObject<DockviewApi | null>
  dockRef: RefObject<HTMLDivElement | null>
  tabMenu: TabMenuState | null
  setTabMenu: Dispatch<SetStateAction<TabMenuState | null>>
  settings: AppSettings
  setSettings: Dispatch<SetStateAction<AppSettings>>
  treeRef: RefObject<SessionTree>
  liveSessionRef: RefObject<Map<string, string>>
  connectSavedRef: RefObject<(session: SavedSession, password?: string) => Promise<void>>
  endedRef: RefObject<(sessionId: string) => void>
  closeSession: (sessionId: string) => void
  removeSessionState: (sessionId: string) => void
  settlePanel: (panelId: string) => void
  copyPanelOutput: (panelId: string, title: string) => Promise<void>
  savePanelOutput: (panelId: string, title: string) => Promise<void>
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>
  setToast: (message: string) => void
  setAlert: (alert: { message: string; code?: string; sessionId?: string } | null) => void
  setTilePanes: Dispatch<SetStateAction<{ id: string; title: string }[] | null>>
}

export function useTabMenu({
  dockApiRef,
  dockRef,
  tabMenu,
  setTabMenu,
  settings,
  setSettings,
  treeRef,
  liveSessionRef,
  connectSavedRef,
  endedRef,
  closeSession,
  removeSessionState,
  settlePanel,
  copyPanelOutput,
  savePanelOutput,
  setSessions,
  setToast,
  setAlert,
  setTilePanes
}: TabMenuDeps) {
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
  return {
    onDockContextMenu,
    onDockDoubleClick,
    tabMenuItems,
    runTabAction,
    openTileDialog,
    applyTile
  }
}