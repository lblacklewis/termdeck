/**
 * Reading the batch "add several hosts" box.
 *
 * One host per line, with the conveniences a paste deserves:
 *
 *     web1.example.com
 *     root@10.0.0.5
 *     root@10.0.0.5:2222
 *     10.17.20.210-215            → .210 .211 .212 .213 .214 .215
 *     node01-04                   → node01 … node04
 *     10.17.20.210-10.17.20.215   → the same range, spelled out at both ends
 *     # a comment, and blank lines, are ignored
 *
 * Anything on a line that is not a host is reported rather than dropped: a
 * silently shorter list is the one outcome the user cannot check.
 */

/** Most a single paste may create. Long enough for a subnet, short enough to undo. */
export const BATCH_HOST_LIMIT = 256

export interface BatchHostEntry {
  /** Host name or address, with any range already expanded. */
  host: string
  /** Port from the line itself; the shared port applies when this is absent. */
  port?: number
  /** User from the line itself; the shared user applies when this is absent. */
  username?: string
}

export interface BatchHostProblem {
  /** The token as typed, so the message can quote it. */
  text: string
  reason: string
}

export interface BatchHostsResult {
  entries: BatchHostEntry[]
  problems: BatchHostProblem[]
  /** True when `BATCH_HOST_LIMIT` cut the list short. */
  truncated: boolean
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4(value: string): boolean {
  const match = IPV4.exec(value)
  return !!match && match.slice(1).every((part) => Number(part) <= 255)
}

/** `prefix210`, `prefix211`, … as zero-padded as the ends were written. */
function span(prefix: string, from: number, to: number, width: number): string[] {
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(prefix + String(n).padStart(width, '0'))
  return out
}

/**
 * Expand a range whose *trailing digits* move: the hosts, an error, or null when
 * the token is not a range at all.
 *
 * One rule covers both `10.17.20.210-215` and `node01-04`, and it cannot mistake
 * an ordinary hyphenated name for a range: the part before the hyphen has to end
 * in digits and the part after has to be digits only (`web-1.example.com` fails
 * the first test).
 *
 * A range that runs backwards is an error rather than "not a range": it would
 * otherwise be accepted as a host called `10.17.20.215-210`, which is the kind of
 * typo that gets discovered much later.
 */
function expandRange(token: string): { hosts: string[] } | { error: string } | null {
  const dash = token.indexOf('-')
  if (dash <= 0 || dash === token.length - 1) return null

  const head = token.slice(0, dash)
  const tail = token.slice(dash + 1)

  // A full address at both ends, differing only in the last octet.
  if (isIpv4(tail)) {
    if (!isIpv4(head)) return null
    const headDot = head.lastIndexOf('.')
    const tailDot = tail.lastIndexOf('.')
    if (head.slice(0, headDot) !== tail.slice(0, tailDot)) return null
    const from = Number(head.slice(headDot + 1))
    const to = Number(tail.slice(tailDot + 1))
    if (from > to) return { error: 'range runs backwards' }
    return { hosts: span(head.slice(0, headDot + 1), from, to, head.slice(headDot + 1).length) }
  }

  if (!/^\d+$/.test(tail)) return null
  const digits = /(\d+)$/.exec(head)
  if (!digits) return null

  const from = Number(digits[1])
  const to = Number(tail)
  if (from > to) return { error: 'range runs backwards' }
  const prefix = head.slice(0, head.length - digits[1].length)
  return { hosts: span(prefix, from, to, Math.max(digits[1].length, tail.length)) }
}

/** One token to zero or more entries, or a reason it cannot be read. */
function parseToken(token: string): BatchHostEntry[] | string {
  let rest = token
  if (rest.toLowerCase().startsWith('ssh://')) rest = rest.slice('ssh://'.length)

  let username: string | undefined
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    username = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }

  let port: number | undefined
  if (rest.startsWith('[')) {
    // Bracketed so the colons inside an IPv6 address stay part of the address.
    const close = rest.indexOf(']')
    if (close < 0) return 'unclosed ['
    const after = rest.slice(close + 1)
    if (after && !after.startsWith(':')) return 'unexpected text after ]'
    if (after) {
      const parsed = readPort(after.slice(1))
      if (typeof parsed === 'string') return parsed
      port = parsed
    }
    rest = rest.slice(1, close)
  } else {
    const colon = rest.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      const parsed = readPort(rest.slice(colon + 1))
      if (typeof parsed === 'string') return parsed
      port = parsed
      rest = rest.slice(0, colon)
    }
  }

  if (!rest) return 'no host'
  if (/[\s,;]/.test(rest)) return 'not a host name'

  const range = expandRange(rest)
  if (range && 'error' in range) return range.error
  if (range) {
    if (range.hosts.length > BATCH_HOST_LIMIT) {
      return `range of ${range.hosts.length} is too large`
    }
    return range.hosts.map((host) => ({ host, port, username }))
  }
  return [{ host: rest, port, username }]
}

function readPort(text: string): number | string {
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `port out of range: ${text}`
  return port
}

/** Parse the whole box. Order is kept; duplicates inside the paste are dropped. */
export function parseBatchHosts(text: string, limit = BATCH_HOST_LIMIT): BatchHostsResult {
  const entries: BatchHostEntry[] = []
  const problems: BatchHostProblem[] = []
  const seen = new Set<string>()
  let truncated = false

  const push = (entry: BatchHostEntry): void => {
    const key = `${entry.username ?? ''}@${entry.host}:${entry.port ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  outer: for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]
    for (const token of line.split(/[\s,;]+/)) {
      if (!token) continue
      if (entries.length >= limit) {
        truncated = true
        break outer
      }
      const parsed = parseToken(token)
      if (typeof parsed === 'string') {
        problems.push({ text: token, reason: parsed })
        continue
      }
      for (const entry of parsed) {
        if (entries.length >= limit) {
          truncated = true
          break outer
        }
        push(entry)
      }
    }
  }

  return { entries, problems, truncated }
}
