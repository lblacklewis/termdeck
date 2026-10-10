import type { ReactElement } from 'react'
import type { AppInfo, PageId } from '@shared/types'

// The page set lives in shared types so the persisted layout can reference it.
export type { PageId }

interface NavEntry {
  id: PageId
  label: string
  /** Simple glyph: keeps the rail dependency-free and legible at 18px. */
  icon: string
}

const PAGES: NavEntry[] = [
  { id: 'terminal', label: 'Terminal', icon: '▤' },
  { id: 'hosts', label: 'Hosts', icon: '☰' },
  { id: 'known-hosts', label: 'Known Hosts', icon: '⛨' },
  { id: 'snippets', label: 'Snippets', icon: '⌨' },
  { id: 'logs', label: 'Logs', icon: '≣' }
]

interface NavRailProps {
  active: PageId
  onSelect: (page: PageId) => void
  /** Badge counts keyed by page, e.g. open sessions on the terminal page. */
  badges?: Partial<Record<PageId, number>>
  appInfo: AppInfo | null
  /** Settings has no page; the rail highlights it while its drawer is open. */
  settingsOpen?: boolean
  /** Icon-only mode: the rail's list drawer is hidden and only icons remain. */
  collapsed: boolean
  /**
   * Whether the stored layout has been applied yet. Clicks are ignored until it
   * has: the restore is asynchronous, so one that arrives first is overwritten a
   * moment later by the stored value, and the toggle appears not to work.
   */
  ready?: boolean
  onToggleCollapsed: () => void
}

/**
 * The narrow icon rail from the Termius-style layout.
 *
 * The rail and its list are one column, not two: they share a background and a
 * single border, and the rail's toggle shrinks the whole thing to icons. Keeping
 * them visually separate made the window read as three unrelated columns.
 */
export function NavRail({
  active,
  onSelect,
  badges,
  appInfo,
  settingsOpen,
  collapsed,
  ready = true,
  onToggleCollapsed
}: NavRailProps): ReactElement {
  return (
    <nav className={`td-rail${collapsed ? ' is-collapsed' : ''}`} aria-label="Sections" data-testid="nav-rail">
      <div className="td-rail-brand" title="TermDeck">
        <span className="td-brand-mark">▚</span>
        <span className="td-rail-brand-name">TermDeck</span>
      </div>

      <div className="td-rail-scroll">
        <div className="td-rail-group">
          {PAGES.map((page) => {
            const badge = badges?.[page.id]
            return (
              <button
                key={page.id}
                className={`td-rail-btn${active === page.id ? ' is-active' : ''}`}
                data-testid={`rail-${page.id}`}
                data-page={page.id}
                aria-current={active === page.id ? 'page' : undefined}
                title={page.label}
                onClick={() => onSelect(page.id)}
              >
                <span className="td-rail-icon" aria-hidden="true">
                  {page.icon}
                </span>
                <span className="td-rail-label">{page.label}</span>
                {badge !== undefined && badge > 0 && (
                  <span className="td-rail-badge" data-contrast-exempt>
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="td-rail-divider" />

        <div className="td-rail-group">
          <button
            className={`td-rail-btn${settingsOpen ? ' is-active' : ''}`}
            data-testid="rail-settings"
            data-page="settings"
            aria-current={settingsOpen ? 'page' : undefined}
            title="Settings"
            onClick={() => onSelect('settings')}
          >
            <span className="td-rail-icon" aria-hidden="true">
              ⚙
            </span>
            <span className="td-rail-label">Settings</span>
          </button>
        </div>
      </div>

      <div className="td-rail-bottom">
        {/*
          A small switch, horizontal rather than a chevron: it reads as "narrow
          this", and the knob tracks the visual width of the column beside it.
        */}
        <button
          className="td-rail-toggle"
          data-testid="rail-toggle"
          data-collapsed={collapsed ? 'true' : 'false'}
          aria-pressed={collapsed}
          disabled={!ready}
          title={
            !ready
              ? 'Restoring the saved layout…'
              : collapsed
                ? 'Expand the sidebar'
                : 'Shrink to icons only'
          }
          onClick={onToggleCollapsed}
        >
          <span className="td-rail-toggle-track" aria-hidden="true">
            <span className="td-rail-toggle-knob" />
          </span>
          <span className="td-rail-label">{collapsed ? 'Expand' : 'Shrink'}</span>
        </button>

        {appInfo && (
          <div className="td-rail-meta" title={`${appInfo.platform} · Electron ${appInfo.versions.electron}`}>
            {appInfo.platform}
          </div>
        )}
      </div>
    </nav>
  )
}
