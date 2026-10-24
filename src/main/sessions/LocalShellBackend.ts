import { EventEmitter } from 'node:events'
import { SessionBackend } from './SessionManager'
import { chooseShell, shellArgs } from './shellChoice'

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

    const choice = chooseShell(process.platform, process.env)
    const shell = opts.shell || choice.shell
    // Recomputed from the shell that was actually chosen, so an explicitly
    // configured PowerShell still gets `-NoLogo` and a Mac shell never does.
    const args = opts.args ?? shellArgs(process.platform, shell)

    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd || process.cwd(),
      // The platform's fill-in-the-gaps environment first, the caller's overrides last.
      env: { ...process.env, ...choice.env, ...(opts.env ?? {}) }
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
