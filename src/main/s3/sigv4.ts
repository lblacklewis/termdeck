import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4, hand-rolled.
 *
 * A signing library would be the obvious dependency here, but the whole point of
 * this tool is to be small: SigV4 is one hash, four HMACs and a canonical string
 * with precise rules. Those rules are also the only part that can be wrong
 * *silently* — a bad signature is just a 403 from the far end — so this module is
 * covered by AWS's own published test vectors in `npm run check:s3`.
 */
export interface SignInput {
  method: string
  /** Full URL, including any query string. */
  url: string
  body: Buffer | string
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
  /** `YYYYMMDDTHHMMSSZ`. Passed in rather than read from the clock so tests can pin it. */
  amzDate: string
  sessionToken?: string
  /**
   * Sign `x-amz-content-sha256`. S3 requires it (its signature covers the body
   * hash); other services may not have the header at all.
   */
  signContentSha256?: boolean
  /** Extra headers the caller set that must be part of the signed set. */
  extraHeaders?: Record<string, string>
}

export interface SignedRequest {
  url: string
  headers: Record<string, string>
  /** The canonical request, kept for the "why is this 403" case. */
  canonicalRequest: string
  stringToSign: string
  signature: string
  contentSha256: string
  authorization: string
}

export const EMPTY_PAYLOAD_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * RFC 3986 encoding: everything except unreserved characters.
 *
 * `encodeURIComponent` leaves `!'()*` alone, which SigV4 does not: those must be
 * percent-encoded or the canonical request differs from the server's.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/** The path, encoded per segment. `/` stays a separator. */
function canonicalPath(pathname: string): string {
  if (!pathname) return '/'
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponentSafe(segment)))
    .join('/')
}

/**
 * Decode what we can, and leave alone what we cannot.
 *
 * A key that already contains a `%` which is not an escape (`a%zz`) would throw
 * in `decodeURIComponent`; the honest canonical form for that is the raw text
 * encoded once, not a crash.
 */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Query parameters sorted by name, then by value, with both encoded. */
function canonicalQuery(search: string): string {
  if (!search || search === '?') return ''
  const params: Array<[string, string]> = []
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (pair === '') continue
    const at = pair.indexOf('=')
    const name = at < 0 ? pair : pair.slice(0, at)
    const value = at < 0 ? '' : pair.slice(at + 1)
    params.push([decodeURIComponentSafe(name), decodeURIComponentSafe(value)])
  }
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return params.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join('&')
}

/** Trim, and collapse internal runs of whitespace, as the spec requires. */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/** `YYYYMMDD` out of `YYYYMMDDTHHMMSSZ`. */
function dateStamp(amzDate: string): string {
  return amzDate.slice(0, 8)
}

export function signRequest(input: SignInput): SignedRequest {
  const url = new URL(input.url)
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body
  const contentSha256 = createHash('sha256').update(body).digest('hex')

  const headers: Record<string, string> = {
    ...(input.extraHeaders ?? {}),
    // A default port is not part of the Host header the server sees.
    host: url.host.replace(/:443$/, '').replace(/:80$/, ''),
    'x-amz-date': input.amzDate
  }
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken
  if (input.signContentSha256) headers['x-amz-content-sha256'] = contentSha256

  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${canonicalHeaderValue(headers[name] ?? headers[toOriginalKey(headers, name)] ?? '')}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    contentSha256
  ].join('\n')

  const scope = `${dateStamp(input.amzDate)}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n')

  const signature = hmac(signingKey(input.secretAccessKey, scope), stringToSign).toString('hex')
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: input.url,
    headers: { ...headers, Authorization: authorization },
    canonicalRequest,
    stringToSign,
    signature,
    contentSha256,
    authorization
  }
}

/** `headers` is keyed case-sensitively; the canonical form only knows lower case. */
function toOriginalKey(headers: Record<string, string>, lower: string): string {
  return Object.keys(headers).find((key) => key.toLowerCase() === lower) ?? lower
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/** The four-step key derivation from the spec. */
export function signingKey(secretAccessKey: string, scope: string): Buffer {
  const [date, region, service] = scope.split('/')
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}
