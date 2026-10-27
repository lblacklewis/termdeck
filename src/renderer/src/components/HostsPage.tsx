import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { HostsView, SavedSession, SessionFolder, SessionInfo, SessionTree } from '@shared/types'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { describeTarget } from './sessionLabel'
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
  /**
   * Groups folded away, by group key, owned by the shell so it survives this page
   * being unmounted — which it is whenever another rail section is showing.
   */
  folded: string[]
  onFoldedChange: (next: string[]) => void
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
  /*
   * Batch actions, for the hosts ticked in a selection. Each goes through one main
   * process call, so a selection of twenty is one write and one broadcast rather than
   * twenty of each.
   */
  onDeleteHosts: (ids: string[]) => void
  onDuplicateHosts: (ids: string[]) => void
  onMoveHosts: (ids: string[], parentId: string | null) => void
  /** Share the whole list with someone else, or read theirs in. */
  onExportShare: () => void
  onImportShare: () => void
  /** Read this machine's ~/.ssh/config in as hosts. */
  onImportSshConfig: () => void
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
  onDeleteHosts,
  onDuplicateHosts,
  onMoveHosts,
  view,
  onViewChange,
  folded,
  onFoldedChange,
  onExportShare,
  onImportShare,
  onImportSshConfig
}: HostsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  /**
   * Tags the list is narrowed to.
   *
   * A set, not one tag: "which of my boxes are both web and prod" is the question
   * tags are for. Chips toggle, and a host has to carry all of them.
   */
  const [tagFilters, setTagFilters] = useState<string[]>([])
  const [menu, setMenu] = useState<{
    x: number
    y: number
    items: MenuItem[]
    run: (id: string) => void
    /** Distinguishes the move-target menu from the row menus in a probe. */
    testId?: string
  } | null>(null)
  const [drag, setDrag] = useState<{ kind: 'host' | 'group'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /*
   * Ticked hosts.
   *
   * Page state on purpose: a selection is a thing you are doing right now, not a
   * preference. Leaving the page drops it, which is what you want — coming back to a
   * list with rows still ticked from ten minutes ago is how people delete the wrong
   * thing.
   */
  const [selected, setSelected] = useState<string[]>([])
  /** Delete is two-step: the ticked range is worth one question first. */
  const [confirmDelete, setConfirmDelete] = useState(false)

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
      if (tagFilters.length > 0 && !tagFilters.every((tag) => session.tags.includes(tag))) {
        return false
      }
      if (!needle) return true
      return (
        session.name.toLowerCase().includes(needle) ||
        session.host.toLowerCase().includes(needle) ||
        session.username.toLowerCase().includes(needle) ||
        /*
         * Tags are part of how people remember a host, so the same box searches
         * them: typing "web" should find it whether it is the name or a label.
         */
        session.tags.some((tag) => tag.toLowerCase().includes(needle))
      )
    }
  }, [filter, tagFilters])

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
  /**
   * Whether the list is narrowed to matches.
   *
   * A filter also overrides folding: the rows left are the ones somebody asked for,
   * so hiding some of them behind a fold can only lose the host they were looking
   * for. Hoisted out of the tree below because the rendering needs it as well.
   */
  const filtering = useMemo(
    () => filter.trim().length > 0 || tagFilters.length > 0,
    [filter, tagFilters]
  )

  const groups = useMemo(() => {
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
  }, [childFolders, hostsByFolder, matches, filtering])

  /** Every group on screen, however deep, so "fold them all" means all of them. */
  const allGroupKeys = useMemo(() => {
    const keys: string[] = []
    const walk = (nodes: GroupNode[]): void => {
      for (const node of nodes) {
        keys.push(node.key)
        walk(node.children)
      }
    }
    walk(groups)
    return keys
  }, [groups])

  const foldedSet = useMemo(() => new Set(folded), [folded])

  const toggleFold = useCallback(
    (key: string): void => {
      onFoldedChange(
        folded.includes(key) ? folded.filter((entry) => entry !== key) : [...folded, key]
      )
    },
    [folded, onFoldedChange]
  )

  /**
   * Every host the page is currently showing, in list order.
   *
   * This is what "select all" means, and therefore what a batch action acts on. A
   * folded group is not on screen, so ticking its hosts would build a selection the
   * user cannot see — and then delete it. Same rule as the filter: the page never
   * acts on a host it is not showing.
   */
  const shownHostIds = useMemo(() => {
    const ids: string[] = []
    const walk = (nodes: GroupNode[]): void => {
      for (const node of nodes) {
        if (!filtering && foldedSet.has(node.key)) continue
        for (const host of node.hosts) ids.push(host.id)
        walk(node.children)
      }
    }
    walk(groups)
    return ids
  }, [groups, foldedSet, filtering])

  // Keep the selection honest when a filter or a fold takes hosts off the page.
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(shownHostIds)
      const next = prev.filter((id) => allowed.has(id))
      return next.length === prev.length ? prev : next
    })
    setConfirmDelete(false)
  }, [shownHostIds])

  const selectedCount = selected.length
  const allSelected = shownHostIds.length > 0 && selectedCount === shownHostIds.length

  const toggleHost = (id: string): void => {
    setConfirmDelete(false)
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    )
  }

  /**
   * Run a batch action and end the selection.
   *
   * For all three: hosts that were just copied or re-filed are not the hosts the
   * ticks were on, and leaving them ticked points the *next* click at something the
   * user has stopped looking at.
   */
  const runBatch = (action: () => void): void => {
    action()
    setSelected([])
    setConfirmDelete(false)
  }

  /**
   * Every group as a move target, with its full path.
   *
   * Built from the folder tree rather than from the rendered groups: while a search
   * is on, the groups with no match are not drawn, and "move these to Archive" is
   * exactly the thing somebody searching for one host wants to do.
   */
  const moveTargets = useMemo(() => {
    const out: Array<{ id: string | null; label: string }> = []
    const walk = (parentId: string | null, prefix: string): void => {
      for (const folder of childFolders.get(parentId) ?? []) {
        const path = prefix ? `${prefix} / ${folder.name}` : folder.name
        out.push({ id: folder.id, label: path })
        walk(folder.id, path)
      }
    }
    walk(null, '')
    out.push({ id: null, label: t('hostspage.unfiled', 'Unfiled') })
    return out
  }, [childFolders])

  const openMoveMenu = (event: React.MouseEvent): void => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: rect.left,
      y: rect.bottom + 4,
      testId: 'hosts-move-menu',
      items: moveTargets.map((target) => ({
        id: 'move:' + (target.id ?? 'root'),
        label: target.label
      })),
      run: (id) => {
        if (id.indexOf('move:') !== 0) return
        const raw = id.slice('move:'.length)
        runBatch(() => onMoveHosts(selected, raw === 'root' ? null : raw))
      }
    })
  }

  const total = tree.sessions.length
  const groupCount = tree.folders.length
  const hostMenu = (): MenuItem[] => [
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
      items: hostMenu(),
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
    /*
     * Folding is offered for the whole list as well as per group. The case that asks
     * for it is a library with more groups than fit on a screen: folding them one at
     * a time is not a way to find anything.
     */
    const allFolded = allGroupKeys.length > 0 && allGroupKeys.every((key) => foldedSet.has(key))
    const anyFolded = allGroupKeys.some((key) => foldedSet.has(key))
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { id: 'newHost', label: t('hostspage.new_host_2', 'New host…') },
        { id: 'newGroup', label: t('hostspage.new_group', 'New group…') },
        { id: 'cards', label: t('hostspage.show_as_cards', 'Show as cards'), disabled: view === 'cards', separatorBefore: true },
        { id: 'rows', label: t('hostspage.show_as_rows', 'Show as rows'), disabled: view === 'list' },
        // Disabled while a filter is on: the list is already only matches, and
        // folding has no visible effect to offer.
        {
          id: 'foldAll',
          label: t('hostspage.collapse_all', 'Collapse all groups'),
          disabled: filtering || allFolded,
          separatorBefore: true
        },
        {
          id: 'unfoldAll',
          label: t('hostspage.expand_all', 'Expand all groups'),
          disabled: filtering || !anyFolded
        }
      ],
      run: (id) => {
        if (id === 'newHost') onNewHost(null)
        else if (id === 'newGroup') onCreateGroup(null)
        else if (id === 'cards') onViewChange('cards')
        else if (id === 'rows') onViewChange('list')
        else if (id === 'foldAll') onFoldedChange(allGroupKeys)
        else if (id === 'unfoldAll') onFoldedChange([])
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
            className={`td-host-row is-${view}${connected ? ' is-connected' : ''}${selected.includes(session.id) ? ' is-selected' : ''}`}
            data-host-row={session.id}
            draggable
            onDragStart={(e) => startDrag(e, 'host', session.id)}
            onDragEnd={() => setDrag(null)}
            onDoubleClick={() => onConnect(session)}
            onContextMenu={(e) => openHostMenu(e, session)}
          >
            {/*
              The tick box is always drawn, not revealed on hover: a control that only
              exists while the pointer is in the right place is one nobody finds. Its
              double click is swallowed so a quick double tick cannot fall through to
              the row and start a connection.
            */}
            <input
              type="checkbox"
              className="td-host-check"
              data-testid="select-host"
              data-host-id={session.id}
              checked={selected.includes(session.id)}
              onChange={() => toggleHost(session.id)}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t('hostspage.select_host', 'Select host')}
              title={t('hostspage.select_host', 'Select host')}
            />
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
                {describeTarget(session)}
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

  const renderGroup = (node: GroupNode): JSX.Element => {
    /*
     * A folded group keeps its heading — that is the whole point: the shape of the
     * library stays readable while the hosts are out of the way. It also stays a drop
     * target, which is why only its *contents* are conditional.
     *
     * While a filter is on, nothing is folded and no fold control is drawn: the list
     * is already only matches, so a fold could only hide one of them.
     */
    const collapsed = !filtering && foldedSet.has(node.key)
    const foldLabel = collapsed
      ? t('hostspage.expand_group', 'Expand group')
      : t('hostspage.collapse_group', 'Collapse group')

    return (
      <section
        className={`td-host-group${collapsed ? ' is-folded' : ''}${dropTarget === node.key ? ' is-drop' : ''}`}
        key={node.key}
        data-host-group={node.path}
        data-group-depth={node.depth}
        data-folded={collapsed ? 'true' : 'false'}
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
          {!filtering && (
            <button
              className="td-host-fold"
              data-testid="hosts-group-fold"
              data-fold-key={node.key}
              aria-expanded={!collapsed}
              aria-label={foldLabel}
              title={foldLabel}
              onClick={(e) => {
                // The heading is a drag handle; the fold control is not.
                e.stopPropagation()
                toggleFold(node.key)
              }}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          )}
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

        {!collapsed && renderHosts(node.hosts, node.depth)}
        {!collapsed && node.children.length > 0 && (
          <div className="td-host-subgroups">{node.children.map(renderGroup)}</div>
        )}
      </section>
    )
  }

  return (
    <div className="td-page" data-testid="hosts-page" onContextMenu={openPageMenu}>
      <header className="td-page-head">
        <div className="td-page-search-row">
          <span className="td-page-search-icon" aria-hidden="true" />
          <input
            className="td-page-search"
            data-testid="hosts-search"
            aria-label="filter-hosts"
            placeholder={t('hostspage.filter_hosts_or_user_hostnam', 'Filter hosts or user@hostname…')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="td-page-bar">
          <h1 className="td-sr-only">{t('hostspage.hosts', 'Hosts')}</h1>
          <div className="td-page-actions">
            {/*
              Ticking everything listed. It sits first because it is the way into the
              batch actions, and it counts what is *shown*: a folded group is not on
              screen, and a selection nobody can see is one nobody meant to make.
            */}
            <label className="td-select-all" data-testid="hosts-select-all">
              <input
                type="checkbox"
                data-testid="select-all-hosts"
                checked={allSelected}
                disabled={shownHostIds.length === 0}
                onChange={() => setSelected(allSelected ? [] : [...shownHostIds])}
              />
              <span>{t('hostspage.select_all_hosts', 'Select all')}</span>
            </label>
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
            {/*
              The OpenSSH config is the second import source, and it gets its own
              button rather than a menu behind "Import": they read from completely
              different places (an encrypted share file vs. the local ~/.ssh/config),
              and the difference is the first thing a user needs to see.
            */}
            <button
              className="td-btn"
              data-testid="hosts-import-config"
              onClick={onImportSshConfig}
            >
              {t('hostspage.import_ssh_config', 'SSH config…')}
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
                {knownTags.map((tag) => {
                  const on = tagFilters.includes(tag)
                  return (
                    <button
                      key={tag}
                      className={`td-tag td-tag-filterable${on ? ' is-on' : ''}`}
                      data-testid="hosts-tag-filter"
                      data-tag={tag}
                      aria-pressed={on}
                      onClick={() =>
                        setTagFilters((prev) =>
                          prev.includes(tag)
                            ? prev.filter((entry) => entry !== tag)
                            : [...prev, tag]
                        )
                      }
                      title={on ? `Clear filter: ${tag}` : `Filter by: ${tag}`}
                    >
                      {tag}
                    </button>
                  )
                })}
                {tagFilters.length > 0 && (
                  <button
                    className="td-tag td-tag-clear"
                    data-testid="hosts-tag-clear"
                    onClick={() => setTagFilters([])}
                    title={t('hostspage.clear_tags', 'Clear the tag filter')}
                  >
                    ×
                  </button>
                )}
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

      {/*
        The batch bar appears only while something is ticked, in its own row: four
        controls plus a count do not fit beside the page's own actions without
        shoving them around, and this reads as what it is — a mode you are in.
      */}
      {selectedCount > 0 && (
        <div className="td-batch-bar" data-testid="hosts-batch-bar">
          <span className="td-batch-count" data-testid="hosts-selected-count">
            {t('hostspage.n_selected', '{count} selected', { count: selectedCount })}
          </span>
          <button className="td-btn" data-testid="batch-move-hosts" onClick={openMoveMenu}>
            {t('hostspage.move_to', 'Move to…')}
          </button>
          <button
            className="td-btn"
            data-testid="batch-duplicate-hosts"
            onClick={() => runBatch(() => onDuplicateHosts(selected))}
          >
            {t('hostspage.duplicate', 'Duplicate')}
          </button>
          {/*
            Deleting asks first. Re-adding one host is a nuisance; re-adding a ticked
            range is a lost afternoon, and there is no undo here.
          */}
          {confirmDelete ? (
            <>
              <button
                className="td-btn td-btn-danger"
                data-testid="confirm-delete-hosts"
                onClick={() => runBatch(() => onDeleteHosts(selected))}
              >
                {t('hostspage.delete_n_hosts', 'Delete {count} hosts', { count: selectedCount })}
              </button>
              <button
                className="td-btn"
                data-testid="cancel-delete-hosts"
                onClick={() => setConfirmDelete(false)}
              >
                {t('hostspage.cancel', 'Cancel')}
              </button>
            </>
          ) : (
            <button
              className="td-btn td-btn-danger"
              data-testid="batch-delete-hosts"
              onClick={() => setConfirmDelete(true)}
            >
              {t('hostspage.delete', 'Delete')}
            </button>
          )}
          <span className="td-spacer" />
          <button
            className="td-btn"
            data-testid="clear-host-selection"
            onClick={() => setSelected([])}
          >
            {t('hostspage.clear_selection', 'Clear selection')}
          </button>
        </div>
      )}

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
          testId={menu.testId ?? 'hosts-menu'}
          onSelect={menu.run}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
