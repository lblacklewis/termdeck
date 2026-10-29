/**
 * Cookies out of a response, for the Cookie tab.
 *
 * A `set-cookie` header is `name=value; Attribute; Attribute=Value`, and a response can
 * carry several of them. This is a reader, not a cookie jar: nothing here is stored,
 * sent back, or kept between requests — it exists so that "the server set a session
 * cookie, what is in it" can be answered without scrolling a wall of headers.
 *
 * Attribute splitting is on `;` only. A value is allowed to contain `=`, commas and
 * spaces, so the split is on the first `=` for name/value and never on `,`.
 */
import type { RestHeader } from './types'

export interface RestCookie {
  name: string
  value: string
  /** Attributes as written, e.g. `Path=/`, `HttpOnly`, `Max-Age=3600`. */
  attributes: string[]
}

/** Every cookie a response set, in the order the headers arrived. */
export function cookiesFrom(headers: RestHeader[] | undefined): RestCookie[] {
  const out: RestCookie[] = []
  for (const header of headers ?? []) {
    if (header.name.trim().toLowerCase() !== 'set-cookie') continue
    // One header, one cookie — but stay tolerant if a proxy joined two anyway: a new
    // cookie starts only at a `; `-separated piece that looks like `name=value` after a
    // previously seen cookie's attributes, which is not something this can tell apart.
    // Rather than guess, the whole value is treated as one cookie.
    const pieces = header.value.split(';')
    const first = pieces[0] ?? ''
    const cut = first.indexOf('=')
    const name = (cut < 0 ? first : first.slice(0, cut)).trim()
    if (name === '') continue
    out.push({
      name,
      value: cut < 0 ? '' : first.slice(cut + 1).trim(),
      attributes: pieces
        .slice(1)
        .map((piece) => piece.trim())
        .filter((piece) => piece !== '')
    })
  }
  return out
}
