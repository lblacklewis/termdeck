import { useRef, useState, type JSX, type ReactNode } from 'react'
import type { HistoryEntry, HistorySessionSummary, SidebarSectionId } from '@shared/types'
import { t } from '../i18n'

/**
 * The Terminal drawer's blocks.
 *
 * Each block is a plain section with a heading, and that heading is the drag
 * handle: the drawer's order is the user's, not ours (see `sidebar.sections` in
 * settings). The heading also carries a fold control and the section's own
 * actions, and the body can be resized from its bottom edge — a list you cannot
 * size is a list you fight with.
 */

interface SectionFrameProps {
  id: SidebarSectionId
  title: string
  /** Buttons shown at the right of the heading. */
  actions?: ReactNode
  collapsed: boolean
  /** Saved body height in px; undefined means "as tall as its content allows". */
  height?: number
  dragging: SidebarSectionId | null
  onDragStart: (id: SidebarSectionId) => void
  /** The heading finished being dragged onto this one. */
  onDropOn: (id: SidebarSectionId) => void
  onDragEnd: () => void
  onToggleCollapsed: (id: SidebarSectionId) => void
  /** Persist a height the user dragged to (0 resets it to auto). */
  onResize: (id: SidebarSectionId, height: number) => void
  /** Right-clicking the heading offers this section's menu. */
  onContextMenu: (id: SidebarSectionId, x: number, y: number) => void
  testId?: string
  children: ReactNode
}

/** Tall enough to show a row, short enough to leave room for the rest. */
const MIN_HEIGHT = 80
const MAX_HEIGHT = 720

export function SectionFrame({
  id,
  title,
  actions,
  collapsed,
  height,
  dragging,
  onDragStart,
  onDropOn,
  onDragEnd,
  onToggleCollapsed,
  onResize,
  onContextMenu,
  testId,
  children
}: SectionFrameProps): JSX.Element {
  /**
   * Height while a drag is in progress.
   *
   * Kept local so the gesture re-renders one section rather than the whole app,
   * and written to settings only on release: a settings save is a file write plus
   * a broadcast to every window, which is not something to do thirty times a
   * second.
   */
  const [liveHeight, setLiveHeight] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const startY = event.clientY
    const startHeight = bodyRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT
    let last = startHeight

    const move = (e: PointerEvent): void => {
      last = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(startHeight + e.clientY - startY)))
      setLiveHeight(last)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onResize(id, Math.round(last))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const settled = liveHeight ?? height
  const style = settled !== undefined ? { height: settled } : undefined

  return (
    <section
      className={
        'td-section' +
        (dragging === id ? ' is-dragging' : '') +
        (collapsed ? ' is-collapsed' : '') +
        (settled !== undefined ? ' is-sized' : '')
      }
      data-section={id}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-testid={testId}
    >
      <div
        className="td-sidebar-section td-section-head"
        draggable
        title={t('drawersections.drag_to_reorder_right_click', 'Drag to reorder · right-click for options')}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          // Firefox refuses to start a drag without data on the transfer.
          e.dataTransfer.setData('text/plain', id)
          onDragStart(id)
        }}
        // `dragover` only has to say "a drop is allowed here"; the move itself
        // happens once, on drop. Reordering on every dragover fired dozens of
        // times per gesture and fought the render it had just triggered.
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDragEnd={onDragEnd}
        onDrop={(e) => {
          e.preventDefault()
          // A drop on a heading is a reorder and nothing else. The window also
          // listens for drops, to dock the whole drawer on the half it lands in,
          // and without this the same gesture would reorder *and* move the drawer.
          e.stopPropagation()
          onDropOn(id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu(id, e.clientX, e.clientY)
        }}
      >
        <button
          className="td-section-toggle"
          data-testid={`toggle-${id}`}
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={(e) => {
            // The heading is a drag handle; the fold control is not.
            e.stopPropagation()
            onToggleCollapsed(id)
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="td-section-title">{title}</span>
        <span className="td-section-actions">{actions}</span>
      </div>

      {!collapsed && (
        <>
          <div className="td-section-body" ref={bodyRef} style={style}>
            {children}
          </div>
          <div
            className="td-section-resize"
            data-testid={`resize-${id}`}
            title={t('drawersections.drag_to_resize_double_click', 'Drag to resize · double-click to reset')}
            onPointerDown={startResize}
            onDoubleClick={() => onResize(id, 0)}
          />
        </>
      )}
    </section>
  )
}

interface HistoryPanelProps {
  /** Session whose history is on screen. */
  sessionId: string | null
  /** Sessions that still have history on disk, newest first. */
  sessions: HistorySessionSummary[]
  entries: HistoryEntry[]
  /** False when there is no pane to send to. */
  canSend: boolean
  onPick: (sessionId: string) => void
  onSend: (command: string) => void
  onDelete: (id: string) => void
}

/**
 * Commands that were actually run, one session at a time.
 *
 * History is per session and kept for a week (see `HistoryStore` in the main
 * process), so the panel shows the session you are looking at and can be pointed
 * at any other one that still has a file — a session closed an hour ago is still
 * readable.
 */
export function HistoryPanel({
  sessionId,
  sessions,
  entries,
  canSend,
  onPick,
  onSend,
  onDelete
}: HistoryPanelProps): JSX.Element {
  const current = sessions.find((s) => s.sessionId === sessionId)

  return (
    <div className="td-history-panel">
      {sessions.length > 0 && (
        <div className="td-history-bar">
          <select
            className="td-history-pick"
            data-testid="history-session"
            aria-label="history-session"
            value={sessionId ?? ''}
            onChange={(e) => onPick(e.target.value)}
          >
            {!current && sessionId && <option value={sessionId}>{t('drawersections.this_session', 'This session')}</option>}
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.title} · {s.count}
              </option>
            ))}
          </select>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="td-section-empty" data-testid="history-empty">
          {sessionId ? 'Nothing run in this session yet.' : 'Connect to a host to see its history.'}
        </p>
      ) : (
        <ul className="td-history" data-testid="history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="td-history-item" data-history-id={entry.id}>
              <button
                className="td-history-run"
                disabled={!canSend}
                title={canSend ? `Run “${entry.command}” in the active pane` : 'No active terminal'}
                onClick={() => onSend(entry.command)}
              >
                <code>{entry.command}</code>
                <span className="td-history-meta">{new Date(entry.at).toLocaleTimeString()}</span>
              </button>
              <button
                className="td-history-remove"
                title={t('drawersections.remove_from_history', 'Remove from history')}
                onClick={() => onDelete(entry.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="td-section-note">{t('drawersections.kept_for_7_days_per_session', 'Kept for 7 days, per session.')}</p>
    </div>
  )
}
