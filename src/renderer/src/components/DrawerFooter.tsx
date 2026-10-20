import { useState, type FormEvent, type JSX, type PointerEvent } from 'react'

import type { SidebarSide, Snippet } from '@shared/types'
import { WellnessChip } from './WellnessChip'
import { t } from '../i18n'

interface DrawerFooterProps {
  broadcasting: boolean
  /** Panes the broadcast would reach, for the tooltip. */
  panelCount: number
  /** Human summary of the same, also only used in the tooltip. */
  broadcastSummary: string
  onToggleBroadcast: () => void
  /** Saved snippets offered as one-click scripts while broadcasting. */
  snippets: Snippet[]
  /** Write a script to every pane. Returns how many took it. */
  onSendScript: (text: string) => number
  showTimestamps: boolean
  onToggleTimestamps: () => void
  onArrange: () => void
  onNewConnection: () => void
  onLocalShell: () => void
  /** Null when the app metadata has not arrived yet (same as "not available"). */
  localShellAvailable: boolean | null
  sessionCount: number
  onOpenConnections: () => void
  onToggleSnippets: () => void
  onOpenSettings: () => void
  /** The pomodoro chip, or null when the mode is off / a plain reminder. */
  chip: { phase: 'work' | 'break'; endsAt: number; round: number } | null
  side: SidebarSide
  /** Which edge the drawer would land on while it is being dragged there. */
  dropHint: SidebarSide | null
  /** True while the whole drawer is being dragged (the grip). */
  draggingDrawer: boolean
  /** True while a section heading is being dragged, which shows the same hint. */
  draggingSection: boolean
  onGripDragStart: () => void
  onGripDragEnd: () => void
  onFlip: () => void
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void
  platformLabel: string
}

/**
 * Everything pinned to the bottom of the drawer.
 *
 * The per-session switches used to float over the panes at top-right, where they
 * covered the first lines of output; the drawer footer is where the other
 * per-session controls already live and it is never over the terminal text.
 *
 * The grip and the resize handle are part of this block rather than of the
 * `<aside>` because they are positioned against the drawer's own edges — moving
 * the whole bottom strip as one keeps that geometry in one place.
 */
