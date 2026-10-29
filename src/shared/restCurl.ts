/**
 * cURL out, and cURL in.
 *
 * Out is the old feature: the interesting moment is when something works here and has
 * to be reproduced somewhere else — a runbook, a colleague's machine, a container — and
 * retyping a signed-looking request by hand is how you end up wondering why it behaves
 * differently there.
 *
 * In is the other half, and the one that saves the most typing: every API you have ever
 * been given a key for comes with a `curl` line in its documentation. Pasting it here
 * should fill in the method, URL, query, headers and body — not make you transcribe
 * them by hand into six fields.
 *
 * What the parser deliberately does not do: multipart `-F` (a file upload has no form
 * in this page yet, so it says so rather than dropping the file), and any rewriting of
 * values — a `{{host}}` in a pasted line stays a `{{host}}`, on purpose.
 */
import type { RestHeader, RestRequest } from './types'
import { authHeaders } from './restBuild'
import { splitUrlQuery } from './restUrl'

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * The request as a `curl` line, with the parameters folded back into the URL and the
 * auth block as the header it becomes — so the line reproduces *this* request, not the
 * pieces it was typed as. Variables are left as written: the point of the copy is to
 * reproduce the call, and whichever machine runs it will want its own environment.
 */
export function buildCurl(request: RestRequest): string {
  const base = splitUrlQuery(request.url)
  const rows =
    (request.params ?? []).length > 0
      ? (request.params ?? []).filter((row) => row.enabled && row.name.trim() !== '')
      : base.params
  const query = rows
    .map((row) => `${encodeURIComponent(row.name.trim())}=${encodeURIComponent(row.value)}`)
    .join('&')
  const url = query === '' ? base.base : `${base.base}?${query}`

  const parts = [`curl -X ${request.method}`, quote(url)]
  const headers: RestHeader[] = [
    ...request.headers.filter((header) => header.name.trim() !== ''),
    ...authHeaders(request.auth)
  ]
  for (const header of headers) {
    parts.push(`-H ${quote(`${header.name}: ${header.value}`)}`)
  }
  const body = request.bodyMode === 'form' ? undefined : request.body
  if (body && request.method !== 'GET' && request.method !== 'HEAD') {
    parts.push(`--data ${quote(body)}`)
  }
  if (request.bodyMode === 'form') {
    const fields = (request.form ?? []).filter(
      (field) => field.enabled && field.name.trim() !== ''
    )
    if (fields.length > 0 && request.method !== 'GET' && request.method !== 'HEAD') {
      const encoded = fields
        .map(
          (field) =>
            `${encodeURIComponent(field.name.trim())}=${encodeURIComponent(field.value)}`
        )
        .join('&')
      parts.push(`--data ${quote(encoded)}`)
    }
  }
  if (request.insecure) parts.push('--insecure')
  return parts.join(' \\\n  ')
}

/**
 * Split a shell command into words the way a shell would, for the quoting people
 * actually use in documentation: `'single'`, `"double"`, and backslash continuations.
 * Returns null when a quote is never closed.
 */
function tokenize(text: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    if (char === '\\' && quote !== "'") {
      const next = text[at + 1]
      if (next === '\n') {
        at += 1
        continue
      }
      if (next === '\r' && text[at + 2] === '\n') {
        at += 2
        continue
      }
      if (next !== undefined) {
        current += next
        started = true
        at += 1
        continue
      }
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

/** Flags that take the next word as their value. */
const WITH_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary',
  '--data-ascii', '--data-urlencode', '-u', '--user', '-b', '--cookie', '-A',
  '--user-agent', '-e', '--referer', '--url', '-o', '--output', '-F', '--form',
  '--retry', '--connect-timeout', '--max-time', '-m', '-x', '--proxy', '--cert',
  '--key', '--cacert', '--interface', '--resolve'
])

/** Flags that mean nothing here but must not be mistaken for the URL. */
const IGNORED = new Set([
  '-k', '--insecure', '-s', '--silent', '-S', '--show-error', '-L', '--location',
  '-i', '--include', '-v', '--verbose', '--compressed', '-G', '--get', '-I', '--head',
  '-g', '--globoff', '--no-buffer', '-N', '--fail', '-f', '--tlsv1.2', '--http1.1',
  '--http2'
])

