import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { HistoryEntry, SidebarSectionId, SftpEntry } from '@shared/types'

/**
 * The Terminal drawer's blocks.
 *
 * Each block is a plain section with a header, and the header is the drag handle:
 * the drawer's order is the user's, not ours (see `sidebar.sections` in settings).
 * The header also carries the section's own actions, so a section can be cleared
 * or refreshed without a separate toolbar row stealing vertical space.
 */

interface SectionFrameProps {
  id: SidebarSectionId
  title: string
  /** Buttons shown at the right of the header. */
  actions?: ReactNode
  dragging: SidebarSectionId | null
  onDragStart: (id: SidebarSectionId) => void
  /** The heading finished being dragged onto this one. */
  onDropOn: (id: SidebarSectionId) => void
  onDragEnd: () => void
  /** Right-clicking the header offers this section's menu. */
  onContextMenu: (id: SidebarSectionId, x: number, y: number) => void
  testId?: string
  children: ReactNode
}

export function SectionFrame({
  id,
  title,
  actions,
  dragging,
  onDragStart,
  onDropOn,
  onDragEnd,
  onContextMenu,
  testId,
  children
}: SectionFrameProps): JSX.Element {
  return (
    <section
      className={`td-section${dragging === id ? ' is-dragging' : ''}`}
      data-section={id}
      data-testid={testId}
    >
      <div
        className="td-sidebar-section td-section-head"
        draggable
        title="Drag to reorder · right-click for options"
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
          onDropOn(id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu(id, e.clientX, e.clientY)
        }}
      >
        <span className="td-drag-grip" aria-hidden="true">
          ⠿
        </span>
        <span className="td-section-title">{title}</span>
        <span className="td-section-actions">{actions}</span>
      </div>
      <div className="td-section-body">{children}</div>
    </section>
  )
}

interface HistoryPanelProps {
  entries: HistoryEntry[]
  /** False when there is no pane to send to. */
  canSend: boolean
  onSend: (command: string) => void
  onDelete: (id: string) => void
}

/**
 * Commands that were actually run, newest first.
 *
 * Recorded in the main process from what is typed into a session, so this is the
 * shell's own history rather than a transcript: arrow keys, tab completion and
 * terminal replies never reach it.
 */
export function HistoryPanel({ entries, canSend, onSend, onDelete }: HistoryPanelProps): JSX.Element {
  if (entries.length === 0) {
    return <p className="td-section-empty">Commands you run appear here.</p>
  }

  return (
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
            <span className="td-history-meta">
              {entry.session} · {new Date(entry.at).toLocaleTimeString()}
            </span>
          </button>
          <button
            className="td-history-remove"
            title="Remove from history"
            onClick={() => onDelete(entry.id)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
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
        Connect to a host to browse its files.
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
          title="Up one level"
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
          title="Refresh"
          data-testid="sftp-refresh"
          disabled={busy}
          onClick={() => void load(path || '')}
        >
          ⟳
        </button>
        <button
          className="td-icon-btn"
          title="Upload a file here"
          data-testid="sftp-upload"
          disabled={busy}
          onClick={() => void upload()}
        >
          ⭱
        </button>
      </div>

      <ul className="td-sftp-list" data-testid="sftp-list">
        {busy && entries.length === 0 && <li className="td-section-empty">Reading…</li>}
        {!busy && entries.length === 0 && <li className="td-section-empty">Empty directory.</li>}
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
            Download
          </button>
        </div>
      )}
    </div>
  )
}
