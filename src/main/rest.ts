import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

import type { RestHeader, RestRequest, RestResponse } from '@shared/types'

/** How long one hop may take before it is called a failure. */
const TIMEOUT_MS = 15_000
/** Enough for any JSON answer a person is going to read in a pane. */
const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5

interface Hop {
  status: number
  statusText: string
  headers: RestHeader[]
  body: string
  size: number
  truncated: boolean
  location?: string
}

function headerPairs(raw: IncomingMessage['headers']): RestHeader[] {
  const out: RestHeader[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out.push({ name, value: Array.isArray(value) ? value.join(', ') : String(value) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** One request, no redirect following. */
function once(url: URL, req: RestRequest): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const sender = url.protocol === 'https:' ? httpsRequest : httpRequest
    const body = req.body ?? ''
    const headers: Record<string, string> = {}
    for (const header of req.headers ?? []) {
      if (!header.name.trim()) continue
      headers[header.name.trim()] = header.value
    }
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }

    const request = sender(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false

        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) {
            // Stop reading rather than buffering a download into memory: this
            // tool is for looking at JSON, not for fetching a disk image.
            if (!truncated) chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - MAX_BYTES))))
            truncated = true
            response.destroy()
            return
          }
          chunks.push(chunk)
        })

        const finish = (): void => {
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            headers: headerPairs(response.headers),
            body: Buffer.concat(chunks).toString('utf8'),
            size,
            truncated,
            location: typeof response.headers.location === 'string' ? response.headers.location : undefined
          })
        }
        response.on('end', finish)
        // `destroy()` after a truncation emits `close`, not `end`.
        response.on('close', finish)
      }
    )

    request.setTimeout(TIMEOUT_MS, () => {
      request.destroy(new Error(`No answer within ${TIMEOUT_MS / 1000}s.`))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

/**
 * Send one HTTP request from the main process.
 *
 * It has to live here and not in the page: the renderer is loaded from
 * `file://`, so a `fetch` from it is subject to CORS — which is exactly the
 * thing that makes a "call my local service" tool useless, since those services
 * rarely send `Access-Control-Allow-Origin`. Going through main also keeps the
 * same rule as every other connection in the app: the renderer never talks to
 * the network itself.
 *
 * Redirects are followed (a REST tool that reports a 301 as the result is not
 * doing its job), but only a handful, and 303 — plus 301/302 from anything but
 * GET/HEAD — drop the body and become a GET, the way a browser does.
 */
export async function sendRestRequest(input: RestRequest): Promise<RestResponse> {
  const started = Date.now()
  let url: URL
  try {
    url = new URL(String(input.url ?? '').trim())
  } catch {
    return {
      ok: false,
      error: 'That is not a URL. Include the scheme, for example http://127.0.0.1:8080/health',
      durationMs: 0,
      size: 0
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// URLs can be sent.', durationMs: 0, size: 0 }
  }

  let method = input.method
  let body = input.body ?? ''
  let target = url

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await once(target, { ...input, method, body })
      const isRedirect =
        (result.status === 301 || result.status === 302 || result.status === 303 ||
          result.status === 307 || result.status === 308) && !!result.location

      if (isRedirect && hop < MAX_REDIRECTS) {
        const next = new URL(result.location as string, target)
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET'
          body = ''
        }
        target = next
        continue
      }

      return {
        ok: true,
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.truncated
          ? `${result.body}\n\n[truncated at ${Math.round(MAX_BYTES / 1024)} KB]`
          : result.body,
        durationMs: Date.now() - started,
        size: result.size,
        finalUrl: target.toString()
      }
    }
    return { ok: false, error: 'Too many redirects.', durationMs: Date.now() - started, size: 0 }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      size: 0
    }
  }
}
