import { useMemo, useState, type JSX } from 'react'
import type { SavedSession, SessionInfo, SessionTree } from '@shared/types'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface HostsPageProps {
  tree: SessionTree
  /** Open connections, so the list can mark what is already running. */
  sessions: SessionInfo[]
  knownTags: string[]
  onConnect: (session: SavedSession) => void
  onEdit: (session: SavedSession) => void
  onDelete: (id: string) => void
  onDuplicate: (session: SavedSession) => void
  onNewHost: (parentId: string | null) => void
  onCreateGroup: (name: string, parentId: string | null) => void
  onRenameGroup: (id: string, name: string) => void
  onDeleteGroup: (id: string) => void
  onMove: (sessionId: string, parentId: string | null) => void
}

const UNFILED = 'Unfiled'
/** Marker for "no folder" in the drag payload; null cannot travel in a dataset. */
const ROOT = '__root__'

type ViewMode = 'list' | 'cards'

/**
 * Full-page host list.
 *
 * This page is the host manager, not a read-only view: hosts can be added,
 * edited, filed and removed here, and groups created, renamed and deleted, so the
 * session list in the drawer is a shortcut rather than the only way in. It offers
 * the two shapes people actually want for a host list — compact rows, or cards
 * that read at a glance — and either way a host or a whole group can be dragged
 * into another group.
 */
