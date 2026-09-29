/**
 * Encrypted storage for session credentials.
 *
 * There is no master password: the key is derived at runtime so the feature
 * needs no unlock step, while the file on disk stays unreadable.
 *
 * Key material comes from Electron's `safeStorage`, which is backed by the OS
 * keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux). When the
 * platform cannot provide it, a random 32-byte seed file is used instead — that
 * still protects against casual reading of `credentials.json`, but not against
 * an attacker who already has read access to the profile directory. The Settings
 * UI surfaces which of the two is in use.
 *
 * Payload format: AES-256-GCM, one ciphertext per field.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { CredentialStatus } from '@shared/types'

const IV_LEN = 12
const SEED_LEN = 32

interface SealedValue {
  iv: string
  tag: string
  data: string
}

interface CredentialRecord {
  /** Encrypted password. */
  password?: SealedValue
  /** Encrypted private-key passphrase. */
  passphrase?: SealedValue
  updatedAt: number
}

interface CredentialFile {
  v: 1
  entries: Record<string, CredentialRecord>
}

/** A session's credentials as used by the connect path. */
export interface SessionCredential {
  password?: string
  passphrase?: string
}

export class CredentialStore {
  private readonly filePath: string
  private readonly seedPath: string
  private key: Buffer | null = null
  private entries: Record<string, CredentialRecord> = {}

  constructor(configDir: string) {
    this.filePath = join(configDir, 'credentials.json')
    this.seedPath = join(configDir, '.credential-seed')
    this.load()
  }

  // ---- key management ---------------------------------------------------

  private deriveKey(): Buffer {
    // Preferred: OS-protected encryption of a random seed.
    if (safeStorage.isEncryptionAvailable()) {
      const encryptedSeedPath = `${this.seedPath}.os`
      if (!existsSync(encryptedSeedPath)) {
        this.writeSeedFile(encryptedSeedPath, safeStorage.encryptString(randomBytes(SEED_LEN).toString('base64')))
      }
      try {
        const seed = safeStorage.decryptString(readFileSync(encryptedSeedPath))
        return createHash('sha256').update(`os:${seed}`).digest()
      } catch {
        // A profile moved between machines cannot be decrypted; fall through and
        // regenerate rather than refusing to start.
        this.writeSeedFile(encryptedSeedPath, safeStorage.encryptString(randomBytes(SEED_LEN).toString('base64')))
        const seed = safeStorage.decryptString(readFileSync(encryptedSeedPath))
        return createHash('sha256').update(`os:${seed}`).digest()
      }
    }

    // Fallback: a local seed with owner-only permissions.
    if (!existsSync(this.seedPath)) {
      this.writeSeedFile(this.seedPath, randomBytes(SEED_LEN))
    }
    return createHash('sha256').update(`local:${readFileSync(this.seedPath).toString('base64')}`).digest()
  }

  private writeSeedFile(path: string, contents: Buffer): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows ignores POSIX modes; best effort only.
    }
  }

  private ensureKey(): Buffer {
    this.key ??= this.deriveKey()
    return this.key
  }

  // ---- persistence ------------------------------------------------------

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.entries = {}
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as CredentialFile
      this.entries = parsed?.v === 1 && parsed.entries ? parsed.entries : {}
    } catch {
      // A corrupt file must not stop the app; it will be rewritten on next save.
      this.entries = {}
    }
  }

  private persist(): void {
    const payload: CredentialFile = { v: 1, entries: this.entries }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(tmp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort on Windows.
    }
  }

  private seal(plaintext: string): SealedValue {
    const iv = randomBytes(IV_LEN)
    const cipher = createCipheriv('aes-256-gcm', this.ensureKey(), iv)
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    }
  }

  private open(sealed: SealedValue | undefined): string | undefined {
    if (!sealed) return undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.ensureKey(), Buffer.from(sealed.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.data, 'base64')),
        decipher.final()
      ]).toString('utf8')
    } catch {
      // Wrong key (e.g. restored profile) or tampering: treat as absent.
      return undefined
    }
  }

  // ---- public API -------------------------------------------------------

  /**
   * Store credentials for a session.
   *
   * Merge semantics: a key that is absent keeps its stored value, while an
   * empty string clears that field. Callers can therefore update just the
   * password without having to know the passphrase, and a partial update can
   * never silently drop the other secret.
   */
  set(sessionId: string, credential: SessionCredential): void {
    const existing = this.entries[sessionId]
    const record: CredentialRecord = { updatedAt: Date.now() }

    const nextPassword =
      credential.password === undefined
        ? existing?.password
        : credential.password === ''
          ? undefined
          : this.seal(credential.password)

    const nextPassphrase =
      credential.passphrase === undefined
        ? existing?.passphrase
        : credential.passphrase === ''
          ? undefined
          : this.seal(credential.passphrase)

    if (nextPassword) record.password = nextPassword
    if (nextPassphrase) record.passphrase = nextPassphrase

    if (!record.password && !record.passphrase) delete this.entries[sessionId]
    else this.entries[sessionId] = record
    this.persist()
  }

  /** Credentials for connecting. Never sent to the renderer. */
  get(sessionId: string): SessionCredential {
    const record = this.entries[sessionId]
    if (!record) return {}
    return {
      password: this.open(record.password),
      passphrase: this.open(record.passphrase)
    }
  }

  has(sessionId: string): { password: boolean; passphrase: boolean } {
    const record = this.entries[sessionId]
    return {
      password: !!record?.password,
      passphrase: !!record?.passphrase
    }
  }

  remove(sessionId: string): void {
    if (!(sessionId in this.entries)) return
    delete this.entries[sessionId]
    this.persist()
  }

  /** Reveal a stored password on explicit request from the session editor. */
  revealPassword(sessionId: string): string | undefined {
    return this.get(sessionId).password
  }

  /** Drop the whole store, e.g. when the user clears saved credentials. */
  clear(): void {
    this.entries = {}
    this.persist()
  }

  count(): number {
    return Object.keys(this.entries).length
  }

  status(): CredentialStatus {
    const usingOs = safeStorage.isEncryptionAvailable()
    return {
      backend: usingOs ? 'os' : 'local',
      detail: usingOs
        ? 'Credentials are encrypted with AES-256-GCM. The key is protected by the ' +
          'operating system keychain, so no master password is needed.'
        : 'Credentials are encrypted with AES-256-GCM using a local key file. ' +
          'On this system no OS keychain is available, so the key sits next to the ' +
          'data — this protects against casual reading, not against full disk access.',
      encrypted: true,
      sessionCount: this.count(),
      credentialCount: this.count()
    }
  }
}
