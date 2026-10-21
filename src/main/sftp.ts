import { open, stat } from 'node:fs/promises'
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

/**
 * How a transfer moves bytes.
 *
 * ssh2 hands out two ways to move a file: a read stream (and `fastGet`, which is the same
 * shape) issues one read request at a time, waiting for each answer before asking again.
 * That makes the speed a function of the round trip — 32 KB per RTT is 0.5–1 MB/s on a
 * 30–70 ms link, which from the outside is "SFTP is unusably slow, it does not move at
 * all". The numbers below keep a fixed amount of work in flight instead, so the link
 * stays busy for the whole window rather than one chunk per round trip.
 *
 * 128 KB × 16 = 2 MB in flight, which on a 70 ms link is good for tens of MB/s and is
 * still gentle enough that a slow server is not swamped.
 */
const TRANSFER_CHUNK = 128 * 1024
const TRANSFER_CONCURRENCY = 16

/**
 * The slice of ssh2's SFTP wrapper a transfer uses.
 *
 * Narrow on purpose: a probe can pass a stand-in that answers slowly, which is the only
 * way to show that the chunks really do overlap without a slow network to test on.
 */
export interface SftpLike {
  stat(
    path: string,
    cb: (err: Error | null | undefined, stats?: { size?: number }) => void
  ): void
  open(
    path: string,
    flags: string,
    cb: (err: Error | null | undefined, handle?: Buffer) => void
  ): void
  read(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined, bytesRead?: number) => void
  ): void
  write(
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null | undefined) => void
  ): void
  close(handle: Buffer, cb: (err?: Error | null) => void): void
}

/**
 * What a transfer reports back while it runs.
 *
 * `progress` counts cumulative bytes — the side that moves them is the side that knows how
 * fast the transfer is really going. `register` hands the caller a way to stop it: the
 * loop lives here, and the transfers window is what decides to end it.
 */
export interface TransferHooks {
  progress?: (bytes: number) => void
  register?: (abort: () => void) => void
}

/** What a transfer reports while it runs, and how it is stopped. */
export interface TransferControl {
  /** Cumulative bytes moved. */
  progress: (total: number) => void
  /** True once the caller asked to stop. */
  aborted: () => boolean
}

const remoteOpen = (sftp: SftpLike, path: string, flags: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => {
      if (err || !handle) reject(err ?? new Error('Could not open ' + path))
      else resolve(handle)
    })
  })

const remoteClose = (sftp: SftpLike, handle: Buffer): Promise<void> =>
  new Promise((resolve) => sftp.close(handle, () => resolve()))

const remoteFileSize = (sftp: SftpLike, path: string): Promise<number> =>
  new Promise((resolve) => {
    sftp.stat(path, (err, stats) => resolve(err || !stats ? 0 : stats.size ?? 0))
  })

const remoteRead = (
  sftp: SftpLike,
  handle: Buffer,
  buffer: Buffer,
  length: number,
  position: number
): Promise<number> =>
  new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, length, position, (err, bytes) => {
      if (err) reject(err)
      else resolve(bytes ?? 0)
    })
  })

const remoteWrite = (
  sftp: SftpLike,
  handle: Buffer,
  buffer: Buffer,
  length: number,
  position: number
): Promise<void> =>
  new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, length, position, (err) => (err ? reject(err) : resolve()))
  })

/**
 * Run `transfer` over the whole file with several chunks in flight.
 *
 * Not `Promise.all` over a precomputed list: an abort has to stop *asking* for more work,
 * and one failed chunk has to stop the others instead of letting them keep reading a file
 * nobody wants any more. Both fall out of workers pulling from a shared cursor.
 */
