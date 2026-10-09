/**
 * Small JSON persistence helper plus the two documents TermDeck keeps:
 * application settings and the saved-session tree.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
 * half-written config behind, and corrupt files fall back to defaults instead of
 * preventing startup.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Keybinding,
  type SavedSession,
  type SessionFolder,
  type SessionTree,
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
    theme: typeof stored.theme === 'string' && stored.theme ? stored.theme : defaults.theme,
    // Clamped here so a hand-edited file cannot leave the UI unusable
    // (invisible at 0.1, unusable at 10).
    uiScale: clampScale(stored.uiScale ?? screenDefaultScale)
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
        'tags',
        'color',
        'notes',
        'parentId'
      ] as Array<keyof SavedSession>) {
        assign(key)
      }
      existing.name = existing.name?.trim() || `${existing.username}@${existing.host}`
      existing.updatedAt = now
    } else {
      this.tree.sessions.push({
        id: input.id ?? randomUUID(),
        name: input.name?.trim() || `${input.username ?? 'root'}@${input.host}`,
        host: input.host,
        port: input.port ?? 22,
        username: input.username ?? 'root',
        authMethod: input.authMethod ?? 'password',
        privateKeyPath: input.privateKeyPath,
        tags: input.tags ?? [],
        color: input.color,
        notes: input.notes,
        parentId: input.parentId ?? null,
        createdAt: now,
        updatedAt: now
      })
    }

    return this.commit(this.tree)
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