export type CurlImport =
  | { ok: true; request: RestRequest }
  | { ok: false; message: string }

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/** Read a pasted `curl` command into a request. */
export function parseCurl(text: string): CurlImport {
  const tokens = tokenize(text.trim())
  if (!tokens) return { ok: false, message: 'a quote in this command is never closed' }
  if (tokens.length === 0) return { ok: false, message: 'this is empty' }
  if (!/(^|[\\/])curl(\.exe)?$/i.test(tokens[0])) {
    return { ok: false, message: 'this does not start with curl' }
  }

  let method: RestRequest['method'] | null = null
  let url = ''
  let user = ''
  let insecure = false
  let asQuery = false
  const headers: RestHeader[] = []
  const data: string[] = []

  for (let at = 1; at < tokens.length; at += 1) {
    let token = tokens[at]
    let inline: string | null = null
    if (token.startsWith('--') && token.includes('=')) {
      const cut = token.indexOf('=')
      inline = token.slice(cut + 1)
      token = token.slice(0, cut)
    }
    const value = (): string | null => {
      if (inline !== null) return inline
      const next = tokens[at + 1]
      if (next === undefined) return null
      at += 1
      return next
    }

    if (token === '-X' || token === '--request') {
      const given = value()
      if (given === null) return { ok: false, message: '-X has no method after it' }
      const upper = given.toUpperCase()
      const known: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
      method = (known as string[]).includes(upper)
        ? (upper as RestRequest['method'])
        : 'GET'
      continue
    }
    if (token === '-H' || token === '--header') {
      const given = value()
      if (given === null) return { ok: false, message: '-H has no header after it' }
      const cut = given.indexOf(':')
      if (cut > 0) {
        headers.push({ name: given.slice(0, cut).trim(), value: given.slice(cut + 1).trim() })
      }
      continue
    }
    if (
      token === '-d' || token === '--data' || token === '--data-raw' ||
      token === '--data-binary' || token === '--data-ascii' || token === '--data-urlencode'
    ) {
      const given = value()
      if (given === null) return { ok: false, message: '-d has no data after it' }
      data.push(given)
      continue
    }
    if (token === '-u' || token === '--user') {
      const given = value()
      if (given === null) return { ok: false, message: '-u has no credentials after it' }
      user = given
      continue
    }
    if (token === '-b' || token === '--cookie') {
      const given = value()
      if (given === null) return { ok: false, message: '-b has no value after it' }
      headers.push({ name: 'Cookie', value: given })
      continue
    }
    if (token === '-A' || token === '--user-agent') {
      const given = value()
      if (given === null) return { ok: false, message: '-A has no value after it' }
      headers.push({ name: 'User-Agent', value: given })
      continue
    }
    if (token === '-e' || token === '--referer') {
      const given = value()
      if (given === null) return { ok: false, message: '-e has no value after it' }
      headers.push({ name: 'Referer', value: given })
      continue
    }
    if (token === '--url') {
      const given = value()
      if (given === null) return { ok: false, message: '--url has no value after it' }
      url = given
      continue
    }
    if (token === '-F' || token === '--form') {
      value()
      return {
        ok: false,
        message: 'multipart forms (-F) are not supported: upload the file through the SFTP page instead'
      }
    }
    if (token === '-k' || token === '--insecure') {
      insecure = true
      continue
    }
    if (token === '-G' || token === '--get') {
      asQuery = true
      continue
    }
    if (token === '-I' || token === '--head') {
      method = 'HEAD'
      continue
    }
    if (WITH_VALUE.has(token)) {
      value()
      continue
    }
    if (IGNORED.has(token)) continue
    if (token.startsWith('-')) {
      // An unknown flag is skipped rather than refused: a copied line is allowed to be
      // newer than this parser, and the parts that were understood are still useful.
      continue
    }
    if (url === '') {
      url = token
      continue
    }
    // A second bare word is a second URL, or an argument to something unrecognised.
  }

  if (url.trim() === '') {
    return { ok: false, message: 'no URL in this command' }
  }

  const joined = data.join('&')
  const contentType = headers.find(
    (header) => header.name.toLowerCase() === 'content-type'
  )?.value
  const bodyMode: RestRequest['bodyMode'] =
    joined === ''
      ? 'none'
      : looksLikeJson(joined) || (contentType ?? '').includes('json')
        ? 'json'
        : 'raw'

  // `-G` puts the data in the query string; without it, a URL that already carries a
  // query still shows up in the table, because that is how this page edits queries.
  const parts = splitUrlQuery(url)
  const params = [...parts.params]
  if (asQuery && joined !== '') {
    for (const piece of joined.split('&')) {
      const cut = piece.indexOf('=')
      params.push({
        name: cut < 0 ? piece : piece.slice(0, cut),
        value: cut < 0 ? '' : piece.slice(cut + 1),
        enabled: true
      })
    }
  }

  const request: RestRequest = {
    method: method ?? (asQuery || joined === '' ? 'GET' : 'POST'),
    url: parts.base,
    headers
  }
  if (params.length > 0) request.params = params
  if (url.includes('?')) {
    // The query moved into the table, so the URL is the base.
    request.url = parts.base
  }
  if (bodyMode !== 'none' && !asQuery) {
    request.bodyMode = bodyMode
    request.body = joined
  }
  if (user !== '') {
    const cut = user.indexOf(':')
    request.auth = {
      type: 'basic',
      username: cut < 0 ? user : user.slice(0, cut),
      password: cut < 0 ? '' : user.slice(cut + 1)
    }
  }
  if (insecure) request.insecure = true
  return { ok: true, request }
}
