import { useMemo, useRef, useState, type DragEvent, type JSX } from 'react'
import type { SavedSession, SessionFolder, SessionTree as Tree } from '@shared/types'

export type DragPayload =
  | { kind: 'session'; id: string }
  | { kind: 'folder'; id: string }

interface SessionTreeProps {
  tree: Tree
  activeSessionId: string | null
  /** Saved session highlighted in the tree (selection, not a live pane). */
  selectedSavedId: string | null
  /** Saved session currently being connected, if any. */
  connectingId: string | null
  tagFilter: string[]
  onSelectSession: (session: SavedSession) => void
  onOpenSession: (session: SavedSession) => void
  onEditSession: (session: SavedSession) => void
  onDeleteSession: (id: string) => void
  onDuplicateSession: (session: SavedSession) => void
  /** Create a session at the root; lives in the Sessions header, not the sidebar. */
  onNewSession: () => void
  onContextMenu: (state: ContextMenuState) => void
  onCreateFolder: (parentId: string | null) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onToggleFolder: (id: string, expanded: boolean) => void
  onMove: (payload: DragPayload, parentId: string | null) => void
  onToggleTag: (tag: string) => void
  availableTags: string[]
}

/** Right-click target, forwarded to the app which owns the menu. */
export interface ContextMenuState {
  x: number
  y: number
  target:
    | { kind: 'session'; session: SavedSession }
    | { kind: 'folder'; folder: SessionFolder }
    | { kind: 'root' }
}

/** Right-click on a pane tab. Kept separate from the tree menu above. */
export interface TabMenuState {
  x: number
  y: number
  /** dockview panel id of the tab that was clicked. */
  panelId: string
  title: string
}

interface Node {
  folders: SessionFolder[]
  sessions: SavedSession[]
}

/** Group children by parent so the tree can be rendered recursively. */
function indexChildren(tree: Tree): Map<string | null, Node> {
  const map = new Map<string | null, Node>()
  const bucket = (parentId: string | null): Node => {
    let node = map.get(parentId)
    if (!node) {
      node = { folders: [], sessions: [] }
      map.set(parentId, node)
    }
    return node
  }

  for (const folder of tree.folders) bucket(folder.parentId).folders.push(folder)
  for (const session of tree.sessions) bucket(session.parentId).sessions.push(session)

  for (const node of map.values()) {
    node.folders.sort((a, b) => a.name.localeCompare(b.name))
    node.sessions.sort((a, b) => a.name.localeCompare(b.name))
  }

  return map
}

const DRAG_MIME = 'application/x-termdeck-node'

function encodePayload(payload: DragPayload): string {
  return `${payload.kind}:${payload.id}`
}

function parseDrag(raw: string): DragPayload | null {
  const [kind, id] = raw.split(':')
  if ((kind === 'session' || kind === 'folder') && id) return { kind, id }
  return null
}

