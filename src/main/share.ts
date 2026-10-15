/**
 * Sharing saved hosts with someone else.
 *
 * One file carries the folders, the sessions and — if the exporter allows it —
 * the stored passwords. It is gzipped and then encrypted under a passphrase both
 * people know: compressed first so no plaintext ever reaches a disk, and encrypted
 * so the file can travel through mail or a chat app without handing over the fleet.
 *
 * The container is deliberately self-describing — magic, salt, iv, tag, body — so
 * a file from a newer build is rejected with a sentence rather than a crash, and
 * authenticated (AES-GCM) so "wrong passphrase" and "damaged file" cannot be
 * confused with a successful read.
 *
 * Everything here is pure: buffers and data in, buffers and data out. The IPC
 * layer above it owns the file dialogs and the stores.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { SavedSession, SessionFolder, SessionTree } from '../shared/types'
import type { SessionCredential } from './store/CredentialStore'

/** Name and format version of the container, as the first eight bytes. */
export const SHARE_MAGIC = 'TDSHARE1'

/** What the payload calls itself once it is decrypted. */
export const SHARE_FORMAT = 'termdeck-hosts'
export const SHARE_VERSION = 1

/**
 * A passphrase shorter than this is not worth encrypting a fleet with, and the
 * exporter is the only person who can be told so before the file exists.
 */
export const MIN_PASSPHRASE = 8

const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = SHARE_MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES

/**
 * scrypt parameters: 2^15 · r8 · p1 costs roughly 100 ms and 32 MB per attempt,
 * which is slow enough to matter to someone guessing and fast enough that the
 * user does not notice.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }

export type ShareErrorCode = 'BAD_FILE' | 'BAD_PASSPHRASE' | 'BAD_CONTENT' | 'UNSUPPORTED'

export class ShareError extends Error {
  readonly code: ShareErrorCode

  constructor(code: ShareErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ShareError'
  }
}

/** The decrypted contents of a share file. */
export interface ShareDocument {
  format: string
  version: number
  exportedAt: string
  app: string
  folders: SessionFolder[]
  /** As stored, minus ids that the importing machine will re-mint. */
  sessions: SavedSession[]
  /**
   * Secrets, keyed by the *exporting* session id, present only when the exporter
   * chose to include them. They are inside the encrypted body, never beside it.
   */
  credentials: Record<string, SessionCredential>
}

export interface ShareExportOptions {
  includeCredentials: boolean
  app: string
}

/** Build the document for an export from the live tree. */
export function buildShareDocument(
  tree: SessionTree,
  credentialOf: (sessionId: string) => SessionCredential,
  options: ShareExportOptions
): ShareDocument {
  const credentials: Record<string, SessionCredential> = {}
  const sessions = tree.sessions.map((session) => {
    const stored = credentialOf(session.id)
    const hasPassword = !!stored.password
    const hasPassphrase = !!stored.passphrase
    if (options.includeCredentials && (hasPassword || hasPassphrase)) {
      credentials[session.id] = {
        password: stored.password,
        passphrase: stored.passphrase
      }
    }
    /*
     * The flags travel in the clear (well: inside the encrypted body, but outside
     * the credential map) so the import preview can say how many hosts come with a
     * password, whether or not the secrets themselves were included.
     */
    return { ...session, hasPassword, hasPassphrase }
  })

  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    app: options.app,
    folders: tree.folders,
    sessions,
    credentials
  }
}

/** Encrypt and compress a document into the bytes of a share file. */
export function packShare(doc: ShareDocument, passphrase: string): Buffer {
  if (passphrase.trim().length < MIN_PASSPHRASE) {
    throw new ShareError(
      'BAD_PASSPHRASE',
      `Use a passphrase of at least ${MIN_PASSPHRASE} characters — it is the only thing protecting this file.`
    )
  }

  const plain = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 })
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])

  return Buffer.concat([
    Buffer.from(SHARE_MAGIC, 'utf8'),
    salt,
    iv,
    cipher.getAuthTag(),
    body
  ])
}

