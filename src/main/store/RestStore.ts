/**
 * The REST page's own state: the request that was on screen, and the ones the
 * user kept.
 *
 * One file rather than two: they are one page's memory, they change together,
 * and a draft without its saved list (or the reverse) is not a state anyone
 * wants to restore.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  REST_HISTORY_LIMIT,
  type RestHeader,
  type RestHistoryEntry,
  type RestRequest,
  type RestState,
  type SavedRestRequest
} from '@shared/types'

const METHODS: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

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
  return {
    method,
    url,
    headers: headers(raw.headers),
    body: typeof raw.body === 'string' && raw.body !== '' ? raw.body : undefined,
    timeoutMs,
    insecure: raw.insecure === true ? true : undefined
  }
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

function sanitise(input: unknown): RestState {
  if (!input || typeof input !== 'object') return { draft: null, saved: [], history: [] }
  const raw = input as Partial<RestState>
  const saved: SavedRestRequest[] = Array.isArray(raw.saved)
    ? raw.saved
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          const request = sanitiseRequest(entry.request)
          if (!request) return null
          return {
            id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : request.url,
            request
          }
        })
        .filter((entry): entry is SavedRestRequest => entry !== null)
    : []
  return { draft: sanitiseRequest(raw.draft), saved, history: sanitiseHistory(raw.history) }
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
