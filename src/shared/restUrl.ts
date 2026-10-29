/**
 * Query parameters and the URL's own query string, kept in step.
 *
 * Apifox-style: the Params table and the URL are two views of one thing, and editing
 * either updates the other. The rule that keeps them from fighting is that the URL is
 * the source of truth *while it is being typed* (the table is re-read from it) and the
 * table is the source of truth when a row changes (the URL is recomposed from it).
 *
 * Encoding: rows are shown decoded (`%20` reads as a space, which is what the user
 * meant) and written back percent-encoded. That is not a byte-for-byte round trip for
 * `+`, which is decoded as a space and re-encoded as `%20` — the same query by every
 * server's reading, and the readable one.
 */
import type { RestParam } from './types'

export interface RestUrlParts {
  /** Everything that is not the query: scheme, host, path, and any `#fragment`. */
  base: string
  /** The query, as rows. Empty when there is no query at all. */
  params: RestParam[]
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    // A stray `%` is the user's text, not a reason to lose the whole parameter.
    return value
  }
}

/** Split a URL into its base and its query rows, in the order they appear. */
export function splitUrlQuery(url: string): RestUrlParts {
  const hash = url.indexOf('#')
  const fragment = hash >= 0 ? url.slice(hash) : ''
  const head = hash >= 0 ? url.slice(0, hash) : url
  const mark = head.indexOf('?')
  if (mark < 0) return { base: head + fragment, params: [] }

  const params: RestParam[] = []
  for (const piece of head.slice(mark + 1).split('&')) {
    if (piece === '') continue
    const eq = piece.indexOf('=')
    const name = eq < 0 ? piece : piece.slice(0, eq)
    const value = eq < 0 ? '' : piece.slice(eq + 1)
    params.push({ name: decode(name), value: decode(value), enabled: true })
  }
  return { base: head.slice(0, mark) + fragment, params }
}

/**
 * Put the query back on the base.
 *
 * Only rows that are enabled and named are written: a half-typed row is a row being
 * typed, not a parameter to send. A row with an empty value still gets its `name=`,
 * because "the parameter is there and empty" and "the parameter is absent" are
 * different requests.
 */
export function composeUrl(base: string, params: RestParam[] | undefined): string {
  const usable = (params ?? []).filter((row) => row.enabled && row.name.trim() !== '')
  if (usable.length === 0) return base
  const query = usable
    .map(
      (row) =>
        `${encodeURIComponent(row.name.trim())}=${encodeURIComponent(row.value)}`
    )
    .join('&')
  // A fragment belongs at the very end, after the query.
  const hash = base.indexOf('#')
  const head = hash >= 0 ? base.slice(0, hash) : base
  const fragment = hash >= 0 ? base.slice(hash) : ''
  return `${head}?${query}${fragment}`
}

/** Are these the rows the URL currently says it has? */
export function sameParams(a: RestParam[] | undefined, b: RestParam[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every(
    (row, at) =>
      row.name === right[at].name &&
      row.value === right[at].value &&
      row.enabled === right[at].enabled
  )
}

/** The rows for a URL being typed: the previous rows, plus whatever the URL now says. */
export function paramsForUrl(url: string, previous: RestParam[] | undefined): RestParam[] {
  const { params } = splitUrlQuery(url)
  /*
   * Rows the URL does not mention are dropped: the URL is what is being edited, and a
   * table that keeps resurrecting a parameter the user just deleted from it is the
   * version of this feature people turn off. Disabled rows are the exception — they are
   * deliberately out of the URL, so they are carried across.
   */
  const kept = (previous ?? []).filter((row) => !row.enabled)
  return [...params, ...kept.filter((row) => !params.some((live) => live.name === row.name))]
}
