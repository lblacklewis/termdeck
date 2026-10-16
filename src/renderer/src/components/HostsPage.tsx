import { useMemo, useState, type JSX } from 'react'
import type { HostsView, SavedSession, SessionFolder, SessionInfo, SessionTree } from '@shared/types'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { t } from '../i18n'

interface HostsPageProps {
  tree: SessionTree
  /** Open connections, so the list can mark what is already running. */
  sessions: SessionInfo[]
  knownTags: string[]
  /**
   * Rows or cards, owned by the shell so it survives leaving the page — this
   * component is unmounted whenever another rail section is showing.
   */
  view: HostsView
  onViewChange: (view: HostsView) => void
  onConnect: (session: SavedSession) => void
  onEdit: (session: SavedSession) => void
  onDelete: (id: string) => void
  onDuplicate: (session: SavedSession) => void
  onNewHost: (parentId: string | null) => void
  /** Open the naming prompt; the shell owns the dialog and the save. */
  onCreateGroup: (parentId: string | null) => void
  onRenameGroup: (id: string) => void
  onDeleteGroup: (id: string) => void
  onMove: (sessionId: string, parentId: string | null) => void
  /** Re-file a whole group, which is how nesting is rearranged. */
  onMoveGroup: (folderId: string, parentId: string | null) => void
  /** Share the whole list with someone else, or read theirs in. */
  onExportShare: () => void
  onImportShare: () => void
}

