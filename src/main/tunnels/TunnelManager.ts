import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'

import type { TunnelSpec, TunnelState, TunnelStatus } from '@shared/types'

export interface TunnelDeps {
  /**
   * Everything needed to open an SSH connection to the session this tunnel
   * rides on. Supplied by the caller so the credential rules (which store holds
   * the password, what counts as "no credential at all") stay in exactly one
   * place — the same place the pane's own connections use.
   */
  resolveOptions(
    savedSessionId: string
  ): Promise<{ ok: true; options: ConnectConfig } | { ok: false; message: string }>
  /** Persist the list. Called on every change, so a crash loses nothing. */
  persist(specs: TunnelSpec[]): void
}

interface Running {
  status: TunnelStatus
  message?: string
  server?: Server
  client?: Client
  connections: number
}

/**
 * SSH local port forwarding, as a thing you start and leave running.
 *
 * `-L` semantics: a listener on this machine, and every connection to it is
 * forwarded through the SSH host to a destination *that host* can reach. That is
 * the useful direction for a terminal client — reaching a database or a web UI
 * that is only reachable from inside the network you are logged into.
 *
 * One ssh2 connection per running tunnel rather than a pool: tunnels are few,
 * they are independent (stopping one must not disturb another), and a shared
 * connection would make "stop" mean "stop everything that happens to be on it".
 *
 * The listener binds 127.0.0.1 by default. Binding 0.0.0.0 would expose an
 * internal service to the whole local network, which is a decision the user has
 * to make deliberately — so the address is part of the spec and the UI defaults
 * to loopback.
 */
export class TunnelManager extends EventEmitter {
  private readonly specs = new Map<string, TunnelSpec>()
  private readonly running = new Map<string, Running>()

  constructor(private readonly deps: TunnelDeps) {
    super()
  }

  list(): TunnelState[] {
    return [...this.specs.values()].map((spec) => {
      const run = this.running.get(spec.id)
      return {
        ...spec,
        status: run?.status ?? 'stopped',
        message: run?.message,
        connections: run?.connections ?? 0
      }
    })
  }

  /** Replace the stored list. Anything dropped or re-pointed is stopped first. */
  save(specs: TunnelSpec[]): TunnelState[] {
    const next = new Map<string, TunnelSpec>()
    for (const spec of specs) {
      const id = spec.id || randomUUID()
      next.set(id, { ...spec, id, name: spec.name.trim() || `${spec.localPort} → ${spec.remoteHost}:${spec.remotePort}` })
    }
    /*
     * A running forward cannot be re-pointed. Its listener and its SSH channel
     * were built from the old numbers, so keeping it alive while the list shows
     * the new ones would leave a tunnel that looks right and forwards somewhere
     * else — the failure mode this feature is most likely to produce. Stopping it
     * makes the row honestly say "stopped" and the user presses Start again.
     *
     * Renaming is not re-pointing: that only touches the label.
     */
    for (const [id, previous] of this.specs) {
      const updated = next.get(id)
      if (!updated || sameTarget(previous, updated)) continue
      if (this.running.has(id)) this.stop(id)
    }
    for (const id of [...this.specs.keys()]) {
      if (!next.has(id)) this.stop(id)
    }
    this.specs.clear()
    for (const [id, spec] of next) this.specs.set(id, spec)
    this.persist()
    return this.list()
  }

  remove(id: string): TunnelState[] {
    this.stop(id)
    this.specs.delete(id)
    this.persist()
    return this.list()
  }

