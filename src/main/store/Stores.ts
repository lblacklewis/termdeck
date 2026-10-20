/**
 * Small JSON persistence helper plus the two documents TermDeck keeps:
 * application settings and the saved-session tree.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
 * half-written config behind, and corrupt files fall back to defaults instead of
 * preventing startup.
 */
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_BREAK_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_SECTIONS,
  DEFAULT_SIDEBAR_WIDTH,
  HISTORY_RETENTION_DAYS,
  type AppSettings,
  type BreakSettings,
  type BreakStats,
  type HistoryEntry,
  type HistorySessionSummary,
  type Keybinding,
  type SavedSession,
  type SessionFolder,
  type SessionTree,
  type SidebarSectionId,
  type SidebarSectionState,
  type Snippet
} from '@shared/types'

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

/**
 * The interface scale before the user has ever expressed a preference.
 *
 * 100% is right on a tablet-sized laptop panel, but the same 13px text on a
 * 2560px desktop monitor looks miniature, so the first run starts larger on a
 * wide screen. A zero here (no display yet, e.g. in tests) means "leave it
 * alone". This only ever seeds the default: once settings.json carries a
 * uiScale that the user picked, that value wins on every future start.
 */
let screenDefaultScale = 0

export function setScreenDefaultScale(scale: number): void {
  screenDefaultScale = clampScale(scale)
}

/**
 * The first-run scale for a display this many logical pixels wide.
 *
 * 100% is right on a tablet-sized panel, but the same 13px text on a 2560px
 * desktop monitor looks miniature. Logical width already folds in the OS scale
 * factor, so a 4K panel running at 200% reports 1920 and stays at 100%. The
 * steps are gentle: this only seeds the default, and the settings page is the
 * real control.
 */
export function defaultScaleForWidth(logicalWidth: number): number {
  if (!Number.isFinite(logicalWidth) || logicalWidth <= 0) return 1
  if (logicalWidth >= 2200) return 1.15
  if (logicalWidth >= 1800) return 1.05
  return 1
}

/** Merge stored settings with defaults so new options appear for old files. */
function mergeSettings(stored: Partial<AppSettings> | null): AppSettings {
  if (!stored) {
    const fresh = structuredClone(DEFAULT_SETTINGS)
    if (screenDefaultScale > 0) fresh.uiScale = screenDefaultScale
    return fresh
  }

  const defaults = DEFAULT_SETTINGS

  return {
    terminal: { ...defaults.terminal, ...(stored.terminal ?? {}) },
    clipboard: { ...defaults.clipboard, ...(stored.clipboard ?? {}) },
    hostKeys: { ...defaults.hostKeys, ...(stored.hostKeys ?? {}) },
    keybindings: mergeKeybindings(stored.keybindings),
    snippets: sanitiseSnippets(stored.snippets),
    sidebar: {
      sections: mergeSidebarSections(stored.sidebar),
      width: clampSidebarWidth((stored.sidebar as { width?: unknown } | undefined)?.width),
      side:
        (stored.sidebar as { side?: unknown } | undefined)?.side === 'right' ? 'right' : 'left'
    },
    break: mergeBreak(stored.break),
    breakStats: mergeBreakStats(stored.breakStats),
    theme: typeof stored.theme === 'string' && stored.theme ? stored.theme : defaults.theme,
    // Clamped here so a hand-edited file cannot leave the UI unusable
    // (invisible at 0.1, unusable at 10).
    uiScale: clampScale(stored.uiScale ?? screenDefaultScale),
    // An unknown language falls back to English rather than to a blank UI.
    language: stored.language === 'zh-CN' ? 'zh-CN' : 'en',
    onboarded: stored.onboarded === true
  }
}

/**
 * Reconcile the drawer's sections with the built-in list.
 *
 * Same contract as the keybindings above: the stored **order wins** (that is the
 * whole point of dragging them), an unknown id is dropped, and a section added by
 * an app update is appended rather than silently missing.
 */
