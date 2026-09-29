import { useMemo, useState, type JSX } from 'react'
import type { Snippet } from '@shared/types'

interface SnippetBarProps {
  snippets: Snippet[]
  /** True when there is a terminal that can receive a command. */
  canSend: boolean
  onSend: (snippet: Snippet) => void
  onEdit: (snippet: Snippet) => void
  onNew: (group: string) => void
  onDelete: (id: string) => void
  onHide: () => void
}

const ALL = '__all__'

/**
 * Bottom bar of saved commands.
 *
 * Snippets are grouped by their `group` field; the tab strip is derived from the
 * data, so creating a group needs no separate registry. Clicking sends to the
 * active terminal, right-clicking exposes edit/delete.
 */
export function SnippetBar({
  snippets,
  canSend,
  onSend,
  onEdit,
  onNew,
  onDelete,
  onHide
}: SnippetBarProps): JSX.Element {
  const [activeGroup, setActiveGroup] = useState<string>(ALL)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const groups = useMemo(() => {
    const seen: string[] = []
    for (const snippet of snippets) {
      const group = snippet.group || 'Ungrouped'
      if (!seen.includes(group)) seen.push(group)
    }
    return seen
  }, [snippets])

  const visible = useMemo(
    () =>
      activeGroup === ALL
        ? snippets
        : snippets.filter((s) => (s.group || 'Ungrouped') === activeGroup),
    [snippets, activeGroup]
  )

  // A tab can disappear when its last snippet is deleted or renamed.
  const effectiveGroup = groups.includes(activeGroup) || activeGroup === ALL ? activeGroup : ALL

  return (
    <div className="td-snippet-bar" data-testid="snippet-bar">
      <div className="td-snippet-groups">
        <button
          className={`td-snippet-group${effectiveGroup === ALL ? ' is-active' : ''}`}
          onClick={() => setActiveGroup(ALL)}
          data-group={ALL}
        >
          All
          <span className="td-snippet-count" data-contrast-exempt>
            {snippets.length}
          </span>
        </button>
        {groups.map((group) => (
          <button
            key={group}
            className={`td-snippet-group${effectiveGroup === group ? ' is-active' : ''}`}
            onClick={() => setActiveGroup(group)}
            data-group={group}
          >
            {group}
            <span className="td-snippet-count" data-contrast-exempt>
              {snippets.filter((s) => (s.group || 'Ungrouped') === group).length}
            </span>
          </button>
        ))}
      </div>

      <div className="td-snippet-items">
        {visible.length === 0 && (
          <span className="td-snippet-empty">
            No snippets yet — click <b>+</b> to save a command.
          </span>
        )}

        {visible.map((snippet) => (
          <div key={snippet.id} className="td-snippet-slot">
            <button
              className={`td-snippet${canSend ? '' : ' is-disabled'}`}
              data-snippet-id={snippet.id}
              data-snippet-label={snippet.label}
              title={
                (snippet.description ? snippet.description + '\n' : '') +
                snippet.command +
                (canSend ? '' : '\n(no active terminal)')
              }
              disabled={!canSend}
              onClick={() => onSend(snippet)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuFor(menuFor === snippet.id ? null : snippet.id)
              }}
            >
              {snippet.label}
            </button>

            {menuFor === snippet.id && (
              <>
                {/* Click-away layer; the menu itself sits above it. */}
                <div className="td-snippet-menu-backdrop" onClick={() => setMenuFor(null)} />
                <div className="td-snippet-menu" data-testid="snippet-menu">
                  <button
                    data-action="send"
                    disabled={!canSend}
                    onClick={() => {
                      setMenuFor(null)
                      onSend(snippet)
                    }}
                  >
                    Send to terminal
                  </button>
                  <button
                    data-action="edit"
                    onClick={() => {
                      setMenuFor(null)
                      onEdit(snippet)
                    }}
                  >
                    Edit…
                  </button>
                  <button
                    data-action="duplicate"
                    onClick={() => {
                      setMenuFor(null)
                      onEdit({ ...snippet, id: '', label: `${snippet.label} copy` })
                    }}
                  >
                    Duplicate
                  </button>
                  <div className="td-menu-sep" />
                  <button
                    data-action="delete"
                    className="is-danger"
                    onClick={() => {
                      setMenuFor(null)
                      onDelete(snippet.id)
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="td-snippet-actions">
        <button
          className="td-icon-btn"
          title={
            effectiveGroup === ALL ? 'New snippet' : `New snippet in “${effectiveGroup}”`
          }
          data-testid="snippet-new"
          onClick={() => onNew(effectiveGroup === ALL ? '' : effectiveGroup)}
        >
          +
        </button>
        <button className="td-icon-btn" title="Hide snippet bar" onClick={onHide}>
          ⌄
        </button>      </div>
    </div>
  )
}