  async start(id: string): Promise<TunnelState[]> {
    const spec = this.specs.get(id)
    if (!spec) return this.list()
    if (this.running.get(id)?.status === 'running') return this.list()

    this.setStatus(id, 'starting')
    let resolved: { ok: true; options: ConnectConfig } | { ok: false; message: string }
    try {
      resolved = await this.deps.resolveOptions(spec.savedSessionId)
    } catch (err) {
      // Building the options reads the key file and checks the host key, both of
      // which can fail before any socket is opened.
      this.fail(id, err instanceof Error ? err.message : String(err))
      return this.list()
    }
    if (!resolved.ok) {
      this.setStatus(id, 'error', resolved.message)
      return this.list()
    }

    const client = new Client()
    const run: Running = { status: 'starting', client, connections: 0 }
    this.running.set(id, run)

    client.on('error', (err: Error) => {
      this.fail(id, err.message)
    })
    client.on('close', () => {
      // The connection is the tunnel: once it is gone the listener has nowhere
      // to send anything, so it goes too rather than accepting connections that
      // can never be forwarded.
      if (this.running.get(id)?.status === 'running') {
        this.setStatus(id, 'error', 'The SSH connection for this tunnel closed.')
      }
      this.closeServer(id)
    })

    client.on('ready', () => {
      this.openListener(id, spec, client)
    })

    try {
      client.connect(resolved.options)
    } catch (err) {
      this.fail(id, err instanceof Error ? err.message : String(err))
    }
    return this.list()
  }

  private openListener(id: string, spec: TunnelSpec, client: Client): void {
    const server = createServer((socket: Socket) => {
      const run = this.running.get(id)
      if (run) run.connections += 1
      this.emitChanged()

      const done = (): void => {
        const live = this.running.get(id)
        if (live) live.connections = Math.max(0, live.connections - 1)
        this.emitChanged()
      }
      socket.on('close', done)
      socket.on('error', done)

      client.forwardOut(
        socket.localAddress ?? '127.0.0.1',
        socket.localPort ?? 0,
        spec.remoteHost,
        spec.remotePort,
        (err, stream) => {
          if (err) {
            // The listener is fine; this one destination is not. Say so on the
            // socket and keep the tunnel up — a database that is down must not
            // take the tunnel down with it.
            socket.destroy()
            this.setStatus(id, 'running', `Forward failed: ${err.message}`)
            return
          }
          socket.pipe(stream).pipe(socket)
        }
      )
    })

    server.on('error', (err: Error) => {
      this.fail(id, this.describeListenError(err, spec))
    })

    server.listen(spec.localPort, spec.localHost, () => {
      const run = this.running.get(id)
      if (!run) return
      run.server = server
      run.status = 'running'
      run.message = undefined
      this.emitChanged()
    })
  }

  /** Turn EADDRINUSE into something a user can act on. */
  private describeListenError(err: NodeJS.ErrnoException, spec: TunnelSpec): string {
    if (err.code === 'EADDRINUSE') {
      return `Port ${spec.localPort} on ${spec.localHost} is already in use.`
    }
    if (err.code === 'EACCES') {
      return `This machine will not let the app listen on port ${spec.localPort}.`
    }
    return err.message
  }

  stop(id: string): TunnelState[] {
    const run = this.running.get(id)
    if (run) {
      this.closeServer(id)
      try {
        run.client?.end()
      } catch {
        // Already gone.
      }
      this.running.delete(id)
    }
    if (this.specs.has(id)) this.setStatus(id, 'stopped')
    return this.list()
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  private closeServer(id: string): void {
    const run = this.running.get(id)
    if (!run?.server) return
    try {
      run.server.close()
    } catch {
      // Already closed.
    }
    run.server = undefined
  }

  private fail(id: string, message: string): void {
    this.closeServer(id)
    const run = this.running.get(id)
    if (run) {
      try {
        run.client?.end()
      } catch {
        // Already gone.
      }
    }
    this.running.delete(id)
    this.setStatus(id, 'error', message)
  }

  private setStatus(id: string, status: TunnelStatus, message?: string): void {
    if (this.specs.has(id)) {
      const run = this.running.get(id) ?? { status, connections: 0 }
      run.status = status
      run.message = message
      this.running.set(id, run)
    }
    this.emitChanged()
  }

  private persist(): void {
    this.deps.persist([...this.specs.values()])
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

/**
 * Whether two specs describe the same forward.
 *
 * The name is excluded on purpose: renaming must not tear down a working tunnel.
 * Everything that the listener or the SSH channel was built from is included.
 */
function sameTarget(a: TunnelSpec, b: TunnelSpec): boolean {
  return (
    a.savedSessionId === b.savedSessionId &&
    a.localHost === b.localHost &&
    a.localPort === b.localPort &&
    a.remoteHost === b.remoteHost &&
    a.remotePort === b.remotePort
  )
}