async function pump(
  total: number,
  transfer: (position: number, length: number) => Promise<void>,
  control: TransferControl
): Promise<void> {
  const chunks = Math.ceil(total / TRANSFER_CHUNK)
  if (chunks <= 0) return
  let cursor = 0
  let moved = 0
  let failure: unknown = null
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure || control.aborted()) return
      if (cursor >= total) return
      const position = cursor
      const length = Math.min(TRANSFER_CHUNK, total - position)
      cursor += length
      try {
        await transfer(position, length)
      } catch (err) {
        failure = failure ?? err
        return
      }
      moved += length
      control.progress(moved)
    }
  }
  const workers = Array.from({ length: Math.min(TRANSFER_CONCURRENCY, chunks) }, () =>
    worker()
  )
  await Promise.all(workers)
  if (failure) throw failure
}

/** Download one remote file to a local path, several chunks at a time. */
export async function downloadTo(
  sftp: SftpLike,
  remotePath: string,
  localPath: string,
  control: TransferControl
): Promise<void> {
  const size = await remoteFileSize(sftp, remotePath)
  const handle = await remoteOpen(sftp, remotePath, 'r')
  const out = await open(localPath, 'w')
  try {
    await pump(
      size,
      async (position, length) => {
        const buffer = Buffer.allocUnsafe(length)
        const bytes = await remoteRead(sftp, handle, buffer, length, position)
        if (bytes === 0) throw new Error('The remote file ended before its reported size.')
        /*
         * Written at its own offset rather than appended: chunks finish out of order,
         * and an append would shuffle the file's contents.
         */
        await out.write(buffer, 0, bytes, position)
      },
      control
    )
  } finally {
    await remoteClose(sftp, handle)
    await out.close().catch(() => undefined)
  }
}

/** Upload one local file to a remote path, several chunks at a time. */
export async function uploadFrom(
  sftp: SftpLike,
  localPath: string,
  remotePath: string,
  control: TransferControl
): Promise<void> {
  const stats = await stat(localPath)
  const handle = await remoteOpen(sftp, remotePath, 'w')
  const source = await open(localPath, 'r')
  try {
    await pump(
      stats.size,
      async (position, length) => {
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await source.read(buffer, 0, length, position)
        if (bytesRead === 0) throw new Error('The local file ended before its reported size.')
        await remoteWrite(sftp, handle, buffer, bytesRead, position)
      },
      control
    )
  } finally {
    await remoteClose(sftp, handle)
    await source.close().catch(() => undefined)
  }
}

/** Wire the caller's hooks to a control block, including the abort request. */
function controlFor(hooks?: TransferHooks): TransferControl {
  let aborted = false
  hooks?.register?.(() => {
    aborted = true
  })
  return { progress: (total) => hooks?.progress?.(total), aborted: () => aborted }
}

/**
 * The size of a remote file, for a progress bar that knows where it is going.
 *
 * Reported as 0 rather than thrown when the host cannot answer: a transfer without a
 * total still has to run, it just shows an indeterminate bar.
 */
export async function remoteSize(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps,
  remotePath: string
): Promise<number> {
  try {
    const { sftp } = await session(sessionId, options, deps)
    return await remoteFileSize(sftp as unknown as SftpLike, remotePath)
  } catch {
    return 0
  }
}

/** Download one remote file to a local path chosen by the caller. */
export async function downloadFile(
  sessionId: string,
  options: SshConnectOptions,
  deps: SshBackendDeps,
  remotePath: string,
  localPath: string,
  hooks?: TransferHooks
): Promise<SftpTransferResult> {
  try {
    const { sftp } = await session(sessionId, options, deps)
    // ssh2's overloads do not structurally match the slice this needs; the object does.
    await downloadTo(sftp as unknown as SftpLike, remotePath, localPath, controlFor(hooks))
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
  remoteDir: string,
  hooks?: TransferHooks
): Promise<SftpTransferResult> {
  const remotePath = join(remoteDir, basename(localPath)).replace(/\\/g, '/')
  try {
    const { sftp } = await session(sessionId, options, deps)
    await uploadFrom(sftp as unknown as SftpLike, localPath, remotePath, controlFor(hooks))
    return { ok: true, path: remotePath }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