/** Decrypt and decompress a share file, or explain why it cannot be read. */
export function unpackShare(file: Buffer, passphrase: string): ShareDocument {
  if (file.length < HEADER_BYTES + 1) {
    throw new ShareError('BAD_FILE', 'That file is too short to be a TermDeck share file.')
  }

  const magic = file.subarray(0, SHARE_MAGIC.length).toString('utf8')
  if (magic !== SHARE_MAGIC) {
    throw new ShareError(
      'BAD_FILE',
      'That is not a TermDeck share file (the header does not match).'
    )
  }

  const salt = file.subarray(SHARE_MAGIC.length, SHARE_MAGIC.length + SALT_BYTES)
  const iv = file.subarray(SHARE_MAGIC.length + SALT_BYTES, SHARE_MAGIC.length + SALT_BYTES + IV_BYTES)
  const tag = file.subarray(
    SHARE_MAGIC.length + SALT_BYTES + IV_BYTES,
    HEADER_BYTES
  )
  const body = file.subarray(HEADER_BYTES)

  const key = scryptSync(passphrase, salt, KEY_BYTES, SCRYPT)
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    /*
     * GCM cannot tell a wrong key from a flipped bit, and saying "wrong
     * passphrase" for a file that was actually truncated would send the user off
     * to retype a passphrase that was right.
     */
    throw new ShareError(
      'BAD_PASSPHRASE',
      'Could not decrypt this file: the passphrase is wrong, or the file was damaged in transit.'
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(gunzipSync(plain).toString('utf8'))
  } catch {
    throw new ShareError('BAD_CONTENT', 'The file decrypted, but its contents are not readable.')
  }

  return validateDocument(parsed)
}

/** Check a decrypted payload before anything trusts its shape. */
function validateDocument(parsed: unknown): ShareDocument {
  if (!parsed || typeof parsed !== 'object') {
    throw new ShareError('BAD_CONTENT', 'The file decrypted to something that is not a share document.')
  }
  const doc = parsed as Partial<ShareDocument>

  if (doc.format !== SHARE_FORMAT) {
    throw new ShareError('BAD_CONTENT', `Unknown file contents (format: ${String(doc.format)}).`)
  }
  if (typeof doc.version !== 'number' || doc.version > SHARE_VERSION) {
    throw new ShareError(
      'UNSUPPORTED',
      `This file was written by a newer version of TermDeck (format ${String(doc.version)}).`
    )
  }
  if (!Array.isArray(doc.sessions) || !Array.isArray(doc.folders)) {
    throw new ShareError('BAD_CONTENT', 'The share document is missing its folders or sessions.')
  }

  return {
    format: SHARE_FORMAT,
    version: doc.version,
    exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
    app: typeof doc.app === 'string' ? doc.app : '',
    folders: doc.folders,
    sessions: doc.sessions,
    credentials: doc.credentials && typeof doc.credentials === 'object' ? doc.credentials : {}
  }
}

// ---- merging -------------------------------------------------------------

/**
 * What is already in the tree decides what an import means.
 *
 * Two logins to the same machine are two legitimate sessions, so a host counts as
 * a duplicate only when host *and* username *and* port all match — the same rule
 * the batch form and quick-connect use.
 */
export function sessionKey(session: Pick<SavedSession, 'host' | 'username' | 'port'>): string {
  return `${session.username.toLowerCase()}@${session.host.toLowerCase()}:${session.port ?? 22}`
}

export interface ShareImportOptions {
  /** Where to hang everything that was at the root of the exported tree. */
  folderId?: string | null
  /** Drop the included secrets (the user unticked the box). */
  skipCredentials?: boolean
}

export interface ShareImportPlan {
  folders: Array<{ id: string; name: string; parentId: string | null; color?: string }>
  sessions: Array<Partial<SavedSession> & { id: string; host: string }>
  credentials: Array<{ id: string; password?: string; passphrase?: string }>
  /** Sessions whose host/username/port is already here. */
  duplicates: SavedSession[]
  /** Groups that already existed and are reused rather than duplicated. */
  reusedFolders: string[]
  /** Exported session id → the id it will have here. */
  sessionIdMap: Record<string, string>
}

