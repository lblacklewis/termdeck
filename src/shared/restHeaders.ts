/**
 * Reading request headers out of one text box.
 *
 * Two shapes people actually paste: a JSON object, and the lines of a `curl -H`
 * block. A third shape shows up just as often and used to be rejected outright —
 * a JavaScript / Python object literal, `{'Content-Type': 'application/json'}`,
 * which is what a console or a dict prints and is not JSON at all.
 *
 * Forgiving about those shapes, strict about everything else: a typo must not
 * quietly turn into a request that is missing the header somebody meant to
 * authenticate with. Single quotes are *translated* and the result still has to
 * survive a real `JSON.parse`, so `{ 'X-Broken': }` stays an error rather than
 * becoming a header named `{ 'X-Broken'`.
 *
 * Pure, so a probe can assert every shape with injected text.
 */
import type { RestHeader } from './types'

/** Why headers typed as JSON could not be used, as a code the page can translate. */
export type HeaderJsonProblem =
  | { code: 'not-json' }
  | { code: 'not-object' }
  | { code: 'bad-value'; detail: string }
  | { code: 'bad-line'; detail: string }

/**
 * Translate an object literal's single quotes into JSON ones.
 *
 * Double-quoted stretches are copied byte for byte, which is what keeps an
 * apostrophe inside a value — `{"note": "it's fine"}` — from opening a string.
 * Inside a single-quoted stretch the two characters that change meaning are
 * handled: `\'` loses its escape (JSON needs none for an apostrophe) and a `"`
 * gains one (it would otherwise end the JSON string early). Everything else is
 * left alone, escapes included, so `JSON.parse` remains the judge.
 */
export function requoteSingleQuoted(text: string): string {
  let out = ''
  let inDouble = false
  let inSingle = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inDouble) {
      out += char
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1]
        index += 1
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (char === '\\' && index + 1 < text.length) {
        const next = text[index + 1]
        if (next === "'") {
          out += "'"
          index += 1
          continue
        }
        out += char + next
        index += 1
        continue
      }
      if (char === "'") {
        out += '"'
        inSingle = false
        continue
      }
      if (char === '"') {
        out += '\\"'
        continue
      }
      out += char
      continue
    }
    if (char === '"') {
      inDouble = true
      out += char
      continue
    }
    if (char === "'") {
      inSingle = true
      out += '"'
      continue
    }
    out += char
  }
  return out
}

export function parseHeadersJson(
  text: string
): { ok: true; headers: RestHeader[] } | { ok: false; problem: HeaderJsonProblem } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, headers: [] }

  let parsed: unknown
  let read = true
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    read = false
  }

  if (!read) {
    /*
     * A JS-style literal, which is the shape copying out of a console or Python
     * gives you. Only the quoting is translated here; the text then has to parse
     * as real JSON, so this widens what is accepted without loosening what is
     * refused.
     */
    const requoted = requoteSingleQuoted(trimmed)
    if (requoted !== trimmed) {
      try {
        parsed = JSON.parse(requoted)
        read = true
      } catch {
        read = false
      }
    }
  }

  if (!read) {
    /*
     * A `curl -H` block is line-based, so it is not JSON at all: try it before refusing —
     * but only for text that is not clearly an attempt at JSON. Otherwise a typo like
     * `{ "X-Broken": }` would be read as a header named `{ "X-Broken"`, which is exactly
     * the silent misreading this function exists to prevent.
     */
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { ok: false, problem: { code: 'not-json' } }
    }
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
    const headers: RestHeader[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].replace(/,$/, '').replace(/^['"]|['"]$/g, '')
      const at = line.indexOf(':')
      // A header name is a token: no spaces, no braces, no quotes.
      if (at <= 0 || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(line.slice(0, at).trim())) {
        return { ok: false, problem: { code: 'bad-line', detail: line } }
      }
      headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() })
    }
    return { ok: true, headers }
  }

  if (Array.isArray(parsed)) {
    const headers: RestHeader[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'string') return { ok: false, problem: { code: 'not-object' } }
      const at = entry.indexOf(':')
      if (at <= 0) return { ok: false, problem: { code: 'bad-line', detail: entry } }
      headers.push({ name: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() })
    }
    return { ok: true, headers }
  }

  if (!parsed || typeof parsed !== 'object') return { ok: false, problem: { code: 'not-object' } }

  const headers: RestHeader[] = []
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      headers.push({ name, value: '' })
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      headers.push({ name, value: String(value) })
      continue
    }
    if (Array.isArray(value) && value.every((item) => typeof item !== 'object')) {
      headers.push({ name, value: value.map((item) => String(item)).join(', ') })
      continue
    }
    return { ok: false, problem: { code: 'bad-value', detail: name } }
  }
  return { ok: true, headers }
}

/**
 * The JSON text that stands for a header list.
 *
 * Used for both jobs the two editors need: seeding the JSON box from the rows,
 * and deciding whether the rows have moved since the box was last read. Rows
 * with no name yet are not headers and are left out, so a half-typed row does
 * not look like a change worth rewriting the box for.
 */
export function headersJsonOf(headers: RestHeader[]): string {
  return JSON.stringify(
    Object.fromEntries(
      headers.filter((header) => header.name.trim()).map((header) => [header.name, header.value])
    ),
    null,
    2
  )
}
