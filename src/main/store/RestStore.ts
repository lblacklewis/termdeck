/**
 * The REST page's own state: the request that was on screen, the API collection the
 * user built, the environments `{{name}}` resolves against, and the calls that were
 * made.
 *
 * One file rather than several: they are one page's memory, they change together, and a
 * collection without its environments (or the reverse) is not a state anyone wants to
 * restore.
 *
 * Everything that comes off disk goes through `sanitise` — a whitelist, so a field this
 * file has never heard of cannot reach the page. That is also where the v1 → v2
 * migration lives, and it is deliberately a *reading* rule rather than a rewrite of the
 * file: an install that goes back to an older build finds its requests still there,
 * because the old shape is a subset of the new one. What changes on the way in:
 *
 *   - a saved request with no `folderId` sits at the top level (v1 had a flat list);
 *   - a request with a body and no `bodyMode` gets one inferred — `json` when it parses,
 *     `raw` otherwise — so an old request keeps sending exactly what it sent before.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  REST_HISTORY_LIMIT,
  type RestAuth,
  type RestAuthType,
  type RestBodyMode,
  type RestEnvironment,
  type RestFolder,
  type RestFormField,
  type RestHeader,
  type RestHistoryEntry,
  type RestParam,
  type RestRequest,
  type RestState,
  type SavedRestRequest
} from '@shared/types'
import { clampRestBodyHeight } from '@shared/restLayout'
import { effectiveBodyMode } from '@shared/restBuild'
import { normaliseVariables } from '@shared/restVars'

const METHODS: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const BODY_MODES: RestBodyMode[] = ['none', 'json', 'form', 'raw']
const AUTH_TYPES: RestAuthType[] = ['none', 'bearer', 'basic', 'apikey']

function headers(input: unknown): RestHeader[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((row): row is RestHeader => !!row && typeof row === 'object')
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      value: typeof row.value === 'string' ? row.value : ''
    }))
    .filter((row) => row.name.trim() !== '')
}

/** Query/form rows: a row being typed is data, an empty row is noise. */
function rows(input: unknown): Array<RestParam & RestFormField> {
  if (!Array.isArray(input)) return []
  return input
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      value: typeof row.value === 'string' ? row.value : '',
      enabled: row.enabled !== false
    }))
    .filter((row) => row.name.trim() !== '' || row.value !== '')
}

function auth(input: unknown): RestAuth | undefined {
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Partial<RestAuth>
  if (!AUTH_TYPES.includes(raw.type as RestAuthType)) return undefined
  if (raw.type === 'none') return undefined
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined
  const out: RestAuth = { type: raw.type as RestAuthType }
  if (out.type === 'bearer') out.token = text(raw.token) ?? ''
  if (out.type === 'basic') {
    out.username = text(raw.username) ?? ''
    out.password = text(raw.password) ?? ''
  }
  if (out.type === 'apikey') {
    out.key = text(raw.key) ?? ''
    out.value = text(raw.value) ?? ''
  }
  return out
}

/** A request as stored, with anything unusable dropped rather than guessed. */
function sanitiseRequest(input: unknown): RestRequest | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<RestRequest>
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url) return null
  const method = METHODS.includes(raw.method as RestRequest['method'])
    ? (raw.method as RestRequest['method'])
    : 'GET'
  const timeoutMs =
    typeof raw.timeoutMs === 'number' && raw.timeoutMs >= 1000 && raw.timeoutMs <= 300_000
      ? raw.timeoutMs
      : undefined
  const request: RestRequest = {
    method,
    url,
    headers: headers(raw.headers)
  }
  const params = rows(raw.params)
  if (params.length > 0) request.params = params
  const form = rows(raw.form)
  if (form.length > 0) request.form = form
  request.bodyMode = BODY_MODES.includes(raw.bodyMode as RestBodyMode)
    ? (raw.bodyMode as RestBodyMode)
    : effectiveBodyMode({ ...request, body: typeof raw.body === 'string' ? raw.body : undefined })
  if (typeof raw.body === 'string' && raw.body !== '') request.body = raw.body
  const credentials = auth(raw.auth)
  if (credentials) request.auth = credentials
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs
  if (raw.insecure === true) request.insecure = true
  return request
}

/**
 * A sent call as stored.
 *
 * Dropped rather than repaired when the request itself is unusable — an entry with no
 * URL cannot be re-run, and half an entry in the list is worse than none.
 */
