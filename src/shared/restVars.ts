/**
 * `{{name}}` in a request, resolved against the active environment.
 *
 * The point of the feature is that one request runs against local, staging and
 * production without being edited, so substitution happens at *send* time and never
 * touches what the user typed: the URL bar keeps saying `{{base}}/pets` while the wire
 * carries `http://127.0.0.1:4523/pets`.
 *
 * A name the active environment does not define is left in the text and reported. Both
 * halves matter: leaving it visible is how the user sees which name is wrong, and
 * reporting it is how the page refuses to send a request whose URL still has braces in
 * it — a literal `{{host}}` on the wire produces a confusing 404 instead of "you have
 * not defined host".
 */
import type { RestEnvironment, RestVariable } from './types'

/** `{{name}}`, tolerating spaces inside the braces. Dots and dashes are allowed. */
const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** Every name a piece of text refers to, in order, without duplicates. */
export function varsUsed(text: string): string[] {
  const out: string[] = []
  TOKEN.lastIndex = 0
  let hit = TOKEN.exec(text)
  while (hit) {
    if (!out.includes(hit[1])) out.push(hit[1])
    hit = TOKEN.exec(text)
  }
  return out
}

/** Does this text refer to any variable at all? */
export function usesVars(text: string): boolean {
  TOKEN.lastIndex = 0
  return TOKEN.test(text)
}

/**
 * The names an environment defines, enabled ones only.
 *
 * A disabled variable is a variable the user has switched off, so it counts as
 * undefined — that is what makes the switch useful for trying a request without a token.
 */
export function environmentVars(environment: RestEnvironment | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const variable of environment?.variables ?? []) {
    if (!variable.enabled) continue
    const name = variable.name.trim()
    if (name === '') continue
    out[name] = variable.value
  }
  return out
}

export interface Substitution {
  /** The text with every defined name replaced. */
  text: string
  /** Names it refers to that the environment does not define (or has disabled). */
  missing: string[]
}

/** Replace every defined name; report the ones that are not. */
export function substituteVars(
  text: string,
  vars: Record<string, string>
): Substitution {
  const missing: string[] = []
  const out = text.replace(TOKEN, (whole, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })
  return { text: out, missing }
}

/** Variables as the store keeps them, with anything unusable dropped. */
export function normaliseVariables(input: unknown): RestVariable[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((row): row is Partial<RestVariable> => !!row && typeof row === 'object')
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      value: typeof row.value === 'string' ? row.value : '',
      enabled: row.enabled !== false
    }))
    .filter((row) => row.name.trim() !== '')
}
