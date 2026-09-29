import { useMemo, useState, type JSX } from 'react'
import type { SavedSession, SessionInfo, SessionTree } from '@shared/types'

interface HostsPageProps {
  tree: SessionTree
  /** Open connections, so the list can mark what is already running. */
  sessions: SessionInfo[]
  knownTags: string[]
  onConnect: (session: SavedSession) => void
  onEdit: (session: SavedSession) => void
}

const UNFILED = 'Unfiled'

/**
 * Full-page host list, mirroring the Termius layout: grouped rows with a status
 * dot, the address underneath, and the primary action on the right.
 */
export function HostsPage({
  tree,
  sessions,
  knownTags,
  onConnect,
  onEdit
}: HostsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const openTitles = useMemo(() => new Set(sessions.map((s) => s.title)), [sessions])

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

    const folderName = (id: string | null): string =>
      (id && tree.folders.find((f) => f.id === id)?.name) || UNFILED

    const byFolder = new Map<string, SavedSession[]>()
    for (const session of matching) {
      const name = folderName(session.parentId)
      byFolder.set(name, [...(byFolder.get(name) ?? []), session])
    }

    // Folders that exist but hold nothing still deserve a heading.
    for (const folder of tree.folders) {
      if (!byFolder.has(folder.name)) byFolder.set(folder.name, [])
    }

    return [...byFolder.entries()].sort((a, b) => {
      // "Unfiled" sinks to the bottom; the rest stay alphabetical.
      if (a[0] === UNFILED) return 1
      if (b[0] === UNFILED) return -1
      return a[0].localeCompare(b[0])
    })
  }, [tree, filter, tagFilter])

  const total = tree.sessions.length

  return (
    <div className="td-page" data-testid="hosts-page">
      <header className="td-page-head">
        <div>
          <h1>Hosts</h1>
          <p className="td-page-sub">
            {total} host{total === 1 ? '' : 's'} · {openTitles.size} connected
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
            No hosts yet. Add one from the session list, or press <kbd>Ctrl</kbd>+<kbd>T</kbd> to
            connect without saving.
          </div>
        )}

        {total > 0 &&
          groups.map(([group, items]) => (
            <section className="td-host-group" key={group} data-host-group={group}>
              <h2 className="td-host-group-head">{group}</h2>

              {items.length === 0 && <p className="td-hint td-host-group-empty">Empty folder</p>}

              <ul className="td-host-list">
                {items.map((session) => {
                  const connected = openTitles.has(session.name)
                  return (
                    <li
                      key={session.id}
                      className={`td-host-row${connected ? ' is-connected' : ''}`}
                      data-host-row={session.id}
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
                          className="td-btn td-btn-sm"
                          data-action="edit"
                          onClick={() => onEdit(session)}
                        >
                          Edit
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
      </div>
    </div>
  )
}
