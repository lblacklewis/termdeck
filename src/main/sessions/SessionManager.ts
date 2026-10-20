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
  /**
   * The backend ended.
   *
   * `expected` is true when the app itself asked for the close (a pane closing,
   * Ctrl+D on a finished pane), which is what tells an ordinary end apart from a
   * connection that dropped — only the second one is worth retrying.
   */
  exit: (
    id: string,
    code: number | null,
    signal: string | null,
    expected: boolean
  ) => void
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
  /** Null once the backend has ended; the record outlives it, see `create`. */
  backend: SessionBackend | null
  /** Rolling tail of output, newest last. */
  buffer: string
  /** Sequence number of the most recent chunk written to `buffer`. */
  seq: number
  /** The app asked for this close, so the exit is not a connection failure. */
  requested: boolean
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
    rows = 24,
    /**
     * Rebuild this id rather than allocating a new one.
     *
     * This is what a reconnect passes. The renderer keys its terminal on the
     * session id, so a new id would mean a new terminal — and the scrollback, the
     * thing the user is looking at when a connection drops, would go with it.
     * Reusing the id keeps the terminal, and therefore keeps the history.
     *
     * A record whose backend has ended is still in the map (see the exit handler),
     * so the rolling buffer it holds survives too: a pane that mounts later can
     * still replay what this session printed before it died.
     */
    reuseId?: string
  ): Promise<SessionInfo> {
    const existing = reuseId ? this.sessions.get(reuseId) : undefined
    const id = reuseId ?? randomUUID()
    const backend = await factory(id, cols, rows)

    if (existing) {
      // The connection being replaced is done either way; make sure it is closed
      // and cannot be written to, but do not let its exit look like the new one's.
      existing.backend?.close()
      existing.backend = backend
      existing.requested = false
      existing.info = { ...existing.info, ...meta, cols, rows, startedAt: Date.now() }
      this.attach(existing, backend)
      return existing.info
    }

    const info: SessionInfo = { ...meta, id, cols, rows, startedAt: Date.now() }
    const session: Session = { info, backend, buffer: '', seq: 0, requested: false }
    this.sessions.set(id, session)
    this.attach(session, backend)
    return info
  }

  /**
   * Wire a backend's events to the session record and the bus.
   *
   * Attached only after the session is registered, so early output is both
   * buffered and broadcast rather than dropped.
   */
  private attach(session: Session, backend: SessionBackend): void {
    const { id } = session.info

    backend.on('data', (chunk: string) => {
      session.seq += 1
      session.buffer += chunk
      if (session.buffer.length > REPLAY_LIMIT) {
        session.buffer = session.buffer.slice(session.buffer.length - REPLAY_LIMIT)
      }
      this.bus.emit('data', id, chunk, session.seq)
    })
    backend.on('exit', (code: number | null, signal: string | null) => {
      const current = this.sessions.get(id)
      /*
       * A backend that has already been replaced can still report its own exit a
       * moment later. Acting on that would tear down the connection that just
       * replaced it, so the only backend allowed to end the session is the one the
       * session currently holds.
       */
      if (current && current.backend !== backend) return
      this.bus.emit('exit', id, code, signal, session.requested)
      if (current) current.backend = null
    })
    backend.on('error', (err: Error) => this.bus.emit('error', id, err))
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
    this.sessions.get(id)?.backend?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session || !session.backend) return
    session.info.cols = cols
    session.info.rows = rows
    session.backend.resize(cols, rows)
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // Remembered so the exit that follows is reported as intended rather than as a
    // connection failure the UI would try to retry.
    session.requested = true
    this.sessions.delete(id)
    session.backend?.close()
  }

  /**
   * Give up on a failed backend but keep the record and its history.
   *
   * Used when a *reconnect* fails: the pane still exists and will try again, and
   * the output it printed before the drop is still the pane's history.
   */
  abandon(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    const backend = session.backend
    session.backend = null
    backend?.close()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** Live sessions only: a record kept for its history is not a session. */
  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.backend !== null)
      .map((session) => session.info)
  }
}

export const sessionManager = new SessionManager()