const UNFILED = 'Unfiled'

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
  onMoveGroup,
  view,
  onViewChange,
  onExportShare,
  onImportShare
}: HostsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
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
   * Every named group is kept, at every level, whether or not it holds anything:
   * a group is also a drop target, so a newly created one has to be visible before
   * there is anything in it. (An earlier version only kept empty groups at the top
   * level, which meant "New sub-group…" created a group that simply did not appear
   * until a host was dragged into it — indistinguishable from the button failing.)
   *
   * The one exception is a *search*: with a filter or tag active, a group with no
   * matching host anywhere below it is noise, so it is dropped.
   */
  const groups = useMemo(() => {
    const filtering = filter.trim().length > 0 || tagFilter !== null

    const build = (parentId: string | null, depth: number, prefix: string): GroupNode[] => {
      const nodes: GroupNode[] = []
      for (const folder of childFolders.get(parentId) ?? []) {
        const path = prefix ? `${prefix} / ${folder.name}` : folder.name
        const children = build(folder.id, depth + 1, path)
        const hosts = (hostsByFolder.get(folder.id) ?? []).filter(matches)
        if (!filtering || hosts.length > 0 || children.length > 0) {
          nodes.push({ key: folder.id, id: folder.id, name: folder.name, path, depth, hosts, children })
        }
      }
      return nodes
    }

    const treeNodes = build(null, 0, '')
    const unfiled = (hostsByFolder.get(null) ?? []).filter(matches)
    /*
     * The catch-all is always shown while browsing, for the same reason every named
     * group is: it is a drop target, and it is where "take this host out of its
     * folder" lands. Only a search hides it, when nothing matches.
     */
    if (!filtering || unfiled.length > 0) {
      treeNodes.push({
        key: '__unfiled__',
        id: null,
        // The label is translated; `path` stays the constant, because it is what
        // the drag targets and the smoke probes key on.
        name: t('hostspage.unfiled', 'Unfiled'),
        path: UNFILED,
        depth: 0,
        hosts: unfiled,
        children: []
      })
    }
    return treeNodes
  }, [childFolders, hostsByFolder, matches, filter, tagFilter])

  const total = tree.sessions.length
  const groupCount = tree.folders.length

  const folderOf = (id: string | null): string =>
    (id && tree.folders.find((f) => f.id === id)?.name) || t('hostspage.unfiled', 'Unfiled')

  const hostMenu = (session: SavedSession): MenuItem[] => [
    { id: 'connect', label: t('hostspage.connect', 'Connect') },
    { id: 'edit', label: t('hostspage.edit', 'Edit…') },
    { id: 'duplicate', label: t('hostspage.duplicate', 'Duplicate') },
    { id: 'newInGroup', label: t('hostspage.new_host_here', 'New host here…'), separatorBefore: true },
    { id: 'delete', label: t('hostspage.delete', 'Delete'), danger: true, separatorBefore: true }
  ]

  const groupMenu = (node: GroupNode): MenuItem[] => [
    { id: 'newHost', label: t('hostspage.new_host', 'New host…') },
    { id: 'newSub', label: t('hostspage.new_sub_group', 'New sub-group…'), hint: 'nested' },
    { id: 'rename', label: t('hostspage.rename_group', 'Rename group…'), disabled: node.id === null },
    {
      id: 'delete',
      label: t('hostspage.delete_group', 'Delete group'),
      hint:
        node.id === null
          ? undefined
          : t('hostspage.host_count', '{n} host(s)', { n: node.hosts.length }),
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
        else if (id === 'newSub') onCreateGroup(node.id)
        else if (id === 'rename' && node.id) onRenameGroup(node.id)
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
        { id: 'newHost', label: t('hostspage.new_host_2', 'New host…') },
        { id: 'newGroup', label: t('hostspage.new_group', 'New group…') },
        { id: 'cards', label: t('hostspage.show_as_cards', 'Show as cards'), disabled: view === 'cards', separatorBefore: true },
        { id: 'rows', label: t('hostspage.show_as_rows', 'Show as rows'), disabled: view === 'list' }
      ],
      run: (id) => {
        if (id === 'newHost') onNewHost(null)
        else if (id === 'newGroup') onCreateGroup(null)
        else if (id === 'cards') onViewChange('cards')
        else if (id === 'rows') onViewChange('list')
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
    /*
     * `dragenter` as well as `dragover`, both cancelling the default.
     *
     * The session tree does this and the page did not, and the difference matters:
     * a target that only handles `dragover` may accept the drop in one Chromium
     * path and refuse it in another, and when it refuses, `drop` never fires at
     * all — the gesture does nothing, with no error anywhere.
     */
    onDragEnter: (e: React.DragEvent) => {
      if (!drag) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(node.key)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
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
              title={
                connected
                  ? t('hostspage.connected', 'Connected')
                  : t('hostspage.not_connected', 'Not connected')
              }
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
                {connected
                  ? t('hostspage.focus', 'Focus')
                  : t('hostspage.connect', 'Connect')}
              </button>
              <button
                className="td-icon-btn"
                data-action="menu"
                title={t('hostspage.more', 'More…')}
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
          {depth > 0
            ? t('hostspage.empty_group', 'Empty group')
            : t('hostspage.no_hosts_in_group', 'No hosts in this group yet')}
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
        <div className="td-page-search-row">
          <span className="td-page-search-icon" aria-hidden="true" />
          <input
            className="td-page-search"
            aria-label="filter-hosts"
            placeholder={t('hostspage.filter_hosts_or_user_hostnam', 'Filter hosts or user@hostname…')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="td-page-bar">
          <h1 className="td-sr-only">{t('hostspage.hosts', 'Hosts')}</h1>
          <div className="td-page-actions">
            <button
              className="td-btn td-btn-primary"
              data-testid="hosts-new-host"
              onClick={() => onNewHost(null)}
            >
              {t('hostspage.new_host_3', '+ New host')}
            </button>
            <button
              className="td-btn"
              data-testid="hosts-new-group"
              onClick={() => onCreateGroup(null)}
            >
              {t('hostspage.new_group_2', 'New group')}
            </button>
            {/*
              Sharing sits with the other list-level actions: it is about the whole
              list, and burying it in a menu would hide the one thing a new
              colleague needs to be told about.
            */}
            <button className="td-btn" data-testid="hosts-import" onClick={onImportShare}>
              {t('hostspage.import', 'Import')}
            </button>
            <button className="td-btn" data-testid="hosts-export" onClick={onExportShare}>
              {t('hostspage.export', 'Export')}
            </button>
            {/*
              Tag filters sit with the actions rather than in a row of their own:
              they are the same kind of thing as the view switch (a way of narrowing
              what is listed), and the reference app keeps them on this line too.
            */}
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
          </div>
          <div className="td-page-meta">
            <span className="td-page-sub">
              {t('hostspage.summary', '{hosts} hosts · {groups} groups · {connected} connected', {
                hosts: total,
                groups: groupCount,
                connected: openTitles.size
              })}
            </span>
            <div className="td-view-switch" role="group" aria-label={t('hostspage.host_list_style', 'Host list style')}>
              <button
                className={`td-seg-btn${view === 'list' ? ' is-active' : ''}`}
                data-testid="hosts-view-list"
                aria-pressed={view === 'list'}
                aria-label={t('hostspage.rows', 'Rows')}
                title={t('hostspage.rows_2', 'Rows')}
                onClick={() => onViewChange('list')}
              >
                ☰
              </button>
              <button
                className={`td-seg-btn${view === 'cards' ? ' is-active' : ''}`}
                data-testid="hosts-view-cards"
                aria-pressed={view === 'cards'}
                aria-label={t('hostspage.cards', 'Cards')}
                title={t('hostspage.cards_2', 'Cards')}
                onClick={() => onViewChange('cards')}
              >
                ▦
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Right-click anywhere that is not a host or a group opens the page menu,
          so "new host" is always one click away. */}
      <div className="td-page-body" data-testid="hosts-body" onContextMenu={openPageMenu}>
        {total === 0 && (
          <div className="td-page-empty">
            {t('hostspage.no_hosts_yet_use', 'No hosts yet. Use')}<b>{t('hostspage.new_host_4', 'New host')}</b> {t('hostspage.above_or_press', 'above, or press')}<kbd>{t('hostspage.ctrl', 'Ctrl')}</kbd>+<kbd>T</kbd> {t('hostspage.to_connect_without_saving', 'to connect without saving.')}
          </div>
        )}

        {groups.map(renderGroup)}

        {total > 0 && groups.length === 0 && (
          <div className="td-page-empty" data-testid="hosts-no-matches">
            {t('hostspage.no_hosts_match_the_current_f', 'No hosts match the current filter.')}
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
