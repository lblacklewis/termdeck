/**
 * The request as it actually goes on the wire.
 *
 * What the user edits (URL, parameter table, headers, body, auth) is a description;
 * this turns it into the one URL, header list and body the main process sends. Keeping
 * it here rather than in the page is what makes the interesting parts assertable
 * without a window: parameters folded back into the URL, `{{name}}` resolved against
 * the active environment, an auth block becoming a header, and the two body modes that
 * have a content type.
 *
 * Two rules that are decisions rather than mechanics:
 *
 *   - a header the user typed wins over one an auth block would add. The auth block is
 *     a convenience for the common case; an explicit `Authorization` line is someone
 *     saying exactly what they mean.
 *   - a name the environment does not define is left in the text and reported. The
 *     caller decides whether to refuse (`ok: false`); nothing here silently blanks a
 *     value, because a request that goes out with an empty host fails somewhere far
 *     from the missing variable.
 */
import type {
  RestAuth,
  RestBodyMode,
  RestEnvironment,
  RestHeader,
  RestRequest
} from './types'
import { composeUrl, splitUrlQuery } from './restUrl'
import { environmentVars, substituteVars, varsUsed } from './restVars'

export interface BuiltRestRequest {
  method: RestRequest['method']
  url: string
  headers: RestHeader[]
  body?: string
  /**
   * How long the sender waits, and whether it accepts a self-signed certificate.
   *
   * Not part of the wire format, but part of "the request that goes out": leaving them
   * behind would silently substitute the sender's defaults, which is a bug the probe
   * caught only because a one-second timeout behaved like fifteen.
   */
  timeoutMs?: number
  insecure?: boolean
}

export interface RestBuild {
  /** False when a variable is undefined: the request is described, but not sendable. */
  ok: boolean
  request: BuiltRestRequest
  /** `{{name}}`s the active environment does not define. */
  missing: string[]
}

/** How a body is meant when the request does not say (requests stored before modes). */
export function effectiveBodyMode(request: RestRequest): RestBodyMode {
  if (request.bodyMode) return request.bodyMode
  if (!request.body) return 'none'
  try {
    JSON.parse(request.body)
    return 'json'
  } catch {
    return 'raw'
  }
}

/** What an auth block becomes on the way out. Nothing for `none`. */
export function authHeaders(auth: RestAuth | undefined): RestHeader[] {
  if (!auth) return []
  const value = (text: string | undefined): string => text ?? ''
  switch (auth.type) {
    case 'bearer':
      return value(auth.token).trim() === ''
        ? []
        : [{ name: 'Authorization', value: `Bearer ${auth.token}` }]
    case 'basic': {
      if (value(auth.username) === '' && value(auth.password) === '') return []
      const pair = `${value(auth.username)}:${value(auth.password)}`
      return [{ name: 'Authorization', value: `Basic ${base64(utf8(pair))}` }]
    }
    case 'apikey':
      return value(auth.key).trim() === ''
        ? []
        : [{ name: auth.key as string, value: value(auth.value) }]
    default:
      return []
  }
}

/** UTF-8 bytes of a string, without depending on TextEncoder being a global. */
function utf8(text: string): number[] {
  const out: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) as number
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64, written out rather than borrowed from a global. */
function base64(bytes: number[]): string {
  let out = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]
    const b = bytes[at + 1]
    const c = bytes[at + 2]
    out += B64[a >> 2]
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 0x3f]
  }
  return out
}

/** The body text and the content type that goes with the mode, if any. */
export function bodyFor(request: RestRequest): { body?: string; contentType?: string } {
  const mode = effectiveBodyMode(request)
  if (mode === 'none') return {}
  if (mode === 'form') {
    const fields = (request.form ?? []).filter(
      (field) => field.enabled && field.name.trim() !== ''
    )
    const encoded = fields
      .map(
        (field) =>
          `${encodeURIComponent(field.name.trim())}=${encodeURIComponent(field.value)}`
      )
      .join('&')
    return { body: encoded, contentType: 'application/x-www-form-urlencoded' }
  }
  if (mode === 'json') return { body: request.body ?? '', contentType: 'application/json' }
  return { body: request.body ?? '' }
}

function hasHeader(headers: RestHeader[], name: string): boolean {
  const wanted = name.toLowerCase()
  return headers.some((header) => header.name.trim().toLowerCase() === wanted)
}

export function buildRestRequest(
  request: RestRequest,
  environment: RestEnvironment | null | undefined
): RestBuild {
  const vars = environmentVars(environment)
  const missing: string[] = []
  const take = (text: string): string => {
    const done = substituteVars(text, vars)
    for (const name of done.missing) if (!missing.includes(name)) missing.push(name)
    return done.text
  }

  /*
   * The URL is the source of truth once it has a query of its own; otherwise the rows
   * come from the table. The page keeps the two in step, so this only matters for a
   * request that arrived from somewhere else — an imported cURL line, a hand-edited
   * file — and then "what the URL says" is the honest reading.
   */
  const fromUrl = splitUrlQuery(request.url)
  const rows = (request.params ?? []).length > 0 ? (request.params ?? []) : fromUrl.params
  const url = composeUrl(
    take(fromUrl.base),
    rows.map((row) => ({
      name: row.name,
      value: take(row.value),
      enabled: row.enabled
    }))
  )

  const headers: RestHeader[] = request.headers.map((header) => ({
    name: take(header.name),
    value: take(header.value)
  }))

  const { body, contentType } = bodyFor(request)
  const sentBody = body === undefined ? undefined : take(body)
  if (contentType && !hasHeader(headers, 'content-type')) {
    headers.push({ name: 'Content-Type', value: contentType })
  }
  for (const header of authHeaders(request.auth)) {
    if (!hasHeader(headers, header.name)) headers.push(header)
  }

  const built: BuiltRestRequest = { method: request.method, url, headers }
  if (sentBody !== undefined) built.body = sentBody
  if (request.timeoutMs !== undefined) built.timeoutMs = request.timeoutMs
  if (request.insecure === true) built.insecure = true
  return { ok: missing.length === 0, request: built, missing }
}

/** The variables a whole request refers to, for the page's "used but undefined" hint. */
export function requestVars(request: RestRequest): string[] {
  const pieces: string[] = [request.url]
  for (const row of request.params ?? []) pieces.push(row.name, row.value)
  for (const header of request.headers) pieces.push(header.name, header.value)
  if (request.body) pieces.push(request.body)
  for (const field of request.form ?? []) pieces.push(field.name, field.value)
  const auth = request.auth
  if (auth) {
    pieces.push(
      auth.token ?? '',
      auth.username ?? '',
      auth.password ?? '',
      auth.key ?? '',
      auth.value ?? ''
    )
  }
  const out: string[] = []
  for (const piece of pieces) {
    for (const name of varsUsed(piece)) if (!out.includes(name)) out.push(name)
  }
  return out
}
