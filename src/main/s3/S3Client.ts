import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream'
import { URL } from 'node:url'

import { EMPTY_PAYLOAD_HASH, signRequest } from './sigv4'

export interface S3Config {
  /** Base endpoint, e.g. `https://s3.amazonaws.com` or `http://127.0.0.1:9000`. */
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /**
   * `bucket.endpoint/key` (AWS) or `endpoint/bucket/key` (MinIO, Ceph, most
   * gateways). The gateway style is also the one that works with an IP address,
   * where a wildcard certificate cannot match a bucket subdomain.
   */
  pathStyle: boolean
}

export interface S3Bucket {
  name: string
  createdAt: string
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
  storageClass?: string
}

export interface ListObjectsResult {
  bucket: string
  prefix: string
  objects: S3Object[]
  /** "Directories" when a delimiter was used. */
  prefixes: string[]
  truncated: boolean
  nextToken?: string
  raw: string
}

export interface S3ListOptions {
  prefix?: string
  delimiter?: string
  maxKeys?: number
  continuationToken?: string
}

/** Raised for a response that is not 2xx, carrying what S3 said about it. */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'S3Error'
  }
}

/**
 * The smallest useful S3 client.
 *
 * Deliberately not the AWS SDK: the app ships ~2 MB of renderer and a terminal,
 * and pulling in the whole SDK (plus its credential chain, retries and middleware
 * stack) to list a bucket would double the download. What is needed is four
 * verbs, one signature and an XML reader for the handful of fields the UI shows.
 */
export class S3Client {
  constructor(private readonly config: S3Config) {}

  private base(): URL {
    const url = new URL(this.config.endpoint)
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
    return url
  }

