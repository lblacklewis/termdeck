/**
 * OpenSSH `known_hosts` reading, matching and writing.
 *
 * Supports the plain (`host,host keytype base64`) and hashed
 * (`|1|salt|hmac`) hostname formats, bracketed `[host]:port` entries for
 * non-default ports, and negation/wildcard patterns.
 *
 * Note: entries are matched and stored verbatim so the file stays usable by the
 * system `ssh` client. New entries are hashed when `hashNewHosts` is set, which
 * mirrors OpenSSH's `HashKnownHosts yes`.
 */
import { createHmac, createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { HostKeyPrompt, KnownHostEntry } from '@shared/types'

export interface HostKeyRecord {
  /** Raw host-pattern field from the file, e.g. `example.com` or `|1|...`. */
  hostsField: string
  keyType: string
  /** base64 key blob. */
  keyData: string
  marker?: string
  line: number
  /** File this record was read from. */
  path: string
}

export interface HostKeyVerdict {
  status: 'trusted' | 'unknown' | 'mismatch' | 'revoked'
  prompt: HostKeyPrompt
}

/**
 * OpenSSH's SHA256 fingerprint: base64url (unpadded) of the SHA-256 over the
 * canonical `keytype SP base64(blob)` string - the same bytes that appear in
 * known_hosts. Hashing only the raw key material yields a different value, so
 * normalisation must happen first.
 */
export function fingerprintFor(canonical: string): string {
  const digest = createHash('sha256').update(canonical, 'utf8').digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

/** Fingerprint of a `keytype base64` pair or an OpenSSH blob. */
export function fingerprint(key: Buffer | string): string {
  const { keyType, keyData } = parseHostKey(key)
  return fingerprintFor(`${keyType} ${keyData}`)
}

/**
 * ssh2 hands the verifier the OpenSSH wire-format blob (length-prefixed type and
 * key), while the textual form is `keytype base64`. Both are normalised here to
 * the `keytype base64` pair used by known_hosts and by OpenSSH fingerprints.
 */
export function parseHostKey(key: Buffer | string): { keyType: string; keyData: string } {
  const KEY_TYPES = /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+|rsa-sha2-\S+)/

  if (!Buffer.isBuffer(key)) {
    const parts = key.trim().split(/\s+/)
    if (parts.length >= 2 && KEY_TYPES.test(parts[0])) {
      return { keyType: parts[0], keyData: parts[1] }
    }
    return { keyType: 'unknown', keyData: key }
  }

  // A textual blob passed as a Buffer.
  const asText = key.toString('utf8')
  if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(asText.slice(0, 4))) {
    const parts = asText.trim().split(/\s+/)
    if (parts.length >= 2 && KEY_TYPES.test(parts[0])) {
      return { keyType: parts[0], keyData: parts[1] }
    }
  }

  // OpenSSH wire format: uint32 len | type | uint32 len | key-material.
  try {
    const typeLen = key.readUInt32BE(0)
    const keyType = key.subarray(4, 4 + typeLen).toString('utf8')
    if (KEY_TYPES.test(keyType)) {
      // Canonical base64 covers the whole blob, matching known_hosts verbatim.
      return { keyType, keyData: key.toString('base64') }
    }
  } catch {
    // Fall through to the opaque form below.
  }

  return { keyType: 'unknown', keyData: key.toString('base64') }
}

/** `[host]:port` for non-default ports, matching OpenSSH's convention. */
export function hostField(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

function hashHostField(host: string, port: number): string {
  const salt = randomBytes(20)
  const mac = createHmac('sha1', salt).update(hostField(host, port)).digest('base64')
  return `|1|${salt.toString('base64')}|${mac}`
}

/** Does a known_hosts pattern list match this host? Handles `!` negation. */
function patternMatches(hostsField: string, host: string, port: number): boolean {
  if (hostsField.startsWith('|1|')) {
    const [, , saltB64, macB64] = hostsField.split('|')
    if (!saltB64 || !macB64) return false
    const mac = createHmac('sha1', Buffer.from(saltB64, 'base64'))
      .update(hostField(host, port))
      .digest('base64')
    return mac === macB64
  }

  const patterns = hostsField.split(',')
  let matched = false

  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw

    // A bracketed pattern carries its own port and only matches that port.
    const bracketed = /^\[(.+)\]:(\d+)$/.exec(pattern)
    const target = bracketed ? (Number(bracketed[2]) === port ? bracketed[1] : null) : host
    if (target === null) continue

    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    )
    if (regex.test(bracketed ? `[${target}]:${port}` : target)) {
      if (negated) return false
      matched = true
    }
  }

  return matched
}

export class KnownHosts {
  private readonly paths: string[]
  private readonly hashNewHosts: boolean

  constructor(options: { paths?: string[]; hashNewHosts?: boolean } = {}) {
    this.paths = options.paths ?? [
      join(homedir(), '.ssh', 'known_hosts'),
      join(homedir(), '.ssh', 'known_hosts2')
    ]
    this.hashNewHosts = options.hashNewHosts ?? true
  }

  get primaryPath(): string {
    return this.paths[0]
  }

  /** All entries across the configured files, in file order. */
  read(): HostKeyRecord[] {
    const records: HostKeyRecord[] = []

    for (const path of this.paths) {
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf8').split(/\r?\n/)

      lines.forEach((raw, index) => {
        const line = raw.trim()
        if (!line || line.startsWith('#')) return

        const parts = line.split(/\s+/)
        let marker: string | undefined
        if (parts[0]?.startsWith('@')) marker = parts.shift()

        const [hostsField, keyType, keyData] = parts
        if (!hostsField || !keyType || !keyData) return
        records.push({ hostsField, keyType, keyData, marker, line: index + 1, path })
      })
    }

    return records
  }

