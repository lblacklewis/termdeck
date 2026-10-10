import { useMemo, useState, type JSX } from 'react'
import type { SavedSession, SessionFolder, SessionInfo, SessionTree } from '@shared/types'
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
  /** Re-file a whole group, which is how nesting is rearranged. */
  onMoveGroup: (folderId: string, parentId: string | null) => void
}

const UNFILED = 'Unfiled'

type ViewMode = 'list' | 'cards'

/** One group heading: a real folder, or the catch-all for hosts in no folder. */
interface GroupNode {
  key: string
  /** Folder id, or null for the catch-all. */
  id: string | null
  name: string
  /** Full path, so nested groups of the same name stay distinguishable. */
  path: string
  depth: number
  hosts: SavedSession[]
  children: GroupNode[]
}

/**
 * Full-page host manager.
 *
 * The page is the editor as well as the list: hosts can be added, edited, filed
 * and removed here, and groups created, renamed, nested and deleted. Groups are a
 * real tree — the tree model has always supported nesting, but this page used to
 * flatten it, so a sub-group was created and then simply not shown, which reads as
 * "the button does nothing".
 *
 * Two shapes are offered: compact rows for scanning a long list, and cards for
 * picking one host out of a handful. Either way a host can be dragged onto a group
 * (including the catch-all) to re-file it.
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
  onMove,
  onMoveGroup
}: HostsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    run: (id: string) => void
  } | null>(null)
  const [drag, setDrag] = useState<{ kind: 'host' | 'group'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const openTitles = useMemo(() => new Set(sessions.map((s) => s.title)), [sessions])

  /** Folders indexed by parent, so the tree can be walked. */
  const childFolders = useMemo(() => {
    const map = new Map<string | null, SessionFolder[]>()
    for (const folder of tree.folders) {
      const list = map.get(folder.parentId) ?? []
      list.push(folder)
      map.set(folder.parentId, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return map
  }, [tree.folders])

  const hostsByFolder = useMemo(() => {
    const map = new Map<string | null, SavedSession[]>()
    for (const session of tree.sessions) {
      const list = map.get(session.parentId) ?? []
      list.push(session)
      map.set(session.parentId, list)
    }
    return map
  }, [tree.sessions])

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (session: SavedSession): boolean => {
      if (tagFilter && !session.tags.includes(tagFilter)) return false
      if (!needle) return true
      return (
        session.name.toLowerCase().includes(needle) ||
        session.host.toLowerCase().includes(needle) ||
        session.username.toLowerCase().includes(needle)
      )
    }
  }, [filter, tagFilter])

  /*
   * Build the group tree.
   *
   * A group is kept if it holds a matching host anywhere below it, or if it has no
   * parent folder. So nesting works, and an empty top-level group still gets a
   * heading to drop things into.
   */
  const groups = useMemo(() => {
    const build = (parentId: string | null, depth: number, prefix: string): GroupNode[] => {
      const nodes: GroupNode[] = []
      for (const folder of childFolders.get(parentId) ?? []) {
        const path = prefix ? `${prefix} / ${folder.name}` : folder.name
        const children = build(folder.id, depth + 1, path)
        const hosts = (hostsByFolder.get(folder.id) ?? []).filter(matches)
        if (hosts.length > 0 || children.length > 0 || parentId === null) {
          nodes.push({ key: folder.id, id: folder.id, name: folder.name, path, depth, hosts, children })
        }
      }
      return nodes
    }

    const treeNodes = build(null, 0, '')
    const unfiled = (hostsByFolder.get(null) ?? []).filter(matches)
    if (unfiled.length > 0) {
      treeNodes.push({
        key: '__unfiled__',
        id: null,
        name: UNFILED,
        path: UNFILED,
        depth: 0,
        hosts: unfiled,
        children: []
      })
    }
    return treeNodes
  }, [childFolders, hostsByFolder, matches])

  const total = tree.sessions.length
  const groupCount = tree.folders.length

  const folderOf = (id: string | null): string =>
    (id && tree.folders.find((f) => f.id === id)?.name) || UNFILED

  const hostMenu = (session: SavedSession): MenuItem[] => [
    { id: 'connect', label: 'Connect' },
    { id: 'edit', label: 'Edit…' },
    { id: 'duplicate', label: 'Duplicate' },
    { id: 'newInGroup', label: 'New host here…', separatorBefore: true },
    { id: 'delete', label: 'Delete', danger: true, separatorBefore: true }
  ]

  const groupMenu = (node: GroupNode): MenuItem[] => [
    { id: 'newHost', label: 'New host…' },
    { id: 'newSub', label: 'New sub-group…', hint: 'nested' },
    { id: 'rename', label: 'Rename group…', disabled: node.id === null },
    {
      id: 'delete',
      label: 'Delete group',
      hint: node.id === null ? undefined : `${node.hosts.length} host(s)`,
      danger: true,
      separatorBefore: true,
      disabled: node.id === null
    }
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

  const openGroupMenu = (event: React.MouseEvent, node: GroupNode): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: groupMenu(node),
      run: (id) => {
        if (id === 'newHost') onNewHost(node.id)
        else if (id === 'newSub') onCreateGroup('New group', node.id)
        else if (id === 'rename' && node.id) setRenaming({ id: node.id, value: node.name })
        else if (id === 'delete' && node.id) onDeleteGroup(node.id)
      }
    })
  }

  /*
   * Right-clicking the page background offers the same things for the whole list.
   *
   * Somewhere to click that is not a host and not a group was previously dead — no
   * menu at all — which is where "add a host" is most naturally reached from once
   * the list has grown.
   */
  const openPageMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { id: 'newHost', label: 'New host…' },
        { id: 'newGroup', label: 'New group…' },
        { id: 'cards', label: 'Show as cards', disabled: view === 'cards', separatorBefore: true },
        { id: 'rows', label: 'Show as rows', disabled: view === 'list' }
      ],
      run: (id) => {
        if (id === 'newHost') onNewHost(null)
        else if (id === 'newGroup') onCreateGroup('New group', null)
        else if (id === 'cards') setView('cards')
        else if (id === 'rows') setView('list')
      }
    })
  }

  const startDrag = (event: React.DragEvent, kind: 'host' | 'group', id: string): void => {
    setDrag({ kind, id })
    event.dataTransfer?.setData('text/plain', id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  /** A group can also be dropped onto another group, to re-file it. */
  const dropOn = (node: GroupNode): void => {
    if (!drag) return
    if (drag.kind === 'host') {
      if (drag.id !== node.id) onMove(drag.id, node.id)
    } else if (drag.id !== node.id) {
      onMoveGroup(drag.id, node.id)
    }
  }

  const dropZone = (node: GroupNode): Record<string, unknown> => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(node.key)
    },
    onDragLeave: () => setDropTarget((t) => (t === node.key ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      dropOn(node)
      setDrag(null)
    }
  })

  const renderHosts = (hosts: SavedSession[], depth: number): JSX.Element => (
    <ul className={`td-host-list is-${view}`}>
      {hosts.map((session) => {
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
      {hosts.length === 0 && (
        <li className="td-host-group-empty" data-contrast-exempt>
          {depth > 0 ? 'Empty group' : 'No hosts in this group yet'}
        </li>
      )}
    </ul>
  )

  const renderGroup = (node: GroupNode): JSX.Element => (
    <section
      className={`td-host-group${dropTarget === node.key ? ' is-drop' : ''}`}
      key={node.key}
      data-host-group={node.path}
      data-group-depth={node.depth}
      {...dropZone(node)}
    >
      <div
        className="td-host-group-head"
        style={{ paddingLeft: `${node.depth * 14}px` }}
        onContextMenu={(e) => openGroupMenu(e, node)}
        draggable={node.id !== null}
        onDragStart={(e) => node.id && startDrag(e, 'group', node.id)}
        onDragEnd={() => setDrag(null)}
        data-testid={node.id === null ? 'hosts-group-unfiled' : 'hosts-group'}
      >
        <h2>{node.name}</h2>
        <span className="td-host-group-count" data-contrast-exempt>
          {node.hosts.length}
        </span>
        <span className="td-spacer" />
        <button
          className="td-icon-btn"
          title={`New host in ${node.path}`}
          data-new-host={node.path}
          onClick={() => onNewHost(node.id)}
        >
          +
        </button>
      </div>

      {renderHosts(node.hosts, node.depth)}
      {node.children.length > 0 && (
        <div className="td-host-subgroups">{node.children.map(renderGroup)}</div>
      )}
    </section>
  )

  return (
    <div className="td-page" data-testid="hosts-page" onContextMenu={openPageMenu}>
      <header className="td-page-head">
        <div>
          <h1>Hosts</h1>
          <p className="td-page-sub">
            {total} host{total === 1 ? '' : 's'} · {groupCount} group
            {groupCount === 1 ? '' : 's'} · {openTitles.size} connected
          </p>
        </div>
        <div className="td-page-actions">
          {renaming ? (
            <form
              className="td-rename-inline"
              data-testid="hosts-rename-form"
              onSubmit={(e) => {
                e.preventDefault()
                const name = renaming.value.trim()
                if (name) onRenameGroup(renaming.id, name)
                setRenaming(null)
              }}
            >
              <input
                className="td-page-search"
                aria-label="group-name"
                value={renaming.value}
                autoFocus
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
              <button className="td-btn td-btn-primary" type="submit" data-testid="hosts-rename-save">
                Rename
              </button>
              <button className="td-btn" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
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
            </>
          )}
        </div>
      </header>

      {knownTags.length > 0 && !renaming && (
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

      {/* Right-click anywhere that is not a host or a group opens the page menu,
          so "new host" is always one click away. */}
      <div className="td-page-body" data-testid="hosts-body" onContextMenu={openPageMenu}>
        {total === 0 && (
          <div className="td-page-empty">
            No hosts yet. Use <b>New host</b> above, or press <kbd>Ctrl</kbd>+<kbd>T</kbd> to connect
            without saving.
          </div>
        )}

        {groups.map(renderGroup)}

        {total > 0 && groups.length === 0 && (
          <div className="td-page-empty" data-testid="hosts-no-matches">
            No hosts match the current filter.
          </div>
        )}
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
