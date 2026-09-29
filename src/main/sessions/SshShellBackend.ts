import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Client, utils, type ConnectConfig } from 'ssh2'
import type { HostKeyPrompt } from '@shared/types'
import { SessionBackend } from './SessionManager'
import type { KnownHosts } from '../ssh/KnownHosts'

export interface SshAuthOptions {
  /** Password, already resolved by the caller (never an id). */
  password?: string
  /** Path to a private key file; content is read in the main process. */
  privateKeyPath?: string
  /** Passphrase for the private key, already resolved. */
  passphrase?: string
  /** Use the SSH agent (Pageant on Windows, ssh-agent elsewhere). */
  useAgent?: boolean
}

export interface SshConnectOptions {
  host: string
  port?: number
  username: string
  auth: SshAuthOptions
  /** Session label shown on the tab/pane. */
  title?: string
  hostKeyPolicy?: 'strict' | 'ask' | 'trust'
}

export interface SshBackendDeps {
  knownHosts: KnownHosts
}

/** Raised when the user must decide about an unrecognised host key. */
export class HostKeyRequiredError extends Error {
  readonly code = 'HOST_KEY_REQUIRED'
  constructor(readonly prompt: HostKeyPrompt, readonly kind: 'unknown' | 'mismatch' | 'revoked') {
    super(
      kind === 'unknown'
        ? `Unrecognised host key for ${prompt.host}:${prompt.port}`
        : kind === 'mismatch'
          ? `HOST KEY CHANGED for ${prompt.host}:${prompt.port}`
          : `Host key for ${prompt.host}:${prompt.port} is revoked`
    )
    this.name = 'HostKeyRequiredError'
  }
}

/** `ssh2` surfaces failures as plain Errors; make them user-readable. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/authentication methods failed|All configured authentication/i.test(message)) {
    return 'Authentication failed (check username, password or key).'
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'Host not found (DNS lookup failed).'
  if (/ECONNREFUSED/i.test(message)) return 'Connection refused (is sshd listening on that port?).'
  if (/ETIMEDOUT|timed out/i.test(message)) return 'Connection timed out.'
  return message
}

export class SshShellBackend extends EventEmitter implements SessionBackend {
  private readonly client = new Client()
  private stream: import('ssh2').ClientChannel | null = null
  private closed = false
  private exitEmitted = false
  /** Set when we abort deliberately so the generic ssh2 error is suppressed. */
  private deliberate: Error | null = null

  constructor(
    private readonly opts: SshConnectOptions,
    cols: number,
    rows: number,
    private readonly deps: SshBackendDeps
  ) {
    super()
    void this.connect(cols, rows)
  }

  private async buildConfig(): Promise<ConnectConfig> {
    const { opts } = this
    const port = opts.port ?? 22

    const config: ConnectConfig = {
      host: opts.host,
      port,
      username: opts.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      /**
       * Host key checking happens here so a mismatch aborts the handshake before
       * any credential is sent. `false` makes ssh2 emit an error and stop.
       */
      hostVerifier: (key: Buffer | string): boolean => {
        const policy = opts.hostKeyPolicy ?? 'ask'
        if (policy === 'trust') return true

        const verdict = this.deps.knownHosts.verify(opts.host, port, key)
        if (verdict.status === 'trusted') return true

        if (policy === 'strict') {
          this.deliberate = new HostKeyRequiredError(verdict.prompt, verdict.status as 'unknown' | 'mismatch' | 'revoked')
          return false
        }

        // `ask`: refuse for now and let the UI resolve it with the user.
        this.deliberate = new HostKeyRequiredError(verdict.prompt, verdict.status as 'unknown' | 'mismatch' | 'revoked')
        return false
      }
    }

    // Credentials arrive already resolved; the caller owns the credential store.
    const { password, passphrase } = opts.auth

    if (opts.auth.useAgent || (!opts.auth.privateKeyPath && password === undefined)) {
      // Rely on the agent; ssh2 picks up SSH_AUTH_SOCK / Pageant automatically.
      const agent = process.env['SSH_AUTH_SOCK']
      if (agent) {
        config.agent = agent
      } else if (process.platform === 'win32') {
        config.agent = 'pageant'
      }
      if (password !== undefined) config.password = password
      return config
    }

    if (opts.auth.privateKeyPath) {
      try {
        config.privateKey = await readFile(opts.auth.privateKeyPath)
      } catch (err) {
        throw new Error(
          `Cannot read private key "${opts.auth.privateKeyPath}": ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
      if (passphrase) config.passphrase = passphrase

      // Validate up front so an encrypted key without a passphrase reports a
      // clear message instead of failing deep inside the handshake.
      // NOTE: `utils` must come from the static import — a dynamic import of
      // this CJS package yields a namespace where `utils` is undefined.
      try {
        const parsed = utils.parseKey(config.privateKey, passphrase)
        if (parsed instanceof Error) throw parsed
      } catch (err) {
        throw new Error(
          `Invalid or encrypted private key: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      return config
    }

    if (password !== undefined) config.password = password
    return config
  }

  private async connect(cols: number, rows: number): Promise<void> {
    let config: ConnectConfig
    try {
      config = await this.buildConfig()
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      this.finish(null, null)
      return
    }

    // Keyboard-interactive prompts (2FA) reuse whatever secret we already have.
    const fallback = config.password ?? ''
    this.client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => fallback))
    })

    this.client.on('ready', () => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          this.emit('error', new Error(describeError(err)))
          this.client.end()
          this.finish(null, null)
          return
        }

        this.stream = stream
        stream.on('data', (chunk: Buffer) => this.emit('data', chunk.toString('utf8')))
        stream.stderr?.on('data', (chunk: Buffer) => this.emit('data', chunk.toString('utf8')))
        stream.on('close', (code: number | null, signal: string | null) => {
          this.client.end()
          this.finish(code ?? null, signal ?? null)
        })
      })
    })

    this.client.on('error', (err) => {
      // A host-verification abort produces a generic ssh2 error; report the
      // specific reason instead so the UI can offer to trust the key.
      if (this.deliberate) {
        this.emit('error', this.deliberate)
        this.deliberate = null
      } else {
        this.emit('error', new Error(describeError(err)))
      }
      this.finish(null, null)
    })

    this.client.on('close', () => this.finish(null, null))

    try {
      this.client.connect(config)
    } catch (err) {
      this.emit('error', this.deliberate ?? new Error(describeError(err)))
      this.finish(null, null)
    }
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.emit('exit', code, signal)
  }

  write(data: string): void {
    this.stream?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.stream) return
    try {
      this.stream.setWindow(rows, cols, 0, 0)
    } catch {
      // Channel closed mid-resize; ignore.
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.stream?.close()
    } catch {
      // ignore
    }
    try {
      this.client.end()
    } catch {
      // ignore
    }
    // ssh2 may never emit close for a half-dead channel.
    setTimeout(() => this.finish(null, null), 250).unref?.()
  }
}