export function DrawerFooter({
  broadcasting,
  panelCount,
  broadcastSummary,
  onToggleBroadcast,
  snippets,
  onSendScript,
  showTimestamps,
  onToggleTimestamps,
  onArrange,
  onNewConnection,
  onLocalShell,
  localShellAvailable,
  sessionCount,
  onOpenConnections,
  onToggleSnippets,
  onOpenSettings,
  chip,
  side,
  dropHint,
  draggingDrawer,
  draggingSection,
  onGripDragStart,
  onGripDragEnd,
  onFlip,
  onResizeStart,
  platformLabel
}: DrawerFooterProps): JSX.Element {
  /*
   * The quick script: a command, or a whole script, typed once and sent to every
   * pane. Broadcast already carries keystrokes; this is for the case broadcast was
   * invented for — three shells that each need the same three lines — without
   * having to type it into one pane and watch the others take it character by
   * character.
   */
  const [script, setScript] = useState('')
  const [sent, setSent] = useState('')

  const submitScript = (event: FormEvent): void => {
    event.preventDefault()
    const reached = onSendScript(script)
    setSent(
      reached === 0
        ? t('appscript.nothing_open', 'No pane took it')
        : // One template rather than a plural rule glued on: the count belongs
          // inside the sentence, and each language puts it where it belongs.
          t('appscript.sent', 'Sent to {n} panes', { n: reached })
    )
    setScript('')
    setTimeout(() => setSent(''), 2500)
  }

  return (
    <>
      {broadcasting && (
        <form className="td-broadcast-script" data-testid="broadcast-script-row" onSubmit={submitScript}>
          <input
            className="td-broadcast-script-input"
            data-testid="broadcast-script"
            value={script}
            spellCheck={false}
            aria-label={t('appscript.script', 'Command or script for every pane')}
            placeholder={t('appscript.placeholder', 'Send a line to every pane…')}
            onChange={(e) => setScript(e.target.value)}
          />
          <button
            className="td-btn td-btn-primary"
            data-testid="broadcast-send"
            type="submit"
            disabled={script.trim() === ''}
          >
            {t('appscript.send', 'Send')}
          </button>
          {snippets.length > 0 && (
            <select
              className="td-broadcast-script-snippets"
              data-testid="broadcast-snippet"
              aria-label={t('appscript.snippets', 'Saved snippets')}
              value=""
              onChange={(e) => {
                const snippet = snippets.find((entry) => entry.id === e.target.value)
                if (snippet) setScript(snippet.command)
              }}
            >
              <option value="">{t('appscript.snippets_2', 'Snippets…')}</option>
              {snippets.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </option>
              ))}
            </select>
          )}
          {sent && (
            <span className="td-broadcast-script-note" data-testid="broadcast-script-sent">
              {sent}
            </span>
          )}
        </form>
      )}
      <div className="td-sidebar-footer">
        <button
          className={`td-icon-btn${broadcasting ? ' is-on' : ''}`}
          title={
            broadcasting
              ? `Typing goes to all ${panelCount} panes — ${broadcastSummary}. Click to send to the focused pane only.`
              : `Broadcast input: send typing to all ${panelCount} panes at once`
          }
          data-testid="toggle-broadcast"
          aria-pressed={broadcasting}
          onClick={onToggleBroadcast}
        >
          ⇶
        </button>
        <button
          className={`td-icon-btn${showTimestamps ? ' is-on' : ''}`}
          title={t('app.toggle_timestamps', 'Show a timestamp column in every pane')}
          data-testid="toggle-timestamps"
          aria-pressed={showTimestamps}
          onClick={onToggleTimestamps}
        >
          ⏱
        </button>
        <button
          className="td-icon-btn"
          title={t('app.arrange_panes_hint2', 'Arrange panes (tile, columns, rows)')}
          data-testid="arrange-panes"
          onClick={onArrange}
        >
          ▦
        </button>
        <button
          className="td-icon-btn"
          title={t('app.new_connection_ctrl_t', 'New connection (Ctrl+T)')}
          data-testid="new-connection"
          onClick={onNewConnection}
        >
          ＋
        </button>
        <button
          className="td-icon-btn"
          title={
            localShellAvailable === false
              ? 'Local shell needs @lydell/node-pty for this platform'
              : 'Open a local shell'
          }
          data-testid="local-shell"
          disabled={!localShellAvailable}
          onClick={onLocalShell}
        >
          {t('app.gt', '&gt;_')}
        </button>
        <button
          className="td-icon-btn"
          title={t('app.connections_window', 'Connections window')}
          data-testid="open-connections"
          onClick={onOpenConnections}
        >
          ⧉
          {sessionCount > 0 && <span className="td-badge">{sessionCount}</span>}
        </button>
        <button
          className="td-icon-btn"
          title={t('app.snippet_bar', 'Snippet bar')}
          data-testid="toggle-snippets"
          onClick={onToggleSnippets}
        >
          ⌨
        </button>
        <button
          className="td-icon-btn"
          title={t('app.settings', 'Settings')}
          data-testid="open-settings"
          onClick={onOpenSettings}
        >
          ⚙
        </button>

        {/*
          The pomodoro chip lives here because this is where your eye already is:
          it shows which half of the cycle is running and how long is left, and it
          is the only place the cycle is visible without the bar.
        */}
        {chip && (
          <WellnessChip
            phase={chip.phase}
            endsAt={chip.endsAt}
            round={chip.round}
            title={t('app.pomodoro_click_for_the_setti', 'Pomodoro — click for the settings')}
            onClick={onOpenSettings}
          />
        )}

        {/*
          The grip: drag it onto the other half of the window and the whole drawer
          moves to that edge.
        */}
        <span
          className="td-drawer-grip"
          data-testid="drawer-grip"
          draggable
          title={t(
            'app.drag_to_the_other_edge_to_mo',
            'Drag to the other edge to move the whole drawer · double-click to swap sides'
          )}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', 'drawer')
            onGripDragStart()
          }}
          onDragEnd={onGripDragEnd}
          onDoubleClick={onFlip}
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
        onPointerDown={onResizeStart}
      />

      {/*
        Which edge the drawer would land on, while it is being dragged there. Two
        lanes rather than a free-floating drop: there are only two places the
        drawer can be. A section heading can start the same gesture, so either
        drag shows it.
      */}
      {(draggingDrawer || draggingSection) && (
        <div className={`td-drawer-hint is-${dropHint ?? side}`} aria-hidden="true" />
      )}
    </>
  )
}