function sanitiseHistory(input: unknown): RestHistoryEntry[] {
  if (!Array.isArray(input)) return []
  return input
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null
      const input = raw as Partial<RestHistoryEntry>
      const request = sanitiseRequest(input.request)
      if (!request) return null
      const status =
        typeof input.status === 'number' && Number.isFinite(input.status)
          ? input.status
          : undefined
      const entry: RestHistoryEntry = {
        id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
        at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
        request,
        ok: input.ok === true,
        durationMs:
          typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
            ? Math.max(0, Math.round(input.durationMs))
            : 0
      }
      // Only present when it happened: a failed call has no status, and an absent field
      // says that more clearly than `undefined` written to the file.
      if (status !== undefined) entry.status = status
      return entry
    })
    .filter((entry): entry is RestHistoryEntry => entry !== null)
    .slice(0, REST_HISTORY_LIMIT)
}

function folders(input: unknown): RestFolder[] {
  if (!Array.isArray(input)) return []
  const out: RestFolder[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<RestFolder>
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (name === '') continue
    const id = typeof row.id === 'string' && row.id ? row.id : randomUUID()
    const folder: RestFolder = {
      id,
      name,
      parentId:
        typeof row.parentId === 'string' && row.parentId !== '' ? row.parentId : null
    }
    if (row.expanded === true) folder.expanded = true
    out.push(folder)
  }
  /*
   * A folder whose parent is not in the list would be unreachable in the tree, so it is
   * promoted to the top level rather than hidden. Same for a cycle two levels deep: the
   * walk stops when it meets itself.
   */
  const ids = new Set(out.map((folder) => folder.id))
  for (const folder of out) {
    if (folder.parentId !== null && !ids.has(folder.parentId)) folder.parentId = null
    let walk = folder.parentId
    const seen = new Set([folder.id])
    while (walk !== null) {
      if (seen.has(walk)) {
        folder.parentId = null
        break
      }
      seen.add(walk)
      walk = out.find((entry) => entry.id === walk)?.parentId ?? null
    }
  }
  return out
}

function environments(input: unknown): RestEnvironment[] {
  if (!Array.isArray(input)) return []
  return input
    .map((raw): RestEnvironment | null => {
      if (!raw || typeof raw !== 'object') return null
      const row = raw as Partial<RestEnvironment>
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (name === '') return null
      return {
        id: typeof row.id === 'string' && row.id ? row.id : randomUUID(),
        name,
        variables: normaliseVariables(row.variables)
      }
    })
    .filter((entry): entry is RestEnvironment => entry !== null)
}

function sanitise(input: unknown): RestState {
  if (!input || typeof input !== 'object') {
    return {
      draft: null,
      folders: [],
      saved: [],
      environments: [],
      activeEnvironmentId: null,
      history: []
    }
  }
  const raw = input as Partial<RestState>
  const saved: SavedRestRequest[] = Array.isArray(raw.saved)
    ? raw.saved
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          const request = sanitiseRequest(entry.request)
          if (!request) return null
          const stored: SavedRestRequest = {
            id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : request.url,
            // v1 had no folders: everything it saved belongs at the top level.
            folderId:
              typeof entry.folderId === 'string' && entry.folderId !== ''
                ? entry.folderId
                : null,
            request
          }
          return stored
        })
        .filter((entry): entry is SavedRestRequest => entry !== null)
    : []
  const tree = folders(raw.folders)
  /*
   * A request filed in a folder that no longer exists is moved to the top level: losing
   * a request because its folder was deleted is not a trade anyone would accept, and
   * "it is in the tree somewhere" is what the user asked for when they saved it.
   */
  const folderIds = new Set(tree.map((folder) => folder.id))
  for (const entry of saved) {
    if (entry.folderId && !folderIds.has(entry.folderId)) entry.folderId = null
  }
  const sets = environments(raw.environments)
  const active =
    typeof raw.activeEnvironmentId === 'string' &&
    sets.some((set) => set.id === raw.activeEnvironmentId)
      ? raw.activeEnvironmentId
      : null
  return {
    draft: sanitiseRequest(raw.draft),
    folders: tree,
    saved,
    environments: sets,
    activeEnvironmentId: active,
    history: sanitiseHistory(raw.history),
    // A hard whitelist, like the rest of this file: a field that is not listed here
    // never reaches the page. `undefined` means "never resized".
    bodyHeight: clampRestBodyHeight(raw.bodyHeight)
  }
}

export class RestStore {
  private readonly path: string
  private state: RestState

  constructor(configDir: string) {
    this.path = join(configDir, 'rest.json')
    this.state = sanitise(this.read())
  }

  private read(): unknown {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // A corrupt file must not block the page; an empty state is honest.
      return null
    }
  }

  load(): RestState {
    return this.state
  }

  save(next: RestState): RestState {
    this.state = sanitise(next)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.path)
    return this.state
  }
}