  /**
   * Build the URL for an operation.
   *
   * Path-style puts the bucket in the path; virtual-hosted puts it in the host,
   * and is the only form that works against real AWS without a redirect.
   */
  private urlFor(bucket: string | null, key = '', query?: Record<string, string>): string {
    const base = this.base()
    let host = base.host
    let path = base.pathname
    if (bucket) {
      if (this.config.pathStyle) {
        /*
         * No trailing slash for a bucket-level call: `GET /bucket?list-type=2`
         * is what S3 documents, and `GET /bucket/` is a *different* canonical
         * path — strict gateways (MinIO among them) answer the second with a
         * signature mismatch rather than a redirect.
         */
        path += key ? `${bucket}/` : bucket
      } else {
        host = `${bucket}.${base.host}`
      }
      if (key) path += key
    }
    const url = new URL(`${base.protocol}//${host}${path}`)
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)
    return url.toString()
  }

  /**
   * One request, with the body either in memory or streaming.
   *
   * The signature covers the *hash* of the body, never the bytes, so a file can
   * be sent without ever being held whole: the digest is computed in a first pass
   * and the bytes go out in a second. That is two reads of the file and constant
   * memory, which is the right trade for uploads that may be gigabytes.
   */
  private async send(
    method: string,
    url: string,
    body: Buffer | { stream: Readable; size: number; sha256: string },
    extraHeaders: Record<string, string> = {}
  ): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
    const streaming = !Buffer.isBuffer(body)
    const contentLength = streaming ? body.size : body.length
    const now = new Date()
    const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
    const signed = signRequest({
      method,
      url,
      // The bytes are not needed for signing when the digest is supplied.
      body: Buffer.alloc(0),
      payloadSha256: streaming
        ? body.sha256
        : createHash('sha256').update(body as Buffer).digest('hex'),
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      service: 's3',
      amzDate,
      sessionToken: this.config.sessionToken,
      // S3 requires the body hash in the signed set; without it AWS rejects the
      // request and some gateways compute a different canonical request.
      signContentSha256: true,
      extraHeaders
    })

    const target = new URL(url)
    const result = await new Promise<{
      status: number
      headers: IncomingMessage['headers']
      body: string
    }>((resolve, reject) => {
      const sender = target.protocol === 'https:' ? httpsRequest : httpRequest
      const request = sender(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method,
          headers: {
            ...signed.headers,
            ...Object.fromEntries(
              Object.entries(extraHeaders).map(([name, value]) => [name, value])
            ),
            ...(contentLength > 0 ? { 'Content-Length': String(contentLength) } : {})
          }
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          const finish = (): void =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          response.on('end', finish)
          response.on('close', finish)
        }
      )
      request.setTimeout(30_000, () => request.destroy(new Error('S3 did not answer within 30s.')))
      request.on('error', reject)
      if (streaming) {
        const source = (body as { stream: Readable }).stream
        source.on('error', reject)
        source.pipe(request)
      } else {
        request.write(body as Buffer)
        request.end()
      }
    })

    if (result.status >= 200 && result.status < 300) return result
    throw new S3Error(
      result.status,
      firstTag(result.body, 'Code') ?? 'HTTP_' + result.status,
      firstTag(result.body, 'Message') ?? result.body.slice(0, 300) ?? 'S3 refused the request.'
    )
  }

  async listBuckets(): Promise<S3Bucket[]> {
    const raw = (await this.send('GET', this.urlFor(null), Buffer.alloc(0))).body
    return blocks(raw, 'Bucket').map((block) => ({
      name: firstTag(block, 'Name') ?? '',
      createdAt: firstTag(block, 'CreationDate') ?? ''
    }))
  }

  async listObjects(bucket: string, options: S3ListOptions = {}): Promise<ListObjectsResult> {
    const query: Record<string, string> = { 'list-type': '2' }
    if (options.prefix) query['prefix'] = options.prefix
    if (options.delimiter) query['delimiter'] = options.delimiter
    if (options.maxKeys) query['max-keys'] = String(options.maxKeys)
    if (options.continuationToken) query['continuation-token'] = options.continuationToken

    const raw = (await this.send('GET', this.urlFor(bucket, '', query), Buffer.alloc(0))).body
    return {
      bucket,
      prefix: options.prefix ?? '',
      objects: blocks(raw, 'Contents').map((block) => ({
        key: firstTag(block, 'Key') ?? '',
        size: Number(firstTag(block, 'Size') ?? '0'),
        lastModified: firstTag(block, 'LastModified') ?? '',
        storageClass: firstTag(block, 'StorageClass') ?? undefined
      })),
      prefixes: blocks(raw, 'CommonPrefixes')
        .map((block) => firstTag(block, 'Prefix') ?? '')
        .filter(Boolean),
      truncated: (firstTag(raw, 'IsTruncated') ?? 'false') === 'true',
      nextToken: firstTag(raw, 'NextContinuationToken') ?? undefined,
      raw
    }
  }

  /** Object contents as text; binary keys are the caller's problem, not ours. */
  async getObject(
    bucket: string,
    key: string,
    options: { range?: string; maxBytes?: number } = {}
  ): Promise<{ body: string; contentType?: string; size: number; truncated: boolean }> {
    const headers: Record<string, string> = {}
    if (options.range) headers['Range'] = options.range
    const limit = options.maxBytes ?? 1024 * 1024
    const response = await this.send('GET', this.urlFor(bucket, key), Buffer.alloc(0), headers)
    const bytes = Buffer.from(response.body, 'utf8')
    return {
      body: response.body.slice(0, limit),
      contentType: response.headers['content-type'],
      size: bytes.length,
      truncated: bytes.length > limit
    }
  }

  async putObject(bucket: string, key: string, body: string, contentType?: string): Promise<void> {
    const headers: Record<string, string> = {}
    if (contentType) headers['Content-Type'] = contentType
    await this.send('PUT', this.urlFor(bucket, key), Buffer.from(body, 'utf8'), headers)
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.send('DELETE', this.urlFor(bucket, key), Buffer.alloc(0))
  }

  /** Send a local file as an object, without holding it in memory. */
  async putObjectFile(
    bucket: string,
    key: string,
    localPath: string,
    contentType?: string
  ): Promise<{ bytes: number }> {
    const { sha256, size } = await hashFile(localPath)
    const headers: Record<string, string> = {}
    if (contentType) headers['Content-Type'] = contentType
    await this.send(
      'PUT',
      this.urlFor(bucket, key),
      { stream: createReadStream(localPath), size, sha256 },
      headers
    )
    return { bytes: size }
  }

  /**
   * Write an object straight to a file.
   *
   * Separate from `getObject` on purpose: that one is for *looking* at an object
   * and caps the read so a mistaken click cannot pull a disk image into memory.
   * This one is for saving it, so it streams and has no cap.
   */
  async getObjectToFile(
    bucket: string,
    key: string,
    localPath: string
  ): Promise<{ bytes: number }> {
    const url = this.urlFor(bucket, key)
    const now = new Date()
    const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
    const signed = signRequest({
      method: 'GET',
      url,
      body: Buffer.alloc(0),
      payloadSha256: EMPTY_PAYLOAD_HASH,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      service: 's3',
      amzDate,
      sessionToken: this.config.sessionToken,
      signContentSha256: true
    })
    const target = new URL(url)

    return new Promise<{ bytes: number }>((resolve, reject) => {
      const sender = target.protocol === 'https:' ? httpsRequest : httpRequest
      const request = sender(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers: signed.headers
        },
        (response) => {
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300) {
            // An error body is small and worth reading: it says what went wrong.
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              reject(
                new S3Error(
                  status,
                  firstTag(text, 'Code') ?? 'HTTP_' + status,
                  firstTag(text, 'Message') ?? 'S3 refused the request.'
                )
              )
            })
            return
          }
          let bytes = 0
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
          })
          pipeline(response, createWriteStream(localPath), (err) => {
            if (err) reject(err)
            else resolve({ bytes })
          })
        }
      )
      request.setTimeout(60_000, () => request.destroy(new Error('S3 did not answer within 60s.')))
      request.on('error', reject)
      request.end()
    })
  }
}

/** SHA-256 and size of a file, read once and never held whole. */
function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let size = 0
    const stream = createReadStream(path)
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }))
    stream.on('error', reject)
  })
}

// ---- a very small XML reader ---------------------------------------------
//
// S3 answers with a fixed shape and no namespaces, so the handful of fields this
// tool shows can be read with string work. A real parser (or the SDK) would be
// more general and far more code than the whole feature.

/** Inner text of the first `<tag>`; null when the tag is absent. */
export function firstTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match ? match[1].trim() : null
}

/** Inner XML of every `<tag>…</tag>`, for the repeated list entries. */
export function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) out.push(match[1])
  return out
}