function mergeSidebarSections(stored: unknown): SidebarSectionState[] {
  const known = new Set<string>(DEFAULT_SIDEBAR_SECTIONS.map((s) => s.id))
  const input = (stored as { sections?: unknown } | null | undefined)?.sections

  if (!Array.isArray(input)) return DEFAULT_SIDEBAR_SECTIONS.map((s) => ({ ...s }))

  const merged: SidebarSectionState[] = []
  for (const entry of input) {
    const id = (entry as SidebarSectionState | null)?.id
    if (typeof id !== 'string' || !known.has(id)) continue
    if (merged.some((s) => s.id === id)) continue
    const state = entry as SidebarSectionState
    merged.push({
      id: id as SidebarSectionId,
      visible: state.visible !== false,
      collapsed: state.collapsed === true,
      height: clampSectionHeight(state.height)
    })
  }

  for (const def of DEFAULT_SIDEBAR_SECTIONS) {
    if (!merged.some((s) => s.id === def.id)) merged.push({ ...def })
  }
  return merged
}

/** A drawer narrower than this cannot show a host name; wider wastes the pane. */
export function clampSidebarWidth(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SIDEBAR_WIDTH
  return Math.min(560, Math.max(200, Math.round(n)))
}

/** A section body tall enough to show a row, short enough to leave room. */
export function clampSectionHeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(720, Math.max(80, Math.round(value)))
}

/** The reminder interval, clamped to something a human would recognise. */
export function clampBreakMinutes(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_BREAK_SETTINGS.minutes
  return Math.min(240, Math.max(1, Math.round(n)))
}

function mergeBreak(stored: unknown): BreakSettings {
  const input = (stored ?? {}) as Partial<BreakSettings>
  return {
    enabled: input.enabled === true,
    mode: input.mode === 'pomodoro' ? 'pomodoro' : 'reminder',
    minutes: clampBreakMinutes(input.minutes ?? DEFAULT_BREAK_SETTINGS.minutes),
    breakMinutes: Math.min(
      60,
      Math.max(1, Math.round(input.breakMinutes ?? DEFAULT_BREAK_SETTINGS.breakMinutes))
    ),
    // Long enough that a command's output has stopped, short enough that the
    // nudge still belongs to the moment it was earned in.
    idleSeconds: Math.min(
      120,
      Math.max(2, Math.round(input.idleSeconds ?? DEFAULT_BREAK_SETTINGS.idleSeconds))
    ),
    snoozeMinutes: Math.min(
      120,
      Math.max(1, Math.round(input.snoozeMinutes ?? DEFAULT_BREAK_SETTINGS.snoozeMinutes))
    )
  }
}

function mergeBreakStats(stored: unknown): BreakStats {
  const input = (stored ?? {}) as Partial<BreakStats>
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
  return {
    longestMinutes: Math.min(24 * 60, num(input.longestMinutes)),
    breaks: Math.min(100_000, num(input.breaks)),
    pomodoros: Math.min(100_000, num(input.pomodoros)),
    lastBreakAt: num(input.lastBreakAt)
  }
}

/** Keep the interface scale within a range that stays usable. */
export function clampScale(value: unknown): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_SETTINGS.uiScale
  return Math.min(2, Math.max(0.7, Math.round(n * 100) / 100))
}

/**
 * Reconcile stored keybindings with the built-in list.
 *
 * The stored **order is preserved**: the settings UI lets the user drag rows
 * into an order of their choosing, and rebuilding the list in default order
 * would silently discard that on every save. Built-ins that the user deleted
 * stay deleted; genuinely new built-ins are appended at the end.
 */
function mergeKeybindings(stored: unknown): Keybinding[] {
  const defaults = DEFAULT_SETTINGS.keybindings

  if (!Array.isArray(stored)) return defaults.map((b) => ({ ...b }))

  const valid = stored.filter(
    (b): b is Keybinding =>
      !!b && typeof b.id === 'string' && typeof b.keys === 'string'
  )

  const canonical = new Map(defaults.map((b) => [b.id, b]))

  const merged: Keybinding[] = valid.map((entry) => {
    const def = canonical.get(entry.id)
    return {
      id: entry.id,
      // A built-in keeps its canonical label; a custom binding keeps its own.
      label: def ? def.label : entry.label || entry.id,
      keys: entry.keys,
      builtin: !!def
    }
  })

  // Append built-ins this file has never seen (an app update added them).
  const known = new Set(merged.map((b) => b.id))
  for (const def of defaults) {
    if (!known.has(def.id)) merged.push({ ...def })
  }

  return merged
}

