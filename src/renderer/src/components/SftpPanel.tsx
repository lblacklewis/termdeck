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
import { ContextMenu, type MenuItem } from './ContextMenu'
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
  /**
   * Where the row menu is open, and which row it belongs to.
   *
   * `entry: null` is the folder itself — the menu on the empty part of the list,
   * which is where refresh and the folder's own path live.
   */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null)
  /**
   * The entry whose details are shown under the list.
   *
   * A block inside the panel rather than a modal: this panel lives in a drawer, and
   * a `position: fixed` backdrop inside a transformed ancestor (the drawer while it
   * animates) lands somewhere other than the window.
   */
  const [properties, setProperties] = useState<SftpEntry | null>(null)
  /**
   * The row the toolbar's download button acts on.
   *
   * A hook, so it has to stay above the "no session" early return below: the panel
   * first renders without a session and then with one, and calling a hook only on the
   * second render is what React means by "rendered more hooks than during the
   * previous render".
   */
  const selectedEntry = useMemo(
    () => entries.find((candidate) => candidate.path === selected) ?? null,
    [entries, selected]
  )

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
        // A jump leaves both the menu and the details of the old folder behind.
        setMenu(null)
        setProperties(null)
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

  const copyText = async (text: string): Promise<void> => {
    await window.termdeck.copyToClipboard(text)
    onToast(t('drawersections.copied_to_clipboard', 'Copied to clipboard'))
  }

  /*
   * "Copy to terminal" types the text into the pane's own session.
   *
   * It goes through the session rather than the terminal widget: the panel only knows
   * a session id, and typing at the prompt is exactly what the user is asking for —
   * nothing is executed, and a path cannot span lines.
   */
  const sendToTerminal = (text: string): void => {
    if (!sessionId) return
    window.termdeck.writeSession(sessionId, text)
    onToast(t('drawersections.sent_to_terminal', 'Sent to the terminal'))
  }

  /** The folder a path lives in; a directory is its own folder. */
  const folderOf = (entry: SftpEntry): string => {
    if (entry.type === 'directory') return entry.path
    const trimmed = entry.path.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    return cut <= 0 ? '/' : trimmed.slice(0, cut)
  }

  const typeLabel = (entry: SftpEntry): string => {
    if (entry.type === 'directory') return t('drawersections.type_folder', 'Folder')
    if (entry.type === 'link') return t('drawersections.type_link', 'Link')
    if (entry.type === 'file') return t('drawersections.type_file', 'File')
    return t('drawersections.type_other', 'Other')
  }

  /**
   * The menu on a row.
   *
   * Modelled on what a file manager offers: open or download, upload into this
   * folder, copy the name / the path / the folder path — and the last two copied
   * straight into the terminal, which is what a remote session is usually for.
   */
  const rowMenuItems = (entry: SftpEntry): MenuItem[] => [
    entry.type === 'directory'
      ? { id: 'open', label: t('drawersections.open', 'Open') }
      : { id: 'download', label: t('drawersections.download', 'Download') },
    { id: 'upload', label: t('drawersections.upload_here', 'Upload to this folder') },
    { id: 'refresh', label: t('drawersections.refresh', 'Refresh'), separatorBefore: true },
    { id: 'copy-name', label: t('drawersections.copy_name', 'Copy name'), separatorBefore: true },
    { id: 'copy-path', label: t('drawersections.copy_path', 'Copy path') },
    { id: 'copy-dir', label: t('drawersections.copy_folder_path', 'Copy folder path') },
    {
      id: 'to-terminal-name',
      label: t('drawersections.copy_name_to_terminal', 'Copy name to terminal'),
      separatorBefore: true
    },
    {
      id: 'to-terminal-path',
      label: t('drawersections.copy_path_to_terminal', 'Copy path to terminal')
    },
    {
      id: 'properties',
      label: t('drawersections.properties', 'Properties'),
      separatorBefore: true
    }
  ]

  /** The menu on the empty part of the list: it belongs to the folder on screen. */
  const folderMenuItems = (): MenuItem[] => [
    { id: 'refresh', label: t('drawersections.refresh', 'Refresh') },
    { id: 'upload', label: t('drawersections.upload_here', 'Upload to this folder') },
    {
      id: 'copy-dir',
      label: t('drawersections.copy_folder_path', 'Copy folder path'),
      separatorBefore: true
    },
    {
      id: 'to-terminal-path',
      label: t('drawersections.copy_path_to_terminal', 'Copy path to terminal')
    }
  ]

  const runMenuAction = async (id: string, entry: SftpEntry | null): Promise<void> => {
    const current = path || '.'
    switch (id) {
      case 'open':
        if (entry && entry.type === 'directory') await load(entry.path)
        return
      case 'download':
        if (entry && entry.type !== 'directory') await download(entry)
        return
      case 'upload':
        await upload()
        return
      case 'refresh':
        await load(path || '')
        return
      case 'copy-name':
        if (entry) await copyText(entry.name)
        return
      case 'copy-path':
        await copyText(entry ? entry.path : current)
        return
      case 'copy-dir':
        await copyText(entry ? folderOf(entry) : current)
        return
      case 'to-terminal-name':
        if (entry) sendToTerminal(entry.name)
        return
      case 'to-terminal-path':
        sendToTerminal(entry ? entry.path : current)
        return
      case 'properties':
        if (entry) setProperties(entry)
        return
      default:
        return
    }
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
          Download lives in the bar, next to upload.
          
          It used to sit on its own row under the list, which meant selecting a file
          and then finding the button somewhere below the fold of a long listing.
        */}
        <button
          className="td-icon-btn"
          title={
            selectedEntry
              ? t('drawersections.download_selected', 'Download the selected file')
              : t('drawersections.pick_a_file_first', 'Pick a file first')
          }
          data-testid="sftp-download"
          disabled={busy || !selectedEntry || selectedEntry.type === 'directory'}
          onClick={() => {
            if (selectedEntry && selectedEntry.type !== 'directory') void download(selectedEntry)
          }}
        >
          ⭳
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

      <ul
        className="td-sftp-list"
        data-testid="sftp-list"
        onContextMenu={(event) => {
          // Rows handle their own; anything left is the folder on screen.
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, entry: null })
        }}
      >
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
            onContextMenu={(event) => {
              event.preventDefault()
              // Right-click acts on what it points at, like every file manager.
              event.stopPropagation()
              setSelected(entry.path)
              setMenu({ x: event.clientX, y: event.clientY, entry })
            }}
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

      {properties && (
        <div className="td-sftp-props" data-testid="sftp-properties">
          <div className="td-sftp-props-head">
            <span>{t('drawersections.properties', 'Properties')}</span>
            <button
              className="td-icon-btn"
              title={t('drawersections.close', 'Close')}
              data-testid="sftp-properties-close"
              onClick={() => setProperties(null)}
            >
              ✕
            </button>
          </div>
          <dl className="td-sftp-prop-list">
            <dt>{t('drawersections.name', 'Name')}</dt>
            <dd data-testid="sftp-prop-name">{properties.name}</dd>
            <dt>{t('drawersections.type', 'Type')}</dt>
            <dd data-testid="sftp-prop-type">{typeLabel(properties)}</dd>
            <dt>{t('drawersections.size', 'Size')}</dt>
            <dd data-testid="sftp-prop-size">
              {properties.type === 'directory' ? '—' : formatSize(properties.size) || '0 B'}
            </dd>
            <dt>{t('drawersections.modified', 'Modified')}</dt>
            <dd data-testid="sftp-prop-modified">
              {properties.modified ? new Date(properties.modified).toLocaleString() : '—'}
            </dd>
            <dt>{t('drawersections.path', 'Path')}</dt>
            <dd className="td-sftp-prop-path" data-testid="sftp-prop-path">
              {properties.path}
            </dd>
          </dl>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          testId="sftp-menu"
          items={menu.entry ? rowMenuItems(menu.entry) : folderMenuItems()}
          onSelect={(id) => void runMenuAction(id, menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