  /**
   * Entries shaped for the Known Hosts page.
   *
   * Hashed entries cannot be attributed to a hostname — OpenSSH stores them as
   * `|1|salt|hmac` precisely so they cannot be read back — so `host` is null and
   * the UI says so rather than inventing a name.
   */
  list(): KnownHostEntry[] {
    return this.read().map((record) => ({
      host: record.hostsField.startsWith('|1|') ? null : record.hostsField,
      keyType: record.keyType,
      fingerprint: fingerprintFor(`${record.keyType} ${record.keyData}`),
      marker: record.marker,
      hashed: record.hostsField.startsWith('|1|'),
      file: record.path,
      line: record.line
    }))
  }

  /**
   * Delete one entry by file and line.
   *
   * Line-addressed rather than host-addressed because a hashed entry has no
   * recoverable hostname to match on.
   */
  removeAt(path: string, line: number): boolean {
    if (!existsSync(path)) return false
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    const index = line - 1
    if (index < 0 || index >= lines.length) return false

    const target = lines[index]
    const trimmed = target.trim()
    if (!trimmed || trimmed.startsWith('#')) return false

    lines.splice(index, 1)
    writeFileSync(path, lines.join('\n'), { mode: 0o600 })
    return true
  }

  /** Entries that match this host, ignoring key type. */
  find(host: string, port: number): HostKeyRecord[] {
    return this.read().filter((r) => patternMatches(r.hostsField, host, port))
  }

  /**
   * Decide whether a presented host key may be used.
   *
   * `revoked` and `mismatch` are hard failures; `unknown` means the caller must
   * ask the user (or fail, under a strict policy).
   */
  verify(host: string, port: number, presented: Buffer | string): HostKeyVerdict {
    const { keyType, keyData } = parseHostKey(presented)
    const canonical = `${keyType} ${keyData}`
    const fp = fingerprintFor(canonical)
    const matches = this.find(host, port)

    // `keyData` rides along so an approving UI can persist exactly what was shown.
    const prompt: HostKeyPrompt = {
      host,
      port,
      keyType,
      keyData,
      fingerprint: fp,
      mismatch: false
    }

    if (matches.length === 0) {
      return { status: 'unknown', prompt }
    }

    const revoked = matches.find((m) => m.marker === '@revoked')
    if (revoked) {
      prompt.previousFingerprint = fingerprintFor(`${revoked.keyType} ${revoked.keyData}`)
      return { status: 'revoked', prompt }
    }

    const trusted = matches.find((m) => m.keyType === keyType && m.keyData === keyData)
    if (trusted) return { status: 'trusted', prompt }

    // A different key is already on file for this host: never auto-accept.
    prompt.previousFingerprint = fingerprintFor(`${matches[0].keyType} ${matches[0].keyData}`)
    prompt.mismatch = true
    return { status: 'mismatch', prompt }
  }

  /**
   * Record a host key. When a different key is already present for the host the
   * old line is replaced, so this doubles as "accept the new key".
   */
  trust(host: string, port: number, presented: Buffer | string): void {
    const { keyType, keyData } = parseHostKey(presented)

    // Writing a key we could not classify would leave a junk line that can never
    // match, so the next connection would look like a key change. Fail instead.
    if (keyType === 'unknown' || !keyData) {
      throw new Error(
        `Cannot store an unparseable host key for ${host}:${port} ` +
          `(expected "keytype base64", got ${keyData.length} chars)`
      )
    }

    const field = this.hashNewHosts ? hashHostField(host, port) : hostField(host, port)

    const path = this.primaryPath
    mkdirSync(dirname(path), { recursive: true })

    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const kept = existing
      .split(/\r?\n/)
      .filter((raw) => {
        const line = raw.trim()
        if (!line || line.startsWith('#')) return true

        const parts = line.split(/\s+/)
        if (parts[0]?.startsWith('@')) parts.shift()
        const [hostsField, entryKeyType] = parts
        if (!hostsField) return true

        // Drop any entry that matches this host, regardless of hashing scheme,
        // so a stale key cannot linger and cause a later mismatch.
        const conflicts = patternMatches(hostsField, host, port)
        if (!conflicts) return true
        // Keep entries for other key types; OpenSSH allows several per host.
        return entryKeyType !== keyType
      })
      .join('\n')

    const body = `${field} ${keyType} ${keyData}`
    const next = kept.trim().length > 0 ? `${kept.replace(/\n+$/, '')}\n${body}\n` : `${body}\n`
    writeFileSync(path, next, { mode: 0o600 })
  }

  /** Remove every entry matching this host. */
  forget(host: string, port: number): number {
    let removed = 0
    const path = this.primaryPath
    if (!existsSync(path)) return 0

    const kept = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((raw) => {
        const line = raw.trim()
        if (!line || line.startsWith('#')) return true
        const parts = line.split(/\s+/)
        if (parts[0]?.startsWith('@')) parts.shift()
        const hostsField = parts[0]
        if (hostsField && patternMatches(hostsField, host, port)) {
          removed += 1
          return false
        }
        return true
      })
      .join('\n')

    writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`, { mode: 0o600 })
    return removed
  }
}

/** Append-only helper kept for callers that need the raw file path. */
export function appendRaw(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${line}\n`, { mode: 0o600 })
}