/** Drop malformed snippets rather than letting one bad entry break the bar. */
function sanitiseSnippets(input: unknown): Snippet[] {
  if (!Array.isArray(input)) return []
  return input
    .filter(
      (s): s is Snippet =>
        !!s && typeof s.id === 'string' && typeof s.label === 'string' && typeof s.command === 'string'
    )
    .map((s) => ({
      id: s.id,
      label: s.label,
      // `sendEnter` used to be appended here; commands are now stored and sent
      // verbatim, so an existing snippet keeps exactly the text it had.
      command: s.command,
      group: typeof s.group === 'string' ? s.group : '',
      description: typeof s.description === 'string' ? s.description : undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now()
    }))
}

export class SettingsStore {
  private readonly path: string
  private settings: AppSettings

  constructor(configDir: string) {
    this.path = join(configDir, 'settings.json')
    this.settings = mergeSettings(readJson<Partial<AppSettings>>(this.path))
  }

  load(): AppSettings {
    return this.settings
  }

  save(next: AppSettings): AppSettings {
    this.settings = mergeSettings(next as Partial<AppSettings>)
    writeJsonAtomic(this.path, this.settings)
    return this.settings
  }

  // ---- snippets ---------------------------------------------------------

  saveSnippet(input: Partial<Snippet> & { label: string; command: string }): AppSettings {
    const now = Date.now()
    const existing = input.id ? this.settings.snippets.find((s) => s.id === input.id) : undefined

    if (existing) {
      existing.label = input.label
      existing.command = input.command
      if (input.group !== undefined) existing.group = input.group
      if (input.description !== undefined) existing.description = input.description
      existing.updatedAt = now
    } else {
      this.settings.snippets.push({
        id: input.id ?? randomUUID(),
        label: input.label,
        command: input.command,
        group: input.group ?? '',
        description: input.description,
        createdAt: now,
        updatedAt: now
      })
    }

    return this.persist()
  }

  deleteSnippet(id: string): AppSettings {
    this.settings.snippets = this.settings.snippets.filter((s) => s.id !== id)
    return this.persist()
  }

  /** Apply a new ordering given the full list of ids. */
  reorderSnippets(ids: string[]): AppSettings {
    const byId = new Map(this.settings.snippets.map((s) => [s.id, s]))
    const ordered: Snippet[] = []
    for (const id of ids) {
      const snippet = byId.get(id)
      if (snippet) {
        ordered.push(snippet)
        byId.delete(id)
      }
    }
    // Anything the caller forgot keeps its relative order at the end.
    for (const leftover of this.settings.snippets) {
      if (byId.has(leftover.id)) ordered.push(leftover)
    }
    this.settings.snippets = ordered
    return this.persist()
  }

  private persist(): AppSettings {
    writeJsonAtomic(this.path, this.settings)
    return this.settings
  }
}

/**
 * A stored serial block, with anything unusable replaced by a default.
 *
 * Returns `undefined` for an entry with no device: a serial record without a
 * path is not a serial entry, and keeping a half-filled one would make the tree
 * show a device that cannot be opened.
 */
function sanitiseSerial(input: SavedSession['serial']): SavedSession['serial'] {
  if (!input || typeof input.path !== 'string' || input.path.trim() === '') return undefined
  const { dataBits, parity } = input
  return {
    path: input.path,
    baudRate: typeof input.baudRate === 'number' && input.baudRate > 0 ? input.baudRate : 115200,
    dataBits: dataBits === 5 || dataBits === 6 || dataBits === 7 || dataBits === 8 ? dataBits : 8,
    parity:
      parity === 'even' || parity === 'odd' || parity === 'mark' || parity === 'space'
        ? parity
        : 'none',
    stopBits: input.stopBits === 2 ? 2 : 1
  }
}