export function HostsPage({
  tree,
  sessions,
  knownTags,
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onNewHost,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMove
}: HostsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; run: (id: string) => void } | null>(
    null
  )
  const [drag, setDrag] = useState<{ kind: 'host' | 'group'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const openTitles = useMemo(() => new Set(sessions.map((s) => s.title)), [sessions])

  const folderName = (id: string | null): string =>
    (id && tree.folders.find((f) => f.id === id)?.name) || UNFILED

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching = tree.sessions.filter((session) => {
      if (tagFilter && !session.tags.includes(tagFilter)) return false
      if (!needle) return true
      return (
        session.name.toLowerCase().includes(needle) ||
        session.host.toLowerCase().includes(needle) ||
        session.username.toLowerCase().includes(needle)
      )
    })

    const byFolder = new Map<string, SavedSession[]>()
    for (const session of matching) {
      const name = folderName(session.parentId)
      byFolder.set(name, [...(byFolder.get(name) ?? []), session])
    }

    // Folders that exist but hold nothing still deserve a heading, or a group
    // would vanish the moment its last host was moved out of it.
    for (const folder of tree.folders) {
      if (!byFolder.has(folder.name)) byFolder.set(folder.name, [])
    }

    return [...byFolder.entries()].sort((a, b) => {
      if (a[0] === UNFILED) return 1
      if (b[0] === UNFILED) return -1
      return a[0].localeCompare(b[0])
    })
  }, [tree, filter, tagFilter])

  const total = tree.sessions.length

  const groupIdFor = (name: string): string | null =>
    name === UNFILED ? null : (tree.folders.find((f) => f.name === name)?.id ?? null)

  const hostMenu = (session: SavedSession): MenuItem[] => [
    { id: 'connect', label: 'Connect' },
    { id: 'edit', label: 'Edit…' },
    { id: 'duplicate', label: 'Duplicate' },
    { id: 'newInGroup', label: 'New host here…', separatorBefore: true },
    { id: 'delete', label: 'Delete', danger: true, separatorBefore: true }
  ]

  const groupMenu = (name: string, folderId: string | null): MenuItem[] => [
    { id: 'newHost', label: 'New host…' },
    { id: 'newSub', label: 'New group inside…' },
    { id: 'rename', label: 'Rename group…', disabled: folderId === null },
    { id: 'delete', label: 'Delete group', danger: true, separatorBefore: true, disabled: folderId === null }
  ]

  const openHostMenu = (event: React.MouseEvent, session: SavedSession): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: hostMenu(session),
      run: (id) => {
        if (id === 'connect') onConnect(session)
        else if (id === 'edit') onEdit(session)
        else if (id === 'duplicate') onDuplicate(session)
        else if (id === 'newInGroup') onNewHost(session.parentId)
        else if (id === 'delete') onDelete(session.id)
      }
    })
  }

  const openGroupMenu = (
    event: React.MouseEvent,
    name: string,
    folderId: string | null
  ): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: groupMenu(name, folderId),
      run: (id) => {
        if (id === 'newHost') onNewHost(folderId)
        else if (id === 'newSub') onCreateGroup('New group', folderId)
        else if (id === 'rename' && folderId) {
          const next = window.prompt('Rename group', name)
          if (next && next.trim()) onRenameGroup(folderId, next.trim())
        } else if (id === 'delete' && folderId) onDeleteGroup(folderId)
      }
    })
  }

  const startDrag = (event: React.DragEvent, kind: 'host' | 'group', id: string): void => {
    setDrag({ kind, id })
    event.dataTransfer?.setData('text/plain', id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  const dropOn = (folderId: string | null): void => {
    if (!drag || drag.id === folderId) return
    // Only hosts move between groups here; a group cannot be nested onto itself
    // (the tree rejects the cycle anyway, this keeps the UI honest).
    if (drag.kind === 'host') onMove(drag.id, folderId)
  }

  const dropZone = (key: string, folderId: string | null): Record<string, unknown> => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return
      e.preventDefault()
      setDropTarget(key)
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      dropOn(folderId)
      setDrag(null)
    }
  })

  return (
    <div className="td-page" data-testid="hosts-page">
      <header className="td-page-head">
        <div>
          <h1>Hosts</h1>
          <p className="td-page-sub">
            {total} host{total === 1 ? '' : 's'} · {tree.folders.length} group
            {tree.folders.length === 1 ? '' : 's'} · {openTitles.size} connected
          </p>
        </div>
        <div className="td-page-actions">
          <input
            className="td-page-search"
            aria-label="filter-hosts"
            placeholder="Filter hosts"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="td-view-switch" role="group" aria-label="Host list style">
            <button
              className={`td-seg-btn${view === 'list' ? ' is-active' : ''}`}
              data-testid="hosts-view-list"
              aria-pressed={view === 'list'}
              title="Rows"
              onClick={() => setView('list')}
            >
              ☰ Rows
            </button>
            <button
              className={`td-seg-btn${view === 'cards' ? ' is-active' : ''}`}
              data-testid="hosts-view-cards"
              aria-pressed={view === 'cards'}
              title="Cards"
              onClick={() => setView('cards')}
            >
              ▦ Cards
            </button>
          </div>
          <button
            className="td-btn"
            data-testid="hosts-new-group"
            onClick={() => onCreateGroup('New group', null)}
          >
            New group
          </button>
          <button
            className="td-btn td-btn-primary"
            data-testid="hosts-new-host"
            onClick={() => onNewHost(null)}
          >
            New host
          </button>
        </div>
      </header>

      {knownTags.length > 0 && (
        <div className="td-page-filters">
          {knownTags.map((tag) => (
            <button
              key={tag}
              className={`td-tag td-tag-filterable${tagFilter === tag ? ' is-on' : ''}`}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              title={tagFilter === tag ? `Clear filter: ${tag}` : `Filter by: ${tag}`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      <div className="td-page-body">
        {total === 0 && (
          <div className="td-page-empty">
            No hosts yet. Use <b>New host</b> above, or press <kbd>Ctrl</kbd>+<kbd>T</kbd> to connect
            without saving.
          </div>
        )}

        {total > 0 &&
          groups.map(([group, items]) => {
            const folderId = groupIdFor(group)
            const key = 'group:' + group
            return (
              <section
                className={`td-host-group${dropTarget === key ? ' is-drop' : ''}`}
                key={group}
                data-host-group={group}
                {...dropZone(key, folderId)}
              >
                <div
                  className="td-host-group-head"
                  onContextMenu={(e) => openGroupMenu(e, group, folderId)}
                  onDragOver={(e) => {
                    if (!drag || drag.kind !== 'group') return
                    e.preventDefault()
                  }}
                  // A group can be dragged onto another group header to re-file it.
                  draggable={folderId !== null}
                  onDragStart={(e) => folderId && startDrag(e, 'group', folderId)}
                  onDragEnd={() => setDrag(null)}
                >
                  <h2>{group}</h2>
                  <span className="td-host-group-count" data-contrast-exempt>
                    {items.length}
                  </span>
                  <span className="td-spacer" />
                  <button
                    className="td-icon-btn"
                    title={`New host in ${group}`}
                    data-new-host={group}
                    onClick={() => onNewHost(folderId)}
                  >
                    +
                  </button>
                </div>

                {items.length === 0 && <p className="td-hint td-host-group-empty">Empty group</p>}

                <ul className={`td-host-list is-${view}`}>
                  {items.map((session) => {
                    const connected = openTitles.has(session.name)
                    return (
                      <li
                        key={session.id}
                        className={`td-host-row is-${view}${connected ? ' is-connected' : ''}`}
                        data-host-row={session.id}
                        draggable
                        onDragStart={(e) => startDrag(e, 'host', session.id)}
                        onDragEnd={() => setDrag(null)}
                        onDoubleClick={() => onConnect(session)}
                        onContextMenu={(e) => openHostMenu(e, session)}
                      >
                        <span
                          className={`td-host-status${connected ? ' is-on' : ''}`}
                          title={connected ? 'Connected' : 'Not connected'}
                          data-contrast-exempt
                        />
                        <div className="td-host-main">
                          <span className="td-host-name">{session.name}</span>
                          <span className="td-host-address td-mono">
                            {session.username}@{session.host}:{session.port}
                          </span>
                        </div>

                        {session.tags.length > 0 && (
                          <div className="td-host-tags">
                            {session.tags.map((tag) => (
                              <span key={tag} className="td-tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="td-host-actions">
                          <button
                            className="td-btn td-btn-sm td-btn-primary"
                            data-action="connect"
                            onClick={() => onConnect(session)}
                          >
                            {connected ? 'Focus' : 'Connect'}
                          </button>
                          <button
                            className="td-icon-btn"
                            data-action="menu"
                            title="More…"
                            onClick={(e) => openHostMenu(e, session)}
                          >
                            ⋯
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          testId="hosts-menu"
          onSelect={menu.run}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
