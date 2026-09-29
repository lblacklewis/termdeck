import { useMemo, useState, type JSX } from 'react'
import type { Snippet } from '@shared/types'

interface SnippetsPageProps {
  snippets: Snippet[]
  /** False when no terminal is open, so "Send" can be disabled honestly. */
  canSend: boolean
  onSend: (snippet: Snippet) => void
  onEdit: (snippet: Snippet) => void
  onNew: (group: string) => void
  onDelete: (id: string) => void
  /** Persist a new order (used by drag-to-reorder within a group). */
  onReorder: (ids: string[]) => void
}

const UNGROUPED = 'Ungrouped'

/**
 * Full-page snippet management.
 *
 * The bottom bar is for firing commands during a session; this page is for
 * maintaining them, where there is room for the command text itself.
 */
export function SnippetsPage({
  snippets,
  canSend,
  onSend,
  onEdit,
  onNew,
  onDelete,
  onReorder
}: SnippetsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching = needle
      ? snippets.filter(
          (s) =>
            s.label.toLowerCase().includes(needle) ||
            s.command.toLowerCase().includes(needle) ||
            s.group.toLowerCase().includes(needle)
        )
      : snippets

    const byGroup = new Map<string, Snippet[]>()
    for (const snippet of matching) {
      const group = snippet.group || UNGROUPED
      byGroup.set(group, [...(byGroup.get(group) ?? []), snippet])
    }
    // Keep the stored order inside each group rather than re-sorting.
    return [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [snippets, filter])

  const toggleGroup = (group: string): void =>
    setCollapsed((prev) => (prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]))

  /** Reorder within a group by rewriting the whole list order. */
  const reorder = (from: string, to: string): void => {
    if (from === to) return
    const ids = snippets.map((s) => s.id)
    const fromIndex = ids.indexOf(from)
    const toIndex = ids.indexOf(to)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = ids.splice(fromIndex, 1)
    ids.splice(toIndex, 0, moved)
    onReorder(ids)
  }

  return (
    <div className="td-page" data-testid="snippets-page">
      <header className="td-page-head">
        <div>
          <h1>Snippets</h1>
          <p className="td-page-sub">
            {snippets.length} saved command{snippets.length === 1 ? '' : 's'}
            {!canSend && ' · no active terminal'}
          </p>
        </div>
        <div className="td-page-actions">
          <input
            className="td-page-search"
            aria-label="filter-snippets"
            placeholder="Filter commands"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="td-btn td-btn-primary" data-testid="snippets-new" onClick={() => onNew('')}>
            New snippet
          </button>
        </div>
      </header>

      <div className="td-page-body">
        {snippets.length === 0 && (
          <div className="td-page-empty">
            No snippets yet. Save a command here once and send it to any session with a click.
          </div>
        )}

        {snippets.length > 0 && groups.length === 0 && (
          <div className="td-page-empty">No snippet matches that filter.</div>
        )}

        {groups.map(([group, items]) => {
          const isCollapsed = collapsed.includes(group)
          return (
            <section className="td-snippet-group-section" key={group} data-group={group}>
              <header className="td-snippet-group-head">
                <button
                  className="td-snippet-group-toggle"
                  onClick={() => toggleGroup(group)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="td-caret" data-contrast-exempt>
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="td-snippet-group-name">{group}</span>
                  <span className="td-node-count" data-contrast-exempt>
                    {items.length}
                  </span>
                </button>
                <button
                  className="td-mini"
                  title={`New snippet in ${group}`}
                  onClick={() => onNew(group === UNGROUPED ? '' : group)}
                >
                  +
                </button>
              </header>

              {!isCollapsed && (
                <ul className="td-snippet-rows">
                  {items.map((snippet) => (
                    <li
                      key={snippet.id}
                      className={`td-snippet-row${dragging === snippet.id ? ' is-dragging' : ''}${
                        dropTarget === snippet.id ? ' is-drop' : ''
                      }`}
                      data-snippet-row={snippet.id}
                      draggable
                      onDragStart={(e) => {
                        setDragging(snippet.id)
                        e.dataTransfer.setData('text/plain', snippet.id)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropTarget(null)
                      }}
                      onDragOver={(e) => {
                        if (!dragging) return
                        e.preventDefault()
                        if (dropTarget !== snippet.id) setDropTarget(snippet.id)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const from = e.dataTransfer.getData('text/plain') || dragging
                        setDropTarget(null)
                        setDragging(null)
                        if (from) reorder(from, snippet.id)
                      }}
                    >
                      <span className="td-drag-grip" title="Drag to reorder">
                        ⠿
                      </span>
                      <div className="td-snippet-row-main">
                        <span className="td-snippet-row-label">{snippet.label}</span>
                        <code className="td-snippet-row-command" title={snippet.command}>
                          {snippet.command}
                        </code>
                      </div>
                      <span
                        className="td-pill"
                        title={
                          /\r?\n\s*$/.test(snippet.command)
                            ? 'Ends with a newline, so it runs'
                            : 'No trailing newline, so it is only typed'
                        }
                      >
                        {/\r?\n\s*$/.test(snippet.command) ? 'runs' : 'types'}
                      </span>
                      <div className="td-snippet-row-actions">
                        <button
                          className="td-btn td-btn-sm"
                          disabled={!canSend}
                          data-action="send"
                          onClick={() => onSend(snippet)}
                        >
                          Send
                        </button>
                        <button
                          className="td-btn td-btn-sm"
                          data-action="edit"
                          onClick={() => onEdit(snippet)}
                        >
                          Edit
                        </button>
                        <button
                          className="td-btn td-btn-sm td-btn-danger"
                          data-action="delete"
                          onClick={() => onDelete(snippet.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
