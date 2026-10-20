/**
 * Port-forward definitions, persisted.
 *
 * Only the *description* of a tunnel lives here: who it rides on and which
 * ports it joins. Nothing is started on load — opening an SSH connection at
 * launch because a tunnel was left running last time would be a surprise, and
 * exactly the kind of thing that would then hold a network down quietly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { TunnelSpec } from '@shared/types'

/** A port that can actually be dialled or listened on. */
function port(value: unknown, fallback: number | null): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback
  return n
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitise(input: unknown): TunnelSpec[] {
  if (!Array.isArray(input)) return []
  const out: TunnelSpec[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const spec = raw as Partial<TunnelSpec>
    const savedSessionId = text(spec.savedSessionId)
    const remoteHost = text(spec.remoteHost)
    const localPort = port(spec.localPort, null)
    const remotePort = port(spec.remotePort, null)
    // An entry missing any of these cannot be started, so it is not a tunnel.
    if (!savedSessionId || !remoteHost || localPort === null || remotePort === null) continue
    out.push({
      id: text(spec.id) || randomUUID(),
      name: text(spec.name) || `${localPort} → ${remoteHost}:${remotePort}`,
      savedSessionId,
      localHost: text(spec.localHost) || '127.0.0.1',
      localPort,
      remoteHost,
      remotePort
    })
  }
  return out
}

export class TunnelStore {
  private readonly path: string
  private state: TunnelSpec[]

  constructor(configDir: string) {
    this.path = join(configDir, 'tunnels.json')
    this.state = sanitise(this.read())
  }

  private read(): unknown {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // A corrupt list must never block startup; an empty list is honest.
      return null
    }
  }

  load(): TunnelSpec[] {
    return this.state
  }

  save(next: TunnelSpec[]): TunnelSpec[] {
    this.state = sanitise(next)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.path)
    return this.state
  }
}