export function SessionTree({
  tree,
  activeSessionId,
  selectedSavedId,
  connectingId,
  tagFilter,
  onSelectSession,
  onOpenSession,
  onEditSession,
  onDeleteSession,
  onDuplicateSession,
  onNewSession,
  onContextMenu,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onMove,
  onToggleTag,
  availableTags
}: SessionTreeProps): JSX.Element {
  const children = useMemo(() => indexChildren(tree), [tree])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  // The drag payload is also kept in a ref: reading dataTransfer during
  // `dragover` is disallowed by the spec, so it is only available on `drop`.
  const dragPayload = useRef<DragPayload | null>(null)

  const matchesFilter = (session: SavedSession): boolean =>
    tagFilter.length === 0 || tagFilter.every((tag) => session.tags.includes(tag))

  /**
   * Drop-zone wiring shared by folders, sessions and the tree root.
   *
   * A drop target only works if `dragenter` *and* `dragover` both call
   * preventDefault; without `dragenter` the browser keeps rejecting the drop and
   * nothing happens on release.
   */
  const dropZone = (
    key: string,
    resolveTarget: () => string | null,
    options: { selfId?: string } = {}
  ): {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  } => ({
    onDragEnter: (e) => {
      if (!dragPayload.current) return
      if (options.selfId && dragPayload.current.id === options.selfId) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(key)
    },
    onDragOver: (e) => {
      if (!dragPayload.current) return
      if (options.selfId && dragPayload.current.id === options.selfId) return
      // Required, otherwise the drop event never fires.
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropTarget !== key) setDropTarget(key)
    },
    onDragLeave: () => {
      setDropTarget((current) => (current === key ? null : current))
    },
    onDrop: (e) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)

      const raw = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')
      const payload = parseDrag(raw) ?? dragPayload.current
      dragPayload.current = null
      if (!payload) return
      if (options.selfId && payload.id === options.selfId) return
      onMove(payload, resolveTarget())
    }
  })

  const beginDrag = (e: DragEvent, payload: DragPayload): void => {
    // Rows are nested, so without this the parent folder's handler would also
    // run and overwrite the payload with "folder:<id>", making every nested
    // session drag move the folder instead.
    e.stopPropagation()
    dragPayload.current = payload
    const encoded = encodePayload(payload)
    e.dataTransfer.setData(DRAG_MIME, encoded)
    e.dataTransfer.setData('text/plain', encoded)
    e.dataTransfer.effectAllowed = 'move'
  }

  const endDrag = (e: DragEvent): void => {
    e.stopPropagation()
    dragPayload.current = null
    setDropTarget(null)
  }

  const renderSessions = (parentId: string | null): JSX.Element[] =>
    (children.get(parentId)?.sessions ?? [])
      .filter(matchesFilter)
      .map((session) => {
        const key = `session:${session.id}`
        const isConnecting = connectingId === session.id
        const isSelected = selectedSavedId === session.id

        return (
          <li
            key={session.id}
            className={
              'td-node td-node-session' +
              (session.id === activeSessionId ? ' is-active' : '') +
              (isSelected ? ' is-selected' : '') +
              (isConnecting ? ' is-connecting' : '') +
              (dropTarget === key ? ' is-drop' : '')
            }
            data-node-kind="session"
            data-node-id={session.id}
            draggable
            onDragStart={(e) => beginDrag(e, { kind: 'session', id: session.id })}
            onDragEnd={endDrag}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'session', session } })
            }}
            // Dropping onto a session means "put it in the same folder".
            {...dropZone(key, () => session.parentId)}
          >
            <button
              className="td-node-main"
              // Single click selects; double click connects. Wired this way so a
              // double click does not also fire the connect action once.
              onClick={() => onSelectSession(session)}
              onDoubleClick={() => onOpenSession(session)}
              title={`${session.username}@${session.host}:${session.port} — double-click to connect`}
            >
              <span
                className="td-node-dot"
                style={session.color ? { background: session.color } : undefined}
              />
              <span className="td-node-label">{session.name}</span>
              {isConnecting && <span className="td-node-spinner" title="Connecting…" />}
            </button>

            {/*
              No per-row action icons. They duplicated what already works better
              elsewhere: double-click connects, and Edit/Delete are on the
              right-click menu. Three icons on every row was the loudest thing in
              the list and made a clean tree look busy.
            */}

            {session.tags.length > 0 && (
              <div className="td-node-tags">
                {session.tags.map((tag) => (
                  <span key={tag} className="td-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </li>
        )
      })

  const renderFolders = (parentId: string | null): JSX.Element[] =>
    (children.get(parentId)?.folders ?? []).map((folder) => {
      const expanded = folder.expanded !== false
      const key = `folder:${folder.id}`
      const total = countSessions(children, folder.id) + countFolders(children, folder.id)

      return (
        <li
          key={folder.id}
          className={`td-node td-node-folder${dropTarget === key ? ' is-drop' : ''}`}
          data-node-kind="folder"
          data-node-id={folder.id}
          draggable
          onDragStart={(e) => beginDrag(e, { kind: 'folder', id: folder.id })}
          onDragEnd={endDrag}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'folder', folder } })
          }}
          {...dropZone(key, () => folder.id, { selfId: folder.id })}
        >
          {renaming === folder.id ? (
            <input
              className="td-inline-input"
              autoFocus
              defaultValue={folder.name}
              onBlur={(e) => {
                const value = e.currentTarget.value.trim()
                if (value) onRenameFolder(folder.id, value)
                setRenaming(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              className="td-node-main"
              onClick={() => onToggleFolder(folder.id, !expanded)}
              onDoubleClick={() => setRenaming(folder.id)}
            >
              <span
                className="td-caret"
                data-contrast-exempt
                aria-hidden="true"
              >
                {expanded ? '▾' : '▸'}
              </span>
              <span
                className="td-node-dot td-node-dot-folder"
                style={folder.color ? { background: folder.color } : undefined}
              />
              <span className="td-node-label">{folder.name}</span>
              <span className="td-node-count" data-contrast-exempt>
                {total || ''}
              </span>
            </button>
          )}

          {/*
            Folder rows keep only the two actions with no other route: there is
            no context-menu-free way to add a subfolder or start a rename, and
            "new session here" lives on the right-click menu. Deleting a folder
            is on that menu too, which is also the safer place for it.
          */}
          <span className="td-node-actions">
            <button className="td-mini" title="New subfolder" onClick={() => onCreateFolder(folder.id)}>
              ⊞
            </button>
            <button className="td-mini" title="Rename" onClick={() => setRenaming(folder.id)}>
              ✎
            </button>
          </span>

          {expanded && (
            <ul
              className="td-node-children"
              // The nested list covers the area below the folder row, so it must
              // forward drops to the folder it belongs to.
              {...dropZone(`${key}:body`, () => folder.id, { selfId: folder.id })}
            >
              {renderFolders(folder.id)}
              {renderSessions(folder.id)}
            </ul>
          )}
        </li>
      )
    })

  const rootSessions = renderSessions(null)
  const rootFolders = renderFolders(null)

  return (
    <div className="td-tree">
      <div className="td-tree-toolbar">
        <span className="td-sidebar-section">Sessions</span>
        <span className="td-tree-toolbar-actions">
          {/* Creating a session belongs with the session list, not in the
              sidebar's global actions. */}
          <button
            className="td-mini"
            title="New session"
            data-testid="tree-new-session"
            onClick={onNewSession}
          >
            +
          </button>
          <button className="td-mini" title="New folder" onClick={() => onCreateFolder(null)}>
            ⊞
          </button>
        </span>
      </div>

      {availableTags.length > 0 && (
        <div className="td-tag-filter">
          {availableTags.map((tag) => (
            <button
              key={tag}
              className={`td-tag td-tag-filterable${tagFilter.includes(tag) ? ' is-on' : ''}`}
              onClick={() => onToggleTag(tag)}
              title={tagFilter.includes(tag) ? `Remove filter: ${tag}` : `Filter by: ${tag}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <ul
        className={`td-tree-root${dropTarget === 'root' ? ' is-drop' : ''}`}
        onContextMenu={(e) => {
          // Only when the click misses a row: rows stop propagation themselves.
          e.preventDefault()
          onContextMenu({ x: e.clientX, y: e.clientY, target: { kind: 'root' } })
        }}
        // Dropping on empty space in the tree moves the node back to the root.
        {...dropZone('root', () => null)}
      >
        {rootFolders}
        {rootSessions}
        {tree.folders.length === 0 && tree.sessions.length === 0 && (
          <li className="td-session-empty">
            No saved sessions. Use “New session” to add one.
          </li>
        )}
      </ul>
    </div>
  )
}

function countSessions(children: Map<string | null, Node>, parentId: string): number {
  const node = children.get(parentId)
  if (!node) return 0
  return (
    node.sessions.length +
    node.folders.reduce((sum, f) => sum + countSessions(children, f.id), 0)
  )
}

function countFolders(children: Map<string | null, Node>, parentId: string): number {
  const node = children.get(parentId)
  if (!node) return 0
  return node.folders.reduce((sum, f) => sum + 1 + countFolders(children, f.id), 0)
}
