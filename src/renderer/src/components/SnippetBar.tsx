import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Snippet } from '@shared/types'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { t } from '../i18n'

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
  /** Reorder the whole list, which is what the strip is derived from. */
  onReorder: (ids: string[]) => void
  onHide: () => void
}

const UNGROUPED = 'Ungrouped'

/**
 * Bottom bar of saved commands.
 *
 * Snippets are grouped by their `group` field; the group list is derived from the
 * data, so creating a group needs no separate registry. Clicking sends to the
 * active terminal. Right-clicking opens the shared context menu, and dragging a
 * chip onto another chip reorders it.
 *
 * Groups are one control, not a row of tabs: a bar of tabs spends the whole left
 * end on labels that are usually not the thing being looked for. The button shows
 * "All" until some groups are ticked off, and the list opens upwards because the
 * bar lives at the bottom of the window.
 *
 * The menu is the portalled `ContextMenu` rather than an absolutely-positioned
 * child: the strip of chips scrolls horizontally, so a menu drawn inside it was
 * clipped by the strip's own overflow and appeared cut off.
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
  /** Empty means "no filter", which is the default the button reports as All. */
  const [activeGroups, setActiveGroups] = useState<string[]>([])
  const [groupMenu, setGroupMenu] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; snippet: Snippet } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)

  const groupOf = (snippet: Snippet): string => snippet.group || UNGROUPED

  const groups = useMemo(() => {
    const seen: string[] = []
    for (const snippet of snippets) {
      const group = groupOf(snippet)
      if (!seen.includes(group)) seen.push(group)
    }
    return seen
  }, [snippets])

  /*
   * Ticks for groups that no longer exist are ignored rather than pruned: deleting
   * the last snippet of a group should not silently widen the filter when that group
   * comes back.
   */
  const ticked = activeGroups.filter((group) => groups.includes(group))
  const filtering = ticked.length > 0

  const visible = useMemo(
    () => (filtering ? snippets.filter((s) => ticked.includes(groupOf(s))) : snippets),
    [snippets, filtering, ticked]
  )

  /** The one group new snippets default to, when exactly one is ticked. */
  const soleGroup = ticked.length === 1 ? (ticked[0] === UNGROUPED ? '' : ticked[0]) : ''

  /*
   * Dismiss the checklist the way every other popup in the app is dismissed: a press
   * anywhere else, or Escape. Captured, so a click inside a chip cannot leave it open
   * behind the context menu.
   */
  useEffect(() => {
    if (!groupMenu) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && groupsRef.current?.contains(target)) return
      setGroupMenu(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGroupMenu(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [groupMenu])

  const toggleGroup = (group: string): void =>
    setActiveGroups((prev) =>
      prev.includes(group) ? prev.filter((g) => g !== group) : [...prev, group]
    )

  /** Drop `dragId` immediately before `targetId`, or at the end when null. */
  const reorderAround = (targetId: string | null): void => {
    if (!dragId || dragId === targetId) return
    const ids = snippets.map((s) => s.id).filter((id) => id !== dragId)
    const at = targetId === null ? ids.length : ids.indexOf(targetId)
    ids.splice(at < 0 ? ids.length : at, 0, dragId)
    onReorder(ids)
  }

  const menuItems = (snippet: Snippet): MenuItem[] => {
    /*
     * Ungrouped is always a destination, even when no snippet is in it right now:
     * taking a snippet out of its group must not depend on whether some other
     * snippet happens to be ungrouped.
     */
    const destinations: string[] = []
    for (const group of [...groups, UNGROUPED]) {
      if (group !== groupOf(snippet) && !destinations.includes(group)) destinations.push(group)
    }
    return [
      { id: 'send', label: t('snippetbar.send_to_terminal', 'Send to terminal'), disabled: !canSend },
      { id: 'edit', label: t('snippetbar.edit', 'Edit…') },
      { id: 'duplicate', label: t('snippetbar.duplicate', 'Duplicate') },
      // Regrouping lives here now that the group tabs are gone; each destination is
      // one item rather than a submenu, which this menu does not have.
      ...destinations.map((group, index) => ({
        id: 'move:' + group,
        label: t('snippetbar.move_to', 'Move to {group}', { group }),
        separatorBefore: index === 0
      })),
      { id: 'delete', label: t('snippetbar.delete', 'Delete'), danger: true, separatorBefore: true }
    ]
  }

  const runMenuAction = (snippet: Snippet, actionId: string): void => {
    if (actionId === 'send') onSend(snippet)
    else if (actionId === 'edit') onEdit(snippet)
    else if (actionId === 'duplicate') onEdit({ ...snippet, id: '', label: `${snippet.label} copy` })
    else if (actionId.startsWith('move:')) {
      const group = actionId.slice('move:'.length)
      onSetGroup(snippet.id, group === UNGROUPED ? '' : group)
    } else if (actionId === 'delete') onDelete(snippet.id)
  }

  return (
    <div className="td-snippet-bar" data-testid="snippet-bar">
      <div className="td-snippet-groups" ref={groupsRef}>
        <button
          className={`td-snippet-group${filtering ? ' is-active' : ''}`}
          data-testid="snippet-group-toggle"
          aria-expanded={groupMenu}
          title={t('snippetbar.filter_by_group', 'Filter by group')}
          onClick={() => setGroupMenu((open) => !open)}
        >
          {filtering ? ticked.join(' · ') : t('snippetbar.all', 'All')}
          <span className="td-snippet-count" data-contrast-exempt>
            {visible.length}
          </span>
          <span className="td-snippet-caret" aria-hidden="true">
            ⌄
          </span>
        </button>

        {groupMenu && (
          <div className="td-group-pop" data-testid="snippet-group-menu" role="menu">
            <label className="td-group-row">
              <input
                type="checkbox"
                data-testid="snippet-group-all"
                checked={!filtering}
                onChange={() => setActiveGroups([])}
              />
              <span className="td-group-name">{t('snippetbar.all', 'All')}</span>
              <span className="td-group-count" data-contrast-exempt>
                {snippets.length}
              </span>
            </label>
            {groups.map((group) => (
              <label key={group} className="td-group-row">
                <input
                  type="checkbox"
                  data-testid={'snippet-group-' + group}
                  checked={ticked.includes(group)}
                  onChange={() => toggleGroup(group)}
                />
                <span className="td-group-name">{group}</span>
                <span className="td-group-count" data-contrast-exempt>
                  {snippets.filter((s) => groupOf(s) === group).length}
                </span>
              </label>
            ))}
          </div>
        )}
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
            {snippets.length > 0
              ? t('snippetbar.no_snippets_in_these_group', 'No snippets in those groups.')
              : t('snippetbar.no_snippets_yet_click', 'No snippets yet — click')}
            {snippets.length === 0 && (
              <>
                <b>+</b> {t('snippetbar.to_save_a_command', 'to save a command.')}
              </>
            )}
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
                '\n\nClick to send · right-click to edit · drag to reorder'
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
              {/*
                The colour is a stripe along the bottom edge rather than a tinted chip:
                three pixels of full-strength colour is readable at this size, while a
                tinted background would have to be strong enough to fight the label's
                contrast.
              */}
              {snippet.color && (
                <span
                  className="td-snippet-stripe"
                  data-testid={'snippet-stripe-' + snippet.id}
                  style={{ background: snippet.color }}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        ))}
      </div>

      <div className="td-snippet-actions">
        <button
          className="td-icon-btn"
          title={
            soleGroup ? `New snippet in “${soleGroup}”` : t('snippetbar.new_snippet', 'New snippet')
          }
          data-testid="snippet-new"
          onClick={() => onNew(soleGroup)}
        >
          +
        </button>
        <button className="td-icon-btn" title={t('snippetbar.hide_snippet_bar', 'Hide snippet bar')} onClick={onHide}>
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
