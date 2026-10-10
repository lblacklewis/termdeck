/**
 * Persisted UI layout.
 *
 * Stores the docking layout plus which rail section was showing, so a restart
 * comes back to the same arrangement.
 *
 * Deliberately does NOT store credentials or reconnect anything on its own:
 * saved panels are restored as placeholders that reconnect on click. Silently
 * spawning shells or SSH connections on launch would be a surprise, and the
 * local-shell case would leak processes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LayoutState, PageId } from '@shared/types'

export type { LayoutState }

const DEFAULT_LAYOUT: LayoutState = {
  dockview: null,
  page: 'terminal',
  railCollapsed: false,
  snippetBarVisible: true
}

const PAGES: PageId[] = ['terminal', 'hosts', 'known-hosts', 'snippets', 'logs', 'settings']

function sanitise(input: unknown): LayoutState {
  if (!input || typeof input !== 'object') return { ...DEFAULT_LAYOUT }
  const raw = input as Partial<LayoutState> & {
    /** Pre-drawer-merge files. Read so an upgrade does not lose the choice. */
    sidebarVisible?: boolean
    sidebarCollapsed?: boolean
  }

  // `settings` has no page of its own, so it is never a restored destination.
  const page = PAGES.includes(raw.page as PageId) && raw.page !== 'settings'
    ? (raw.page as PageId)
    : 'terminal'

  /*
   * The drawer used to be a separate column with its own visibility flag. It is
   * now the rail's own panel, so either old field means the same thing: a hidden
   * or slimmed sidebar is a collapsed rail.
   */
  const collapsed =
    typeof raw.railCollapsed === 'boolean'
      ? raw.railCollapsed
      : raw.sidebarVisible === false || raw.sidebarCollapsed === true

  return {
    dockview: typeof raw.dockview === 'string' && raw.dockview.length > 0 ? raw.dockview : null,
    page,
    railCollapsed: collapsed,
    snippetBarVisible: raw.snippetBarVisible !== false
  }
}

export class LayoutStore {
  private readonly path: string
  private state: LayoutState

  constructor(configDir: string) {
    this.path = join(configDir, 'layout.json')
    this.state = sanitise(this.read())
  }

  private read(): unknown {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // A corrupt layout must never block startup; fall back to defaults.
      return null
    }
  }

  load(): LayoutState {
    return this.state
  }

  save(next: Partial<LayoutState>): LayoutState {
    this.state = sanitise({ ...this.state, ...next })
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.path)
    return this.state
  }

  /** Forget the arrangement, e.g. when a saved layout cannot be restored. */
  clear(): LayoutState {
    this.state = { ...DEFAULT_LAYOUT }
    return this.save({})
  }
}
