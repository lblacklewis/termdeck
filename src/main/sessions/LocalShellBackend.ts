import { EventEmitter } from 'node:events'
import { SessionBackend } from './SessionManager'

export interface LocalShellOptions {
  shell?: string
  cwd?: string
  env?: Record<string, string>
  args?: string[]
}

// node-pty ships prebuilt binaries per platform/arch. It is loaded lazily so a
// missing build only disables local shells instead of breaking SSH entirely.
type PtyModule = {
  spawn(
    file: string,
    args: string[] | string,
    options: Record<string, unknown>
  ): {
    onData(cb: (data: string) => void): void
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
    pid: number
  }
}

let ptyModule: PtyModule | null | undefined

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require('@lydell/node-pty') as PtyModule
  } catch {
    ptyModule = null
  }
  return ptyModule
}

export function isLocalShellAvailable(): boolean {
  return loadPty() !== null
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env['COMSPEC'] || 'powershell.exe'
  }
  return process.env['SHELL'] || '/bin/bash'
}

/**
 * Local shell backed by a real PTY (ConPTY on Windows), so interactive
 * programs, colours and resize behave the same as over SSH.
 */
export class LocalShellBackend extends EventEmitter implements SessionBackend {
  private readonly proc: ReturnType<PtyModule['spawn']>

  constructor(opts: LocalShellOptions, cols: number, rows: number) {
    super()

    const pty = loadPty()
    if (!pty) {
      throw new Error(
        'Local shell is unavailable: @lydell/node-pty has no prebuilt binary for this platform. ' +
          'SSH sessions are unaffected.'
      )
    }

    const shell = opts.shell || defaultShell()
    const args =
      opts.args ?? (process.platform === 'win32' && /powershell|pwsh/i.test(shell) ? ['-NoLogo'] : [])

    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) }
    })

    this.proc.onData((data) => this.emit('data', data))
    this.proc.onExit(({ exitCode, signal }) => {
      this.emit('exit', exitCode, signal === undefined ? null : String(signal))
    })
  }

  write(data: string): void {
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      // The process may already be gone; resize races are harmless.
    }
  }

  close(): void {
    try {
      this.proc.kill()
    } catch {
      // Already dead.
    }
  }
}
