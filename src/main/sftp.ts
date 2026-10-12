import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'

import type { SftpEntry, SftpListResult, SftpTransferResult } from '@shared/types'
import {
  buildSshConnectConfig,
  describeError,
  type SshConnectOptions,
  type SshBackendDeps
} from './sessions/SshShellBackend'

/**
 * Files over the connection a pane is already using.
 *
 * The renderer never holds credentials, so it cannot open an SFTP session of its
 * own: it asks by *session id* and the main process rebuilds the connection from
 * the options that session was started with — the same blueprint
 * `session:duplicate` uses, and the same host-key rules the terminal went
 * through. Nothing about the credentials is re-asked or re-guessed.
 *
 * One SFTP session is kept per terminal session id and reused: opening a new SSH
 * handshake for every directory change would make browsing unusable over a slow
 * link. A failed connection is dropped from the cache so the next attempt can
 * recover from a link that has come back.
 */

interface Pooled {
  client: Client
  sftp: SFTPWrapper
}

const pool = new Map<string, Promise<Pooled>>()

/** Close the pooled SFTP session for a terminal session, if there is one. */
export function closeSftp(sessionId: string): void {
  const pending = pool.get(sessionId)
  if (!pending) return
  pool.delete(sessionId)
  void pending
    .then(({ client }) => client.end())
    .catch(() => {
      /* it never opened */
    })
}

export function closeAllSftp(): void {
  for (const id of [...pool.keys()]) closeSftp(id)
}

async function connect(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps
): Promise<Pooled> {
  const client = new Client()
  let hostKeyProblem: Error | null = null
  const config = await buildSshConnectConfig(options, deps.knownHosts, (err) => {
    hostKeyProblem = err
  })

  const ready = new Promise<void>((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', (err: Error) => reject(hostKeyProblem ?? new Error(describeError(err))))
    client.once('close', () => reject(new Error('Connection closed.')))
  })

  client.connect(config)
  try {
    await ready
  } catch (err) {
    client.end()
    throw err
  }

  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, session) => (err ? reject(new Error(describeError(err))) : resolve(session)))
  })

  // A session that dies on its own must not stay in the pool pretending to work.
  client.once('close', () => {
    if (pool.get(sessionId)) pool.delete(sessionId)
  })

  return { client, sftp }
}

function session(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps
): Promise<Pooled> {
  const existing = pool.get(sessionId)
  if (existing) {
    return existing.catch((err) => {
      pool.delete(sessionId)
      throw err
    })
  }
  const pending = connect(sessionId, options, deps)
  pool.set(sessionId, pending)
  void pending.catch(() => {
    if (pool.get(sessionId) === pending) pool.delete(sessionId)
  })
  return pending
}

/** Join a remote path the way a POSIX shell would. */
function resolvePath(dir: string, name: string): string {
  if (name === '..') {
    const trimmed = dir.replace(/\/+$/, '')
    const cut = trimmed.lastIndexOf('/')
    return cut <= 0 ? '/' : trimmed.slice(0, cut)
  }
  if (name.startsWith('/')) return name
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

export async function listDirectory(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps,
  path: string
): Promise<SftpListResult> {
  let target = path.trim() || '.'
  try {
    const { sftp } = await session(sessionId, options, deps)

    // A relative path (the opening ".") has to be turned into an absolute one
    // before it can be shown or navigated: the user should never be left at a
    // path they cannot go up from.
    if (!target.startsWith('/')) target = await realpath(sftp, target)

    const list = await new Promise<Parameters<typeof toEntry>[1][]>((resolve, reject) => {
      sftp.readdir(target, (err, entries) => (err ? reject(new Error(describeError(err))) : resolve(entries)))
    })

    const entries = list
      .map((entry) => toEntry(target, entry))
      .sort((a, b) => {
        // Directories first, then by name — the order a file manager uses.
        if ((a.type === 'directory') !== (b.type === 'directory')) {
          return a.type === 'directory' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })

    return { ok: true, path: target, entries }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve) => {
    sftp.realpath(path, (err, resolved) => resolve(err || !resolved ? path : resolved))
  })
}

function toEntry(
  dir: string,
  entry: { filename: string; longname: string; attrs: { mode?: number; size?: number; mtime?: number } }
): SftpEntry {
  const mode = entry.attrs.mode ?? 0
  // The mode bits are the only reliable type information ssh2 hands back.
  const isDirectory = (mode & 0o170000) === 0o040000
  const isLink = (mode & 0o170000) === 0o120000
  return {
    name: entry.filename,
    path: resolvePath(dir, entry.filename),
    type: isDirectory ? 'directory' : isLink ? 'link' : (mode & 0o170000) === 0o100000 ? 'file' : 'other',
    size: entry.attrs.size ?? 0,
    // `mtime` is seconds since the epoch.
    modified: entry.attrs.mtime ? entry.attrs.mtime * 1000 : 0
  }
}

/** Download one remote file to a local path chosen by the caller. */
export async function downloadFile(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps,
  remotePath: string,
  localPath: string
): Promise<SftpTransferResult> {
  try {
    const { sftp } = await session(sessionId, options, deps)
    const read = sftp.createReadStream(remotePath)
    const write = createWriteStream(localPath)
    read.pipe(write)
    await Promise.all([once(read, 'end'), once(write, 'close')])
    return { ok: true, path: localPath }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** Upload one local file into a remote directory. */
export async function uploadFile(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps,
  localPath: string,
  remoteDir: string
): Promise<SftpTransferResult> {
  const remotePath = join(remoteDir, basename(localPath)).replace(/\\/g, '/')
  try {
    const { sftp } = await session(sessionId, options, deps)
    const read = createReadStream(localPath)
    const write = sftp.createWriteStream(remotePath)
    read.pipe(write)
    await Promise.all([once(read, 'end'), once(write, 'close')])
    return { ok: true, path: remotePath }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
