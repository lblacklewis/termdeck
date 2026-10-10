import { useMemo, useState, type JSX } from 'react'
import type { Snippet } from '@shared/types'
import { ContextMenu, type MenuItem } from './ContextMenu'

interface SnippetBarProps {
  snippets: Snippet[]
  /** True when there is a terminal that can receive a command. */
  canSend: boolean
  onSend: (snippet: Snippet) => void
  onEdit: (snippet: Snippet) => void
  onNew: (group: string) => void
  onDelete: (id: string) => void
  /** Move a snippet to another group; an empty string means the default group. */
  onSetGroup: (id: string, group: string) => void
  /** Reorder the whole list, which is what the tab strip is derived from. */
  onReorder: (ids: string[]) => void
  onHide: () => void
}

const ALL = '__all__'
const UNGROUPED = 'Ungrouped'

/**
 * Bottom bar of saved commands.
 *
 * Snippets are grouped by their `group` field; the tab strip is derived from the
 * data, so creating a group needs no separate registry. Clicking sends to the
 * active terminal. Right-clicking opens the shared context menu, and dragging a
 * chip onto another chip reorders it while dragging it onto a group tab moves it
 * to that group — the two things a bar of saved commands is actually used for.
 *
 * The menu is the portalled `ContextMenu` rather than an absolutely-positioned
 * child: the bar scrolls horizontally, so a menu drawn inside it was clipped by
 * the bar's own overflow and appeared cut off.
 */
export function SnippetBar({
  snippets,
  canSend,
  onSend,
  onEdit,
  onNew,
  onDelete,
  onSetGroup,
  onReorder,
  onHide
}: SnippetBarProps): JSX.Element {
  const [activeGroup, setActiveGroup] = useState<string>(ALL)
  const [menu, setMenu] = useState<{ x: number; y: number; snippet: Snippet } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const groupOf = (snippet: Snippet): string => snippet.group || UNGROUPED

  const groups = useMemo(() => {
    const seen: string[] = []
    for (const snippet of snippets) {
      const group = groupOf(snippet)
      if (!seen.includes(group)) seen.push(group)
    }
    return seen
  }, [snippets])

  const visible = useMemo(
    () => (activeGroup === ALL ? snippets : snippets.filter((s) => groupOf(s) === activeGroup)),
    [snippets, activeGroup]
  )

  // A tab can disappear when its last snippet is deleted or renamed.
  const effectiveGroup = groups.includes(activeGroup) || activeGroup === ALL ? activeGroup : ALL

  /** Drop `dragId` immediately before `targetId`, or at the end when null. */
  const reorderAround = (targetId: string | null): void => {
    if (!dragId || dragId === targetId) return
    const ids = snippets.map((s) => s.id).filter((id) => id !== dragId)
    const at = targetId === null ? ids.length : ids.indexOf(targetId)
    ids.splice(at < 0 ? ids.length : at, 0, dragId)
    onReorder(ids)
  }

  const menuItems = (snippet: Snippet): MenuItem[] => [
    { id: 'send', label: 'Send to terminal', disabled: !canSend },
    { id: 'edit', label: 'Edit…' },
    { id: 'duplicate', label: 'Duplicate' },
    {
      id: 'ungroup',
      label: 'Move to Ungrouped',
      separatorBefore: true,
      // Only offer it when it would do something.
      disabled: groupOf(snippet) === UNGROUPED
    },
    { id: 'delete', label: 'Delete', danger: true, separatorBefore: true }
  ]

  const runMenuAction = (snippet: Snippet, actionId: string): void => {
    if (actionId === 'send') onSend(snippet)
    else if (actionId === 'edit') onEdit(snippet)
    else if (actionId === 'duplicate') onEdit({ ...snippet, id: '', label: `${snippet.label} copy` })
    else if (actionId === 'ungroup') onSetGroup(snippet.id, '')
    else if (actionId === 'delete') onDelete(snippet.id)
  }

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
            className={
              `td-snippet-group${effectiveGroup === group ? ' is-active' : ''}` +
              // A group tab is a drop target for "move here", which is the only
              // way to regroup without going through the editor.
              (dropTarget === 'group:' + group ? ' is-drop' : '')
            }
            onClick={() => setActiveGroup(group)}
            data-group={group}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              setDropTarget('group:' + group)
            }}
            onDragLeave={() => setDropTarget((t) => (t === 'group:' + group ? null : t))}
            onDrop={(e) => {
              e.preventDefault()
              setDropTarget(null)
              if (dragId) onSetGroup(dragId, group === UNGROUPED ? '' : group)
              setDragId(null)
            }}
          >
            {group}
            <span className="td-snippet-count" data-contrast-exempt>
              {snippets.filter((s) => groupOf(s) === group).length}
            </span>
          </button>
        ))}
      </div>

      <div
        className="td-snippet-items"
        // Dropping on empty space puts the chip at the end.
        onDragOver={(e) => {
          if (dragId) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          reorderAround(null)
          setDragId(null)
          setDropTarget(null)
        }}
      >
        {visible.length === 0 && (
          <span className="td-snippet-empty">
            No snippets yet — click <b>+</b> to save a command.
          </span>
        )}

        {visible.map((snippet) => (
          <div key={snippet.id} className="td-snippet-slot">
            <button
              className={
                `td-snippet${canSend ? '' : ' is-disabled'}` +
                (dragId === snippet.id ? ' is-dragging' : '') +
                (dropTarget === 'item:' + snippet.id ? ' is-drop' : '')
              }
              data-snippet-id={snippet.id}
              data-snippet-label={snippet.label}
              data-group={groupOf(snippet)}
              draggable
              title={
                (snippet.description ? snippet.description + '\n' : '') +
                snippet.command +
                (canSend ? '' : '\n(no active terminal)') +
                '\n\nClick to send · right-click to edit · drag to reorder or regroup'
              }
              disabled={!canSend}
              onClick={() => onSend(snippet)}
              onDragStart={(e) => {
                setDragId(snippet.id)
                // Firefox/Chromium both need some payload for a drag to start.
                e.dataTransfer?.setData('text/plain', snippet.id)
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropTarget(null)
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === snippet.id) return
                e.preventDefault()
                e.stopPropagation()
                setDropTarget('item:' + snippet.id)
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'item:' + snippet.id ? null : t))}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                reorderAround(snippet.id)
                setDragId(null)
                setDropTarget(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, snippet })
              }}
            >
              {snippet.label}
            </button>
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
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.snippet)}
          testId="snippet-menu"
          onSelect={(id) => runMenuAction(menu.snippet, id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
