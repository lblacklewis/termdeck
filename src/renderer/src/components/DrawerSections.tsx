import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { HistoryEntry, HistorySessionSummary, SidebarSectionId, SftpEntry } from '@shared/types'
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

interface SftpPanelProps {
  /** Live session to browse, or null when the active pane is not an SSH login. */
  sessionId: string | null
  onToast: (message: string) => void
  onError: (message: string) => void
}

/** Bytes as something readable; remote listings are mostly small files. */
function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A remote directory browser over the connection the pane already has.
 *
 * Deliberately small: navigate, upload, download. The value here is that it works
 * on the *same* login — nothing extra to configure, and the credentials stay in
 * the main process, so the renderer only ever sends a session id and a path.
 */
export function SftpPanel({ sessionId, onToast, onError }: SftpPanelProps): JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** Which session the current listing belongs to, so a switch reloads it. */
  const loadedFor = useRef<string | null>(null)

  const load = useCallback(
    async (target: string) => {
      if (!sessionId) return
      setBusy(true)
      try {
        const result = await window.termdeck.sftpList(sessionId, target)
        if (!result.ok) {
          onError(result.message)
          return
        }
        setPath(result.path)
        setEntries(result.entries)
        setSelected(null)
      } finally {
        setBusy(false)
      }
    },
    [onError, sessionId]
  )

  useEffect(() => {
    if (!sessionId) {
      loadedFor.current = null
      setEntries([])
      setPath('')
      return
    }
    if (loadedFor.current === sessionId) return
    loadedFor.current = sessionId
    void load('')
  }, [load, sessionId])

  const parent = useMemo(() => {
    const trimmed = path.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    return cut <= 0 ? '/' : trimmed.slice(0, cut)
  }, [path])

  if (!sessionId) {
    return (
      <p className="td-section-empty" data-testid="sftp-empty">
        {t('drawersections.connect_to_a_host_to_browse', 'Connect to a host to browse its files.')}
      </p>
    )
  }

  const upload = async (): Promise<void> => {
    const current = path || '.'
    const result = await window.termdeck.sftpUpload(sessionId, current)
    if (!result.ok) {
      if (!result.cancelled) onError(result.message ?? 'Upload failed.')
      return
    }
    onToast(`Uploaded ${result.path.split('/').pop()} to ${current}`)
    await load(current)
  }

  const download = async (entry: SftpEntry): Promise<void> => {
    const result = await window.termdeck.sftpDownload(sessionId, entry.path)
    if (!result.ok) {
      if (!result.cancelled) onError(result.message ?? 'Download failed.')
      return
    }
    onToast(`Saved ${entry.name} to ${result.path}`)
  }

  return (
    <div className="td-sftp" data-testid="sftp-panel">
      <div className="td-sftp-bar">
        <button
          className="td-icon-btn"
          title={t('drawersections.up_one_level', 'Up one level')}
          data-testid="sftp-up"
          disabled={busy || path === '/'}
          onClick={() => void load(parent)}
        >
          ↑
        </button>
        <span className="td-sftp-path" title={path}>
          {path || '…'}
        </span>
        <button
          className="td-icon-btn"
          title={t('drawersections.refresh', 'Refresh')}
          data-testid="sftp-refresh"
          disabled={busy}
          onClick={() => void load(path || '')}
        >
          ⟳
        </button>
        <button
          className="td-icon-btn"
          title={t('drawersections.upload_a_file_here', 'Upload a file here')}
          data-testid="sftp-upload"
          disabled={busy}
          onClick={() => void upload()}
        >
          ⭱
        </button>
      </div>

      <ul className="td-sftp-list" data-testid="sftp-list">
        {busy && entries.length === 0 && <li className="td-section-empty">{t('drawersections.reading', 'Reading…')}</li>}
        {!busy && entries.length === 0 && <li className="td-section-empty">{t('drawersections.empty_directory', 'Empty directory.')}</li>}
        {entries.map((entry) => (
          <li
            key={entry.path}
            className={`td-sftp-row${selected === entry.path ? ' is-selected' : ''}${
              entry.type === 'directory' ? ' is-dir' : ''
            }`}
            data-sftp-entry={entry.name}
            data-sftp-type={entry.type}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => {
              if (entry.type === 'directory') void load(entry.path)
              else void download(entry)
            }}
          >
            <span className="td-sftp-icon" aria-hidden="true">
              {entry.type === 'directory' ? '▸' : entry.type === 'link' ? '⤳' : '·'}
            </span>
            <span className="td-sftp-name" title={entry.name}>
              {entry.name}
            </span>
            <span className="td-sftp-size">{formatSize(entry.size)}</span>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="td-sftp-actions">
          <button
            className="td-btn"
            data-testid="sftp-download"
            onClick={() => {
              const entry = entries.find((e) => e.path === selected)
              if (entry) void download(entry)
            }}
          >
            {t('drawersections.download', 'Download')}
          </button>
        </div>
      )}
    </div>
  )
}