/** The post-connect list, minus blank lines and anything that is not a string. */
function sanitiseCommands(input: string[] | undefined): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const lines = input.filter((line) => typeof line === 'string' && line.trim() !== '')
  return lines.length > 0 ? lines : undefined
}

function sanitiseTree(stored: Partial<SessionTree> | null): SessionTree {
  const folders: SessionFolder[] = Array.isArray(stored?.folders)
    ? stored.folders
        .filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
        .map((f) => ({
          id: f.id,
          name: f.name,
          parentId: typeof f.parentId === 'string' ? f.parentId : null,
          color: f.color,
          expanded: f.expanded !== false,
          createdAt: typeof f.createdAt === 'number' ? f.createdAt : Date.now()
        }))
    : []

  const folderIds = new Set(folders.map((f) => f.id))

  const sessions: SavedSession[] = Array.isArray(stored?.sessions)
    ? stored.sessions
        .filter((s) => s && typeof s.id === 'string' && typeof s.host === 'string')
        .map((s) => ({
          id: s.id,
          name: s.name || `${s.username}@${s.host}`,
          host: s.host,
          port: typeof s.port === 'number' && s.port > 0 ? s.port : 22,
          username: s.username || 'root',
          authMethod: s.authMethod === 'key' || s.authMethod === 'agent' ? s.authMethod : 'password',
          privateKeyPath: s.privateKeyPath,
          // Transport and its extras survive a reload only because this list is
          // explicit: it is the read path, and anything not named here is
          // silently dropped on the next launch.
          kind: s.kind === 'telnet' || s.kind === 'serial' ? s.kind : 'ssh',
          serial: sanitiseSerial(s.serial),
          postConnectCommands: sanitiseCommands(s.postConnectCommands),
          tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string') : [],
          color: s.color,
          notes: s.notes,
          // A session whose folder vanished falls back to the root.
          parentId: typeof s.parentId === 'string' && folderIds.has(s.parentId) ? s.parentId : null,
          createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now()
        }))
    : []

  // Break parent cycles so a hand-edited file cannot create an infinite tree.
  const byId = new Map(folders.map((f) => [f.id, f]))
  for (const folder of folders) {
    const seen = new Set<string>([folder.id])
    let parent = folder.parentId
    while (parent) {
      if (seen.has(parent)) {
        folder.parentId = null
        break
      }
      seen.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
  }

  return { folders, sessions }
}

export class SessionStore {
  private readonly path: string
  private tree: SessionTree

  constructor(configDir: string) {
    this.path = join(configDir, 'sessions.json')
    this.tree = sanitiseTree(readJson<Partial<SessionTree>>(this.path))
  }

  load(): SessionTree {
    return this.tree
  }

  private commit(tree: SessionTree): SessionTree {
    this.tree = sanitiseTree(tree)
    writeJsonAtomic(this.path, this.tree)
    return this.tree
  }

  // ---- sessions ---------------------------------------------------------

  upsertSession(input: Partial<SavedSession> & { host: string }): SessionTree {
    this.applyUpsert(input)
    return this.commit(this.tree)
  }

  /**
   * Add several sessions as one change, and report which ones they were.
   *
   * `upsertSession` writes the file and commits on every call, so adding twenty
   * hosts one at a time meant twenty file writes and twenty broadcasts of the
   * whole tree. The upsert itself is the same in both paths — only the commit is
   * hoisted out here.
   */
  addSessions(inputs: Array<Partial<SavedSession> & { host: string }>): {
    tree: SessionTree
    sessions: SavedSession[]
  } {
    const sessions = inputs.map((input) => this.applyUpsert(input))
    return { tree: this.commit(this.tree), sessions }
  }

  /** The upsert on its own: mutates the tree, returns the session, no commit. */
  private applyUpsert(input: Partial<SavedSession> & { host: string }): SavedSession {
    const now = Date.now()
    const existing = input.id ? this.tree.sessions.find((s) => s.id === input.id) : undefined

    if (existing) {
      // `in` distinguishes "field omitted, keep the stored value" from
      // "field explicitly cleared", which `??` cannot express.
      const assign = <K extends keyof SavedSession>(key: K): void => {
        if (key in input) existing[key] = input[key] as SavedSession[K]
      }

      existing.host = input.host
      for (const key of [
        'name',
        'port',
        'username',
        'authMethod',
        'privateKeyPath',
        'kind',
        'serial',
        'postConnectCommands',
        'tags',
        'color',
        'notes',
        'parentId'
      ] as Array<keyof SavedSession>) {
        assign(key)
      }
      existing.name = existing.name?.trim() || `${existing.username}@${existing.host}`
      existing.updatedAt = now
      return existing
    }

    const created: SavedSession = {
      id: input.id ?? randomUUID(),
      name: input.name?.trim() || `${input.username ?? 'root'}@${input.host}`,
      host: input.host,
      port: input.port ?? 22,
      username: input.username ?? 'root',
      authMethod: input.authMethod ?? 'password',
      privateKeyPath: input.privateKeyPath,
      kind: input.kind,
      serial: input.serial,
      postConnectCommands: input.postConnectCommands,
      tags: input.tags ?? [],
      color: input.color,
      notes: input.notes,
      parentId: input.parentId ?? null,
      createdAt: now,
      updatedAt: now
    }
    this.tree.sessions.push(created)
    return created
  }

  deleteSession(id: string): SessionTree {
    this.tree.sessions = this.tree.sessions.filter((s) => s.id !== id)
    return this.commit(this.tree)
  }

  moveSession(id: string, parentId: string | null): SessionTree {
    const session = this.tree.sessions.find((s) => s.id === id)
    if (!session) throw new Error(`No such session: ${id}`)
    if (parentId && !this.tree.folders.some((f) => f.id === parentId)) {
      throw new Error(`No such folder: ${parentId}`)
    }
    session.parentId = parentId
    session.updatedAt = Date.now()
    return this.commit(this.tree)
  }

  // ---- folders ---------------------------------------------------------

  upsertFolder(input: Partial<SessionFolder> & { name: string }): SessionTree {
    const existing = input.id ? this.tree.folders.find((f) => f.id === input.id) : undefined

    if (existing) {
      existing.name = input.name
      if (input.parentId !== undefined) existing.parentId = input.parentId
      if (input.color !== undefined) existing.color = input.color
      if (input.expanded !== undefined) existing.expanded = input.expanded
    } else {
      this.tree.folders.push({
        id: input.id ?? randomUUID(),
        name: input.name,
        parentId: input.parentId ?? null,
        color: input.color,
        expanded: input.expanded !== false,
        createdAt: Date.now()
      })
    }

    return this.commit(this.tree)
  }

  /**
   * Apply imported folders and sessions as one change.
   *
   * A share import can bring dozens of hosts and their groups, and each of
   * `upsertFolder` / `addSessions` writes the file and broadcasts on its own; this
   * collects the lot into a single commit. Ids come from the caller, because the
   * plan is what maps the imported ids onto freshly minted ones.
   */
  importShare(plan: {
    folders: Array<{ id: string; name: string; parentId: string | null; color?: string }>
    sessions: Array<Partial<SavedSession> & { id: string; host: string }>
  }): SessionTree {
    for (const folder of plan.folders) {
      if (this.tree.folders.some((f) => f.id === folder.id)) continue
      this.tree.folders.push({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        color: folder.color,
        expanded: true,
        createdAt: Date.now()
      })
    }
    for (const session of plan.sessions) this.applyUpsert(session)
    return this.commit(this.tree)
  }

  /** Recursively delete a folder with its subfolders and their sessions. */
  deleteFolder(id: string): SessionTree {
    const doomed = new Set<string>()
    const walk = (folderId: string): void => {
      doomed.add(folderId)
      for (const child of this.tree.folders) {
        if (child.parentId === folderId && !doomed.has(child.id)) walk(child.id)
      }
    }
    walk(id)

    this.tree.folders = this.tree.folders.filter((f) => !doomed.has(f.id))
    this.tree.sessions = this.tree.sessions.filter((s) => !s.parentId || !doomed.has(s.parentId))
    return this.commit(this.tree)
  }

  /** Move a folder, refusing moves that would create a cycle. */
  moveFolder(id: string, parentId: string | null): SessionTree {
    const folder = this.tree.folders.find((f) => f.id === id)
    if (!folder) throw new Error(`No such folder: ${id}`)

    if (parentId) {
      if (parentId === id) throw new Error('A folder cannot contain itself.')
      // Walk up from the new parent: if we meet `id`, this is a cycle.
      let cursor: string | null = parentId
      while (cursor) {
        if (cursor === id) throw new Error('Cannot move a folder into its own subtree.')
        cursor = this.tree.folders.find((f) => f.id === cursor)?.parentId ?? null
      }
    }

    folder.parentId = parentId
    return this.commit(this.tree)
  }

  allTags(): string[] {
    const tags = new Set<string>()
    for (const session of this.tree.sessions) {
      for (const tag of session.tags) tags.add(tag)
    }
    return [...tags].sort((a, b) => a.localeCompare(b))
  }
}

/**
 * Commands the user has run, one file per session, newest first.
 *
 * Recorded from what is *typed into a session*, so it is the shell's own history
 * rather than a log of everything that reached a pty: control keys, arrow keys
 * and terminal replies are assembled out by the caller and never appear here.
 *
 * A file per session, under `history/`, because the commands that belong to one
 * host should not be mixed into another's list — and because it makes expiry
 * trivial: a file whose newest command is older than the retention window is
 * deleted whole. Nothing here is authority: the store can be emptied at any time
 * without touching settings, sessions or credentials.
 */
export class HistoryStore {
  private readonly dir: string
  /** Parsed files, keyed by session id. Loaded lazily. */
  private readonly cache = new Map<string, HistoryEntry[]>()
  /** The shared suggestion list (see `remember`), loaded once per run. */
  private globalCache: string[] | null = null
  private readonly globalPath: string

  /** Newest first, and never more per session than this. */
  static readonly LIMIT = 200
  /** A single command longer than this is truncated rather than stored whole. */
  static readonly MAX_COMMAND = 500
  /** Files whose newest command is older than this are removed. */
  static readonly RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  /** How many commands the shared suggestion list keeps. */
  static readonly SUGGEST_LIMIT = 400
  /** Longer than this and a line is almost certainly not a command. */
  static readonly SUGGEST_MAX = 240

  constructor(configDir: string) {
    this.dir = join(configDir, 'history')
    mkdirSync(this.dir, { recursive: true })
    this.globalPath = join(configDir, 'commands.json')
    this.prune()
  }

  /**
   * Drop files that have aged out.
   *
   * Run on construction — i.e. at every startup — rather than on a timer: the app
   * is not open for a week at a time, and a check that only happens while it is
   * running would never fire.
   */
  prune(now = Date.now()): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      const entries = this.read(path)
      const newest = entries[0]?.at ?? 0
      // An empty or unreadable file is stale by definition.
      if (!newest || now - newest > HistoryStore.RETENTION_MS) {
        try {
          rmSync(path, { force: true })
        } catch {
          /* a file we cannot remove is retried next start */
        }
        this.cache.delete(name.slice(0, -'.json'.length))
        continue
      }
      const kept = entries.filter((e) => now - e.at <= HistoryStore.RETENTION_MS)
      if (kept.length !== entries.length) this.write(path, kept)
    }
  }

  list(sessionId: string): HistoryEntry[] {
    if (!sessionId) return []
    return this.entries(sessionId).map((e) => ({ ...e }))
  }

  /** Sessions that still have history, newest first. */
  sessions(): HistorySessionSummary[] {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: HistorySessionSummary[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      const entries = this.entries(sessionId)
      if (entries.length === 0) continue
      out.push({
        sessionId,
        title: entries[0].session || sessionId.slice(0, 8),
        count: entries.length,
        updatedAt: entries[0].at
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Record one command.
   *
   * Repeating the previous command is ignored: holding Enter or re-running the
   * same line is not history worth keeping, and it would push everything else
   * out of a capped list.
   */
  add(sessionId: string, session: string, command: string, at = Date.now()): HistoryEntry[] {
    const text = command.trim().slice(0, HistoryStore.MAX_COMMAND)
    if (!text || !sessionId) return this.list(sessionId)

    const current = this.entries(sessionId)
    if (current[0]?.command === text) return this.list(sessionId)

    // The title can change between connections (a renamed host, a reconnect
    // under a different label), so keep the newest one against every entry.
    const next = [{ id: randomUUID(), command: text, session, at }, ...current]
      .slice(0, HistoryStore.LIMIT)
    this.cache.set(sessionId, next)
    return this.persist(sessionId)
  }

  /**
   * The one list every session shares, for the inline suggestions.
   *
   * Per-session files are the right shape for the History panel ("what did I run on
   * this box") but the wrong shape for completing what is being typed: the command
   * you want is very often one you ran in another pane. So the same command is
   * appended here as well, in a single small file, newest first.
   *
   * What is *not* stored matters more than what is. A line that starts with a space
   * is skipped — that is the shell convention for "do not keep this" and the easiest
   * way for a password typed by mistake to stay out of a plain-text file. Empty
   * lines, absurdly long ones and the immediate repeat of the previous command are
   * skipped for the same reason a history file is normally trimmed: they are noise
   * in a popup.
   */
  remember(command: string): void {
    const text = command.replace(/\s+$/, '')
    if (!text || text.length > HistoryStore.MAX_COMMAND) return
    if (text.startsWith(' ')) return
    // An older build recorded the prompt with the command; do not keep that shape.
    if (/^[A-Za-z]:\\/i.test(text) || /^[\w.@-]+[>$#%]\s/.test(text)) return
    if (text.length > HistoryStore.SUGGEST_MAX) return

    const current = this.globalCommands()
    if (current[0] === text) return
    const next = [text, ...current.filter((c) => c !== text)].slice(0, HistoryStore.SUGGEST_LIMIT)
    this.globalCache = next
    try {
      writeJsonAtomic(this.globalPath, next)
    } catch {
      /* the suggestion list is a convenience; losing it must not break a session */
    }
  }

  /** Newest first. */
  globalCommands(): string[] {
    if (this.globalCache) return this.globalCache
    const stored = readJson<unknown>(this.globalPath)
    const list = Array.isArray(stored)
      ? stored.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : []
    this.globalCache = list
      .filter((c) => !/^[A-Za-z]:\\/i.test(c) && !/^[\w.@-]+[>$#%]\s/.test(c))
      .slice(0, HistoryStore.SUGGEST_LIMIT)
    return this.globalCache
  }

  remove(sessionId: string, id: string): HistoryEntry[] {
    this.cache.set(
      sessionId,
      this.entries(sessionId).filter((e) => e.id !== id)
    )
    return this.persist(sessionId)
  }

  clear(sessionId: string): HistoryEntry[] {
    this.cache.set(sessionId, [])
    try {
      rmSync(this.pathFor(sessionId), { force: true })
    } catch {
      /* nothing to remove */
    }
    return []
  }

  private pathFor(sessionId: string): string {
    // Session ids are uuids; anything else is not addressable as a file.
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '')
    return join(this.dir, `${safe}.json`)
  }

  private entries(sessionId: string): HistoryEntry[] {
    if (!sessionId) return []
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const loaded = this.read(this.pathFor(sessionId))
    this.cache.set(sessionId, loaded)
    return loaded
  }

  private read(path: string): HistoryEntry[] {
    const stored = readJson<HistoryEntry[]>(path)
    if (!Array.isArray(stored)) return []
    return stored
      .filter(
        (e): e is HistoryEntry => !!e && typeof e.command === 'string' && typeof e.id === 'string'
      )
      .slice(0, HistoryStore.LIMIT)
  }

  private write(path: string, entries: HistoryEntry[]): void {
    writeJsonAtomic(path, entries)
  }

  private persist(sessionId: string): HistoryEntry[] {
    const entries = this.entries(sessionId)
    if (entries.length === 0) return this.clear(sessionId)
    this.write(this.pathFor(sessionId), entries)
    return this.list(sessionId)
  }
}
