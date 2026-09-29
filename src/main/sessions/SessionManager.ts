import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { SessionInfo } from '@shared/types'

/**
 * Transport-agnostic terminal backend.
 *
 * A session is whatever is on the other end of a terminal: a local shell, or an
 * SSH channel (interactive shell / `exec`). The renderer only ever talks to the
 * SessionManager, never to ssh2 or node-pty directly, so the renderer keeps
 * running with `contextIsolation` and no Node integration.
 */
export interface SessionBackend extends EventEmitter {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}

// `SessionInfo` lives in @shared/types so main, preload and renderer agree on it.
export type { SessionInfo }

/** Renderer-facing events, mirrored over IPC by `ipc.ts`. */
export interface SessionEvents {
  /** `seq` is a per-session monotonic chunk counter; see `replay()`. */
  data: (id: string, chunk: string, seq: number) => void
  exit: (id: string, code: number | null, signal: string | null) => void
  /** Full error object so IPC can inspect discriminants such as HOST_KEY_REQUIRED. */
  error: (id: string, error: Error) => void
}

type BackendFactory = (id: string, cols: number, rows: number) => Promise<SessionBackend>

/**
 * How much recent output to retain per session.
 *
 * A connection is created before the renderer has mounted (and subscribed to)
 * the panel that will display it, so handshake banners, MOTD and the first
 * prompt would otherwise be broadcast into the void. Retaining a rolling
 * buffer lets the renderer replay what it missed on mount and reconnect.
 */
const REPLAY_LIMIT = 256 * 1024

interface Session {
  info: SessionInfo
  backend: SessionBackend
  /** Rolling tail of output, newest last. */
  buffer: string
  /** Sequence number of the most recent chunk written to `buffer`. */
  seq: number
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly bus = new EventEmitter()

  on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    this.bus.on(event, listener)
    return this
  }

  off<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    this.bus.off(event, listener)
    return this
  }

  async create(
    factory: BackendFactory,
    meta: Pick<SessionInfo, 'kind' | 'title'>,
    cols = 80,
    rows = 24
  ): Promise<SessionInfo> {
    const id = randomUUID()
    const backend = await factory(id, cols, rows)

    const info: SessionInfo = { ...meta, id, cols, rows, startedAt: Date.now() }
    const session: Session = { info, backend, buffer: '', seq: 0 }
    this.sessions.set(id, session)

    // Attach listeners only after the session is registered so early output is
    // both buffered and broadcast, never dropped.
    backend.on('data', (chunk: string) => {
      session.seq += 1
      session.buffer += chunk
      if (session.buffer.length > REPLAY_LIMIT) {
        session.buffer = session.buffer.slice(session.buffer.length - REPLAY_LIMIT)
      }
      this.bus.emit('data', id, chunk, session.seq)
    })
    backend.on('exit', (code: number | null, signal: string | null) => {
      this.bus.emit('exit', id, code, signal)
      this.sessions.delete(id)
    })
    backend.on('error', (err: Error) => this.bus.emit('error', id, err))

    return info
  }

  /**
   * Buffered output plus the sequence number it ends at, so the consumer can
   * discard live chunks it already rendered and apply only newer ones.
   */
  replay(id: string): { data: string; seq: number } | null {
    const session = this.sessions.get(id)
    return session ? { data: session.buffer, seq: session.seq } : null
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.backend.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.info.cols = cols
    session.info.rows = rows
    session.backend.resize(cols, rows)
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.backend.close()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }
}

export const sessionManager = new SessionManager()