/**
 * Work out what an import would do, without touching anything.
 *
 * Also used for the preview, so the numbers the dialog shows are the numbers the
 * import produces rather than a second, drifting estimate.
 */
export function planImport(
  doc: ShareDocument,
  current: SessionTree,
  options: ShareImportOptions = {}
): ShareImportPlan {
  const rootTarget = options.folderId ?? null
  const plan: ShareImportPlan = {
    folders: [],
    sessions: [],
    credentials: [],
    duplicates: [],
    reusedFolders: [],
    sessionIdMap: {}
  }

  // Existing groups, by "name under this parent", so re-importing the same file
  // does not build a second copy of the tree.
  const folderKey = (parentId: string | null, name: string): string =>
    `${parentId ?? 'root'}|${name.trim().toLowerCase()}`
  const existingFolders = new Map<string, string>()
  for (const folder of current.folders) {
    existingFolders.set(folderKey(folder.parentId, folder.name), folder.id)
  }

  /*
   * Parents before children. The exporter writes them that way, but a hand-edited
   * or re-ordered file should still import: unresolved folders are retried until
   * a pass adds nothing.
   */
  const pending = [...doc.folders]
  const map: Record<string, string> = {}
  while (pending.length > 0) {
    const before = pending.length
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const folder = pending[index]
      const exportedParent = folder.parentId ?? null
      // A folder whose parent is missing from the file is treated as top level.
      const knownParent =
        exportedParent === null ||
        map[exportedParent] !== undefined ||
        !doc.folders.some((f) => f.id === exportedParent)
      if (!knownParent) continue

      const parentId = exportedParent === null ? rootTarget : (map[exportedParent] ?? rootTarget)
      const existing = existingFolders.get(folderKey(parentId, folder.name))
      if (existing) {
        map[folder.id] = existing
        if (!plan.reusedFolders.includes(folder.name)) plan.reusedFolders.push(folder.name)
      } else {
        const id = randomUUID()
        map[folder.id] = id
        plan.folders.push({ id, name: folder.name, parentId, color: folder.color })
        // New groups join the map too, so the next duplicate in this same file
        // reuses the group instead of creating a twin.
        existingFolders.set(folderKey(parentId, folder.name), id)
      }
      pending.splice(index, 1)
    }
    if (pending.length === before) break
  }

  const taken = new Set(current.sessions.map((session) => sessionKey(session)))
  for (const session of doc.sessions) {
    const key = sessionKey(session)
    if (taken.has(key)) {
      plan.duplicates.push(session)
      continue
    }
    taken.add(key)

    const id = randomUUID()
    plan.sessionIdMap[session.id] = id
    plan.sessions.push({
      id,
      name: session.name?.trim() || `${session.username}@${session.host}`,
      host: session.host,
      port: session.port ?? 22,
      username: session.username,
      authMethod: session.authMethod ?? 'password',
      privateKeyPath: session.privateKeyPath,
      tags: session.tags ?? [],
      color: session.color,
      notes: session.notes,
      parentId: session.parentId ? (map[session.parentId] ?? rootTarget) : rootTarget
    })

    const secret = doc.credentials[session.id]
    if (!options.skipCredentials && secret && (secret.password || secret.passphrase)) {
      plan.credentials.push({ id, password: secret.password, passphrase: secret.passphrase })
    }
  }

  return plan
}

/** A summary of what an import did, for the toast and the probe. */
export interface ShareImportSummary {
  added: number
  skipped: number
  folders: number
  reusedFolders: string[]
  withPasswords: number
}

export function summariseImport(plan: ShareImportPlan): ShareImportSummary {
  return {
    added: plan.sessions.length,
    skipped: plan.duplicates.length,
    folders: plan.folders.length,
    reusedFolders: plan.reusedFolders,
    withPasswords: plan.credentials.filter((entry) => !!entry.password).length
  }
}
