import type { ReactElement } from 'react'
import type { AppInfo, PageId } from '@shared/types'
import { t } from '../i18n'

// The page set lives in shared types so the persisted layout can reference it.
export type { PageId }

interface NavEntry {
  id: PageId
  label: string
  /** Simple glyph: keeps the rail dependency-free and legible at 18px. */
  icon: string
}

/*
 * Built on each render rather than once at module load: a `t()` call at module
 * scope runs before the language is known and is never evaluated again, so the
 * rail stayed English while everything around it switched.
 */
function navEntries(): NavEntry[] {
  return [
    { id: 'terminal', label: t('navrail.terminal', 'Terminal'), icon: '▤' },
    { id: 'hosts', label: t('navrail.hosts', 'Hosts'), icon: '☰' },
    { id: 'known-hosts', label: t('navrail.known_hosts', 'Known Hosts'), icon: '⛨' },
    { id: 'snippets', label: t('navrail.snippets', 'Snippets'), icon: '⌨' },
    { id: 'logs', label: t('navrail.logs', 'Logs'), icon: '≣' },
    // A tunnel is a connection you keep open in the background, so it sits with
    // the other things that outlive a pane rather than inside the terminal.
    { id: 'tunnels', label: t('navrail.tunnels', 'Tunnels'), icon: '⇄' }
  ]
}

/*
 * `PAGE_ORDER` / `PAGE_CYCLE` / `PAGE_LABELS` used to live here, for `Alt`+digit
 * and `Alt+[` / `Alt+]`. Those shortcuts now walk the open *sessions* rather than
 * the rail — a rail has five fixed entries, and "switch session" is a question
 * about the panes — so the lists had no readers left and were deleted rather than
 * left to drift from the rail they claimed to describe.
 */

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
    <nav className={`td-rail${collapsed ? ' is-collapsed' : ''}`} aria-label={t('navrail.sections', 'Sections')} data-testid="nav-rail">
      <div className="td-rail-brand" title={t('navrail.termdeck', 'TermDeck')}>
        <span className="td-brand-mark">▚</span>
        <span className="td-rail-brand-name">{t('navrail.termdeck_2', 'TermDeck')}</span>
      </div>

      <div className="td-rail-scroll">
        <div className="td-rail-group">
          {navEntries().map((page) => {
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
            title={t('navrail.settings', 'Settings')}
            onClick={() => onSelect('settings')}
          >
            <span className="td-rail-icon" aria-hidden="true">
              ⚙
            </span>
            <span className="td-rail-label">{t('navrail.settings_2', 'Settings')}</span>
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
                ? t('navrail.expand_sidebar', 'Expand the sidebar')
                : t('navrail.shrink_icons', 'Shrink to icons only')
          }
          onClick={onToggleCollapsed}
        >
          <span className="td-rail-toggle-track" aria-hidden="true">
            <span className="td-rail-toggle-knob" />
          </span>
          <span className="td-rail-label">
            {collapsed ? t('navrail.expand', 'Expand') : t('navrail.shrink', 'Shrink')}
          </span>
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
