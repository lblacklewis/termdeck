/**
 * Pure decision-making for the S3 page.
 *
 * What the object tree looks like, which visits the history keeps, and how many
 * columns the window can afford are rules, not effects — so they live here,
 * free of React, the DOM and the main process, where a probe can assert each
 * one with injected inputs (a fixture listing, a clock, a window width) instead
 * of screenshots. The page and the store both consume this module; neither
 * re-implements a rule the other also knows.
 */
import type { S3BucketInfo, S3Listing, S3Visit } from './s3Types'

/** How many recent visits the history keeps: enough to find yesterday's place, small enough to stay a list. */
export const S3_HISTORY_LIMIT = 20

/** The identity of a visit — the same endpoint, bucket and prefix is the same place. */
export function s3VisitKey(visit: Pick<S3Visit, 'endpoint' | 'bucket' | 'prefix'>): string {
  return `${visit.endpoint}\n${visit.bucket}\n${visit.prefix}`
}

/**
 * Record one visit, newest first, collapsing repeats.
 *
 * The entry is built field by field on purpose: a caller that spreads a whole
 * connection in cannot grow the history a `secretAccessKey` by accident, and
 * the persisted shape stays exactly the four connection facts plus where.
 * Revisiting a place moves it to the top with a fresh instant instead of
 * duplicating it; `options.now` (an ISO instant) is injected so probes can pin
 * the clock, and `options.max` so they can exercise the cap with a small one.
 */
export function pushS3Visit(
  history: S3Visit[],
  visit: S3Visit,
  options?: { max?: number; now?: string }
): S3Visit[] {
  const max = options?.max ?? S3_HISTORY_LIMIT
  const entry: S3Visit = {
    endpoint: visit.endpoint,
    region: visit.region,
    accessKeyId: visit.accessKeyId,
    pathStyle: visit.pathStyle !== false,
    insecure: visit.insecure === true ? true : undefined,
    bucket: visit.bucket,
    prefix: visit.prefix,
    at: options?.now ?? visit.at
  }
  const key = s3VisitKey(entry)
  const rest = history.filter((other) => s3VisitKey(other) !== key)
  return [entry, ...rest].slice(0, Math.max(1, max))
}

/**
 * What the store is willing to keep, from whatever the file or the wire held.
 *
 * A history entry is a place, not credentials: entries without an endpoint or
 * a bucket are dropped, unknown fields are left behind, and the list is capped
 * so a hand-edited file cannot make it grow without bound.
 */
export function normaliseS3History(input: unknown, options?: { max?: number }): S3Visit[] {
  const max = options?.max ?? S3_HISTORY_LIMIT
  if (!Array.isArray(input)) return []
  const visits: S3Visit[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Partial<S3Visit>
    if (typeof entry.endpoint !== 'string' || !entry.endpoint.trim()) continue
    if (typeof entry.bucket !== 'string' || !entry.bucket) continue
    visits.push({
      endpoint: entry.endpoint,
      region: typeof entry.region === 'string' ? entry.region : '',
      accessKeyId: typeof entry.accessKeyId === 'string' ? entry.accessKeyId : '',
      pathStyle: entry.pathStyle !== false,
      insecure: entry.insecure === true ? true : undefined,
      bucket: entry.bucket,
      prefix: typeof entry.prefix === 'string' ? entry.prefix : '',
      at: typeof entry.at === 'string' ? entry.at : ''
    })
  }
  return visits.slice(0, Math.max(1, max))
}

/** One row of the object tree: a bucket, a folder prefix, or an object. */
export interface S3TreeNode {
  kind: 'bucket' | 'folder' | 'object'
  /** What a click means: the bucket name, the folder prefix (trailing `/`), or the object key. */
  path: string
  /** What the row draws: the last segment, folders keeping their trailing slash. */
  label: string
  /** Indent level. The bucket sits at 0; under it, the number of path segments. */
  depth: number
  size?: number
  lastModified?: string
}

function depthOf(path: string): number {
  return path.split('/').filter(Boolean).length
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? path
  return path.endsWith('/') ? `${last}/` : last
}

/**
 * The listing as a tree, with the buckets as roots.
 *
 * Every bucket stays in the tree so switching is one click; the open bucket's
 * current listing hangs beneath it. The folders above the open prefix are part
 * of the shape even though the current page did not list them — standing in
 * `a/b/` must show `a/` and `a/b/`, or the files would float two levels deep
 * with nothing holding them up.
 */
export function buildS3Tree(
  buckets: S3BucketInfo[],
  listing: S3Listing | null,
  activeBucket: string
): S3TreeNode[] {
  const nodes: S3TreeNode[] = []
  const chain: string[] = []
  if (listing && listing.prefix) {
    const parts = listing.prefix.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i += 1) chain.push(`${parts.slice(0, i).join('/')}/`)
  }
  for (const bucket of buckets) {
    nodes.push({ kind: 'bucket', path: bucket.name, label: bucket.name, depth: 0 })
    if (!listing || bucket.name !== activeBucket) continue
    for (const prefix of chain) {
      nodes.push({ kind: 'folder', path: prefix, label: lastSegment(prefix), depth: depthOf(prefix) })
    }
    for (const prefix of listing.prefixes) {
      if (chain.includes(prefix)) continue
      nodes.push({ kind: 'folder', path: prefix, label: lastSegment(prefix), depth: depthOf(prefix) })
    }
    for (const object of listing.objects) {
      nodes.push({
        kind: 'object',
        path: object.key,
        label: lastSegment(object.key),
        depth: depthOf(object.key),
        size: object.size,
        lastModified: object.lastModified
      })
    }
  }
  return nodes
}

export type S3WorkspaceColumns = 'three' | 'stacked'

/**
 * How many columns the workspace can afford, at the injected window width.
 *
 * Three columns need real room: below the threshold the same three areas stack
 * instead, in DOM order — tree, contents, metadata — which is also the order a
 * narrow window or a screen reader meets them in.
 */
export function s3WorkspaceColumns(
  width: number,
  thresholds?: { three?: number }
): S3WorkspaceColumns {
  return width >= (thresholds?.three ?? 1080) ? 'three' : 'stacked'
}
