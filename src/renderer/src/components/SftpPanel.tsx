import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX
} from 'react'
import type { SftpEntry } from '@shared/types'
import { t } from '../i18n'

/**
 * The Terminal drawer's remote file browser.
 *
 * Its own module rather than a fourth block in `DrawerSections`: the drawer's
 * frames and history list are on screen the moment the window opens, this is
 * not (it needs a live SSH session to show anything but an empty hint), and a
 * separate module is what lets `App` load it after the first paint.
 */

interface SftpPanelProps {
  /** Live session to browse, or null when the active pane is not an SSH login. */
  sessionId: string | null
  onToast: (message: string) => void
  onError: (message: string) => void
  /** Opens the transfers window, which is where progress is watched. */
  onOpenTransfers?: () => void
  /** How many files are moving right now, for the button's badge. */
  runningTransfers?: number
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
export function SftpPanel({
  sessionId,
  onToast,
  onError,
  onOpenTransfers,
  runningTransfers = 0
}: SftpPanelProps): JSX.Element {
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** True while a file is held over the panel, so the drop target is obvious. */
  const [dropping, setDropping] = useState(false)
  /**
   * What the path box holds while the user is typing in it.
   *
   * `null` means "not editing": the box shows the directory that is actually
   * listed. Keeping that separate from `path` is what makes Escape and a failed
   * jump both behave — the box goes back to the truth instead of keeping the
   * text of a path that was never loaded.
   */
  const [draft, setDraft] = useState<string | null>(null)
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
      return    }
    onToast(`Uploaded ${result.path.split('/').pop()} to ${current}`)
    await load(current)
  }

  /**
   * Paths of the files dropped on the panel.
   *
   * `files` is the direct route, but a `File` only carries a real path when Electron can
   * resolve it (`webUtils.getPathForFile`) — dragging out of some apps yields nothing but
   * text, so the transfer list and the plain-text fallbacks are read as well. Anything
   * that is not an absolute path is dropped rather than guessed at.
   */
  const droppedPaths = (event: DragEvent<HTMLElement>): string[] => {
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer.files ?? [])) {
      const resolved = window.termdeck.pathForFile(file)
      if (resolved) paths.push(resolved)
    }
    if (paths.length === 0) {
      const text =
        event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        let candidate = trimmed
        if (candidate.startsWith('file://')) {
          try {
            candidate = decodeURIComponent(candidate.slice('file://'.length))
          } catch {
            continue
          }
          // `file:///C:/x` and `file:///home/x` both keep a leading slash issue: on
          // Windows the slash before the drive letter is not part of the path.
          if (/^\/[a-zA-Z]:/.test(candidate)) candidate = candidate.slice(1)
        }
        if (candidate.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(candidate)) paths.push(candidate)
      }
    }
    return paths
  }

  /** Upload each dropped file into the directory on screen. */
  const dropUpload = async (event: DragEvent<HTMLElement>): Promise<void> => {
    event.preventDefault()
    setDropping(false)
    const current = path || '.'
    const paths = droppedPaths(event)
    if (paths.length === 0) {
      onError(t('drawersections.nothing_to_upload', 'That drop held no files this window can read.'))
      return
    }
    /*
     * One at a time: the transfer strip already shows them all, and a dozen parallel
     * uploads on one SFTP channel would spend their time queueing behind each other.
     */
    for (const localPath of paths) {
      const result = await window.termdeck.startUpload(sessionId, current, localPath)
      if (!result.ok && !result.cancelled) {
        onError(result.message ?? 'Upload failed.')
        return
      }
    }
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
    <div
      className={'td-sftp' + (dropping ? ' is-dropping' : '')}
      data-testid="sftp-panel"
      data-dropping={dropping ? 'true' : 'false'}
      onDragOver={(event) => {
        // Only claim the drop when there is a session to upload over.
        if (!sessionId) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={(event) => {
        // Moving between children fires leave/over pairs; only leaving the panel ends it.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropping(false)
      }}
      onDrop={(event) => void dropUpload(event)}
    >
      {dropping && (
        <div className="td-sftp-drop-hint" data-testid="sftp-drop-hint">
          {t('drawersections.drop_to_upload', 'Drop to upload into this folder')}
        </div>
      )}
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
        <input
          className="td-sftp-path"
          data-testid="sftp-path"
          value={draft ?? path}
            /*
             * The remote home is only known to the main process, so the field
             * cannot pre-fill it; the placeholder is the one hint that matters.
             */
            placeholder="/path/on/the/host"
            spellCheck={false}
            aria-label={t('drawersections.remote_path', 'Remote path')}
            title={t(
              'drawersections.type_a_path_and_press_enter',
              'Type a path and press Enter'
            )}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const target = e.currentTarget.value.trim()
                // An empty box would list the home directory again, which is a
                // valid thing to ask for but not what Enter on an empty box
                // means — leave the listing alone instead.
                if (!target) return
                setDraft(null)
                void load(target)
              } else if (e.key === 'Escape') {
                setDraft(null)
                e.currentTarget.blur()
              }
            }}
            // Leaving the box without pressing Enter abandons the edit rather
            // than surprising the user with a jump they did not confirm.
            onBlur={() => setDraft(null)}
          />
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
        {/*
          Progress lives in its own window: the panel can only report on the session it
          is showing, and only while somebody is looking at it. The badge is the part
          that makes the window discoverable — a running count on the button.
        */}
        <button
          className="td-icon-btn td-sftp-transfers"
          title={t(
            'transfers.open_hint',
            'Transfers — progress for every upload and download'
          )}
          data-testid="sftp-transfers"
          onClick={() => onOpenTransfers?.()}
        >
          ⇅
          {runningTransfers > 0 && (
            <span className="td-sftp-badge" data-testid="sftp-transfers-badge">
              {runningTransfers}
            </span>
          )}
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
