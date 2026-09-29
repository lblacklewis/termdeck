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
}

/**
 * The narrow icon rail from the Termius-style layout.
 *
 * It sits left of the list column and switches what that column shows, so the
 * window is: rail | list | main area.
 */
export function NavRail({
  active,
  onSelect,
  badges,
  appInfo,
  settingsOpen
}: NavRailProps): ReactElement {
  return (
    <nav className="td-rail" aria-label="Sections">
      <div className="td-rail-brand" title="TermDeck">
        <span className="td-brand-mark">▚</span>
      </div>

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

      <div className="td-rail-group td-rail-bottom">
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

        {appInfo && (
          <div className="td-rail-meta" title={`${appInfo.platform} · Electron ${appInfo.versions.electron}`}>
            {appInfo.platform}
          </div>
        )}
      </div>
    </nav>
  )
}
