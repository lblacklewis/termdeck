import { app, BrowserWindow, dialog, ipcMain, clipboard } from 'electron'
import { mkdirSync } from 'node:fs'
import { access, constants, readFile, writeFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'

import { sessionManager } from './sessions/SessionManager'
import { LocalShellBackend, isLocalShellAvailable } from './sessions/LocalShellBackend'
import { TelnetBackend, type TelnetOptions } from './sessions/TelnetBackend'
import { SerialBackend, isSerialAvailable, type SerialOptions } from './sessions/SerialBackend'
import {
  buildShareDocument,
  packShare,
  planImport,
  ShareError,
  summariseImport,
  unpackShare
} from './share'
import { copyData, resolveDataDir, writePointer } from './dataDir'
import {
  SshShellBackend,
  HostKeyRequiredError,
  buildSshConnectConfig,
  type SshConnectOptions
} from './sessions/SshShellBackend'
import { CredentialStore } from './store/CredentialStore'
import { LayoutStore } from './store/LayoutStore'
import { TunnelStore } from './store/TunnelStore'
import { RestStore } from './store/RestStore'
import { TunnelManager } from './tunnels/TunnelManager'
import { listFontChoices } from './fonts'
import { clampScale, HistoryStore, SettingsStore, SessionStore } from './store/Stores'
import { KnownHosts } from './ssh/KnownHosts'
import { sendRestRequest } from './rest'
import { closeSftp, downloadFile, listDirectory, uploadFile } from './sftp'
import type {
  AppSettings,
  RestRequest,
  RestState,
  TunnelSpec,
  CreateSessionResult,
  FontChoices,
  HostKeyPrompt,
  LayoutState,
  LockStatus,
  LocalConnectPayload,
  SaveLockRequest,
  SavedSession,
  SaveTextFileRequest,
  SaveTextFileResult,
  SessionFolder,
  SessionTree,
  ShareExportRequest,
  ShareExportResult,
  DataDirectoryRequest,
  DataDirectoryResult,
  DataDirectoryStatus,
  ShareImportRequest,
  ShareImportResult,
  SharePeekResult,
  SharePickResult,
  SerialConnectPayload,
  SftpListResult,
  SftpTransferResult,
  Snippet,
  SshConnectPayload,
  TelnetConnectPayload,
  TrustHostKeyRequest
} from '@shared/types'

interface CreateBase {
  cols?: number
  rows?: number
}

/** How long to wait for a connection to either produce output or fail. */
const HANDSHAKE_WATCH_MS = 8_000

/**
 * How each live session was opened, so it can be opened again.
 *
 * The renderer cannot reconstruct this: an SSH connection's options hold the
 * password resolved from the encrypted vault (or typed once into the prompt),
 * and none of that ever travels back over IPC. Keeping the blueprint here is
 * what makes "duplicate this connection" mean *the same host, the same
 * credentials* rather than a guess from the saved-session list — a guess that
 * produced a local shell whenever the connection was not started from a saved
 * entry.
 */
type SessionBlueprint =
  | { kind: 'ssh'; options: SshConnectOptions; cols: number; rows: number; post?: string[] }
  | { kind: 'local'; title: string; cols: number; rows: number; post?: string[] }
  | { kind: 'telnet'; options: TelnetOptions; cols: number; rows: number; post?: string[] }
  | { kind: 'serial'; options: SerialOptions; cols: number; rows: number; post?: string[] }

/**
 * Type a session's post-connect lines in, once it is up.
 *
 * Spaced rather than pasted as one blob on purpose: the far end needs a moment
 * to finish its banner and reach a prompt, and a console that is still booting
 * drops whatever arrives before it is listening. The first delay is longer than
 * the rest because that is the one covering the login banner.
 */
function runPostConnect(sessionId: string, commands: string[] | undefined, delay = 900): void {
  const lines = (commands ?? []).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length === 0) return
  let at = delay
  for (const line of lines) {
    setTimeout(() => {
      // A session that died in the meantime is a no-op rather than a throw.
      sessionManager.write(sessionId, line + '\r')
    }, at)
    at += 400
  }
}

const blueprints = new Map<string, SessionBlueprint>()

/** Store one command and tell the UI, unless it was a no-op repeat. */
function recordCommand(sessionId: string, command: string): void {
  const store = getHistoryStore()
  const before = store.list(sessionId).length
  const title = sessionManager.list().find((s) => s.id === sessionId)?.title ?? 'session'
  const entries = store.add(sessionId, title, command)
  // The same line feeds the shared suggestion list (see `HistoryStore.remember`),
  // which is what inline completion reads — one command often wanted in another pane.
  store.remember(command)
  if (entries.length !== before) broadcast('history:changed', { sessionId, entries })
}


// Lazily created so `app.getPath('userData')` is available.
let credentials: CredentialStore | null = null
let settingsStore: SettingsStore | null = null
let sessionStore: SessionStore | null = null
let layoutStore: LayoutStore | null = null
let tunnelStore: TunnelStore | null = null
let tunnelManager: TunnelManager | null = null
let restStore: RestStore | null = null

/**
 * Host keys are read from the user's real OpenSSH files by default. The
 * environment override exists purely so the verification harnesses can drive
 * trust/mismatch flows without touching the developer's `~/.ssh/known_hosts`.
 */
const knownHosts = process.env['TERMDECK_KNOWN_HOSTS']
  ? new KnownHosts({ paths: [process.env['TERMDECK_KNOWN_HOSTS']] })
  : new KnownHosts()

function configDir(): string {
  return resolveDataDirOnce()
}

/**
 * Where the stores read and write.
 *
 * Resolved once, because every store is built around a directory and a value that
 * changed mid-run would leave some stores on the old path. Changing it writes the
 * pointer and restarts, which is also why the welcome page offers it before
 * anything has been created.
 */
let dataDirRef: string | null = null

function resolveDataDirOnce(): string {
  if (dataDirRef === null) {
    dataDirRef = resolveDataDir(app.getPath('userData'))
  }
  return dataDirRef
}

function getCredentials(): CredentialStore {
  credentials ??= new CredentialStore(configDir())
  return credentials
}

function getLayoutStore(): LayoutStore {
  layoutStore ??= new LayoutStore(configDir())
  return layoutStore
}

function getSettingsStore(): SettingsStore {
  settingsStore ??= new SettingsStore(configDir())
  return settingsStore
}

/** Only for the app entry, which needs the saved interface scale before start-up. */
export function loadSettingsForStartup(): AppSettings {
  return getSettingsStore().load()
}

function getSessionStore(): SessionStore {
  sessionStore ??= new SessionStore(configDir())
  return sessionStore
}

function getRestStore(): RestStore {
  restStore ??= new RestStore(configDir())
  return restStore
}

function getTunnelStore(): TunnelStore {
  tunnelStore ??= new TunnelStore(configDir())
  return tunnelStore
}

/**
 * The port-forward engine, created once.
 *
 * It owns its own SSH connections: a tunnel is meant to outlive the pane that
 * inspired it (that is the point of a tunnel), so it cannot borrow a session's
 * connection — closing the terminal would silently kill the forward.
 */
function getTunnelManager(): TunnelManager {
  if (tunnelManager) return tunnelManager
  const store = getTunnelStore()
  tunnelManager = new TunnelManager({
    resolveOptions: async (savedSessionId) => {
      const resolved = savedSessionOptions(savedSessionId)
      if (!resolved.ok) return resolved
      /*
       * The same config the pane builds, key file and agent included. A host key
       * that has not been trusted yet throws here — which is right: a tunnel
       * cannot answer a prompt, and the message should send the user to the host
       * page instead of failing opaquely.
       */
      const options = await buildSshConnectConfig(resolved.options, knownHosts)
      return { ok: true, options }
    },
    persist: (specs) => {
      store.save(specs)
    }
  })
  tunnelManager.on('changed', (list) => broadcast('tunnel:changed', list))
  // Restore the saved definitions without starting anything: a tunnel that
  // reopens itself on launch could quietly hold a production link open.
  tunnelManager.save(store.load())
  return tunnelManager
}

/**
 * Everything a saved session needs to open an SSH connection.
 *
 * The same rules `session:createSsh` applies — a stored password, a key file, or
 * the agent — because a tunnel has to authenticate exactly like a pane does, and
 * there is no payload here to override anything with: a tunnel is started from
 * the app, never from the connect dialog.
 */
function savedSessionOptions(
  sessionId: string
): { ok: true; options: SshConnectOptions } | { ok: false; message: string } {
  const saved = getSessionStore()
    .load()
    .sessions.find((s) => s.id === sessionId)
  if (!saved) return { ok: false, message: 'That saved session no longer exists.' }
  if (saved.kind === 'telnet' || saved.kind === 'serial') {
    return { ok: false, message: `"${saved.name}" is not an SSH session, so a tunnel cannot ride on it.` }
  }

  const credential = getCredentials().get(saved.id)
  if (saved.authMethod === 'password' && !credential.password) {
    return {
      ok: false,
      message:
        `"${saved.name}" has no saved password. Edit the session to add one, ` +
        'select a private key, or switch it to the SSH agent.'
    }
  }

  return {
    ok: true,
    options: {
      host: saved.host,
      port: saved.port,
      username: saved.username,
      title: saved.name,
      hostKeyPolicy: getSettingsStore().load().hostKeys.policy,
      auth: {
        password: credential.password,
        privateKeyPath: saved.privateKeyPath,
        passphrase: credential.passphrase,
        useAgent: saved.authMethod === 'agent'
      }
    }
  }
}

let historyStore: HistoryStore | null = null

function getHistoryStore(): HistoryStore {
  historyStore ??= new HistoryStore(configDir())
  return historyStore
}

/**
 * Where the lock screen's password lives.
 *
 * Not a session, but the same encrypted vault: a reserved id keeps the secret
 * encrypted at rest and, more importantly, keeps it out of the renderer. The
 * renderer can only ask "does it match", never read it back.
 */
const LOCK_CREDENTIAL_ID = '__termdeck_lock__'

function lockStatus(): LockStatus {
  const stored = getCredentials().get(LOCK_CREDENTIAL_ID)
  return { hasPassword: (stored.password ?? '').length > 0 }
}

/** Compare two secrets without leaking how much of a prefix matched. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}


/** Wire the SessionManager's event bus to every renderer window. */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

/**
 * Serialises an Error for IPC. Only `message` normally survives structured
 * clone, so discriminants that the UI needs are copied explicitly.
 */
function serialiseError(err: unknown): {
  message: string
  code?: string
  prompt?: HostKeyPrompt
} {
  if (err instanceof HostKeyRequiredError) {
    return { message: err.message, code: err.code, prompt: err.prompt }
  }
  /*
   * Any error that carries a string `code` keeps it — `AUTH_FAILED` is what lets
   * the renderer tell a rejected password from a dead network and offer to take
   * the password again. Electron serialises IPC failures down to a message, so a
   * discriminant the UI needs has to be copied across explicitly.
   */
  const code = (err as { code?: unknown } | null)?.code
  return {
    message: err instanceof Error ? err.message : String(err),
    ...(typeof code === 'string' ? { code } : {})
  }
}

/**
 * Start an SSH session from fully-resolved options and wait for it to prove
 * itself.
 *
 * A host-key rejection arrives asynchronously, so this waits briefly for either
 * the first output (success) or a failure before reporting to the renderer. It
 * is shared with `session:duplicate`, which passes the stored options of an
 * existing session so a copy reconnects to the same host with the same
 * credentials — including a password that only ever existed in this process.
 */
async function openSsh(
  options: SshConnectOptions,
  cols: number,
  rows: number
): Promise<CreateSessionResult> {
  const label = options.title?.trim() || `${options.username}@${options.host}`

  const info = await sessionManager.create(
    (_id, c, r) => Promise.resolve(new SshShellBackend(options, c, r, { knownHosts })),
    { kind: 'ssh', title: label },
    cols,
    rows
  )
  blueprints.set(info.id, { kind: 'ssh', options, cols, rows })

  return await new Promise<CreateSessionResult>((resolve) => {
    let settled = false
    const done = (value: CreateSessionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sessionManager.off('data', onData)
      sessionManager.off('error', onError)
      sessionManager.off('exit', onExit)
      resolve(value)
    }

    const onData = (id: string): void => {
      if (id === info.id) done({ ok: true, session: info })
    }
    const onError = (id: string, error: Error): void => {
      if (id !== info.id) return
      // Tear the dead session down; the UI will retry after the user decides.
      const serialised = serialiseError(error)
      sessionManager.close(info.id)
      blueprints.delete(info.id)
      done({ ok: false, error: serialised })
    }
    const onExit = (id: string): void => {
      if (id === info.id && !settled) {
        // Exited before producing anything and without a specific error.
        done({ ok: false, error: { message: 'Connection closed unexpectedly.' } })
      }
    }

    const timer = setTimeout(() => done({ ok: true, session: info }), HANDSHAKE_WATCH_MS)
    sessionManager.on('data', onData)
    sessionManager.on('error', onError)
    sessionManager.on('exit', onExit)
  })
}

/**
 * Close every running forward.
 *
 * Called when the app goes away: a listener outliving its window would keep the
 * port bound and, worse, keep an SSH connection to a production host open with
 * nobody watching it.
 */
export function stopAllTunnels(): void {
  tunnelManager?.stopAll()
}

export function registerIpc(): void {
  sessionManager.on('data', (id, chunk, seq) => broadcast('session:data', id, chunk, seq))
  sessionManager.on('exit', (id, code, signal) => {
    // The blueprint describes a live session; drop it with the session so a
    // duplicated pane can never reconnect with options belonging to a dead one,
    // and release the SFTP session that was riding on the same connection.
    blueprints.delete(id)
    closeSftp(id)
    broadcast('session:exit', id, { code, signal })
  })
  sessionManager.on('error', (id, error) =>
    broadcast('session:error', id, serialiseError(error).message)
  )

  // ---- session lifecycle -------------------------------------------------

  ipcMain.handle('session:createSsh', async (_e, payload: SshConnectPayload) => {
    const cols = payload.cols ?? 80
    const rows = payload.rows ?? 24
    const label = payload.title?.trim() || `${payload.username}@${payload.host}`

    // ---- pre-flight ------------------------------------------------------
    // Report a missing or unusable credential as an actionable message instead
    // of letting the connection fail deep inside the handshake, where the error
    // is generic and - for a sidebar click - easy to miss entirely.
    const settings = getSettingsStore().load()
    const store = getCredentials()
    const store_ = getSessionStore()
    const isSavedSession = !!payload.savedSessionId

    // Credentials for a saved session are read here, in the main process, and
    // never travel through the IPC payload. An explicit password in the payload
    // (collected by the connect prompt) wins over the stored one.
    const saved = isSavedSession
      ? store_.load().sessions.find((s) => s.id === payload.savedSessionId)
      : undefined
    const storedCredential = saved ? store.get(saved.id) : {}

    // A saved session with password auth but no stored password is not usable,
    // and neither is the SSH agent as a silent stand-in: on Windows `pageant`
    // always exists as a name, so treating it as a credential would let an
    // unconfigured session try to connect and fail with an opaque error.
    const wantsPassword = !payload.auth.useAgent && !payload.auth.privateKeyPath
    const effectivePassword = payload.auth.password ?? storedCredential.password
    if (wantsPassword && !effectivePassword) {
      return {
        ok: false as const,
        error: {
          code: 'CREDENTIAL_REQUIRED',
          message: isSavedSession
            ? `"${label}" has no saved password. Edit the session to add one, ` +
              'select a private key, or switch it to the SSH agent.'
            : `Enter a password for ${payload.username}@${payload.host}, or choose a key or the agent.`
        }
      }
    }

    // A key path that does not exist can never authenticate; catch the typo
    // before spending a TCP round trip on it.
    if (payload.auth.privateKeyPath) {
      try {
        await access(payload.auth.privateKeyPath, constants.R_OK)
      } catch {
        return {
          ok: false as const,
          error: {
            code: 'KEY_UNREADABLE',
            message: `Cannot read the private key at "${payload.auth.privateKeyPath}". ` +
              'Edit the session and pick the file again.'
          }
        }
      }
    }

    const options: SshConnectOptions = {
      host: payload.host,
      port: payload.port,
      username: payload.username,
      title: payload.title,
      hostKeyPolicy: payload.hostKeyPolicy ?? settings.hostKeys.policy,
      auth: {
        password: effectivePassword,
        privateKeyPath: payload.auth.privateKeyPath,
        passphrase: payload.auth.passphrase ?? storedCredential.passphrase,
        useAgent: payload.auth.useAgent
      }
    }

    const result = await openSsh(options, cols, rows)
    if (result.ok) runPostConnect(result.session.id, payload.postConnectCommands)
    return result
  })

  ipcMain.handle('session:createLocal', async (_e, payload: LocalConnectPayload) => {
    if (!isLocalShellAvailable()) {
      throw new Error('Local shell is unavailable on this machine. Use an SSH connection instead.')
    }

    const cols = payload.cols ?? 80
    const rows = payload.rows ?? 24
    const title = payload.title?.trim() || 'Local Shell'

    const info = await sessionManager.create(
      (_id, c, r) => Promise.resolve(new LocalShellBackend({}, c, r)),
      { kind: 'local', title },
      cols,
      rows
    )
    blueprints.set(info.id, { kind: 'local', title, cols, rows, post: payload.postConnectCommands })
    runPostConnect(info.id, payload.postConnectCommands)

    return { ok: true, session: info }
  })

  /**
   * Open a second connection identical to an existing one.
   *
   * Deliberately not "duplicate the tab": the useful action is another live
   * login to the same box, which then behaves independently. Doing it here
   * rather than in the renderer is what makes it exact — the options (and any
   * password resolved from the vault) never leave this process, so the renderer
   * cannot get the host or the credentials wrong.
   */
  /**
   * Telnet: a bare TCP terminal, no login of our own.
   *
   * Nothing here negotiates credentials, because telnet has none — the login
   * prompt is part of the stream. What `postConnectCommands` is for.
   */
  ipcMain.handle('session:createTelnet', async (_e, payload: TelnetConnectPayload) => {
    const cols = payload.cols ?? 80
    const rows = payload.rows ?? 24
    const title = payload.title?.trim() || `${payload.host}:${payload.port ?? 23}`
    const options: TelnetOptions = { host: payload.host, port: payload.port }

    const info = await sessionManager.create(
      (_id, c, r) => Promise.resolve(new TelnetBackend(options, c, r)),
      { kind: 'telnet', title },
      cols,
      rows
    )
    blueprints.set(info.id, {
      kind: 'telnet',
      options,
      cols,
      rows,
      post: payload.postConnectCommands
    })
    runPostConnect(info.id, payload.postConnectCommands)

    return { ok: true, session: info }
  })

  /**
   * Serial: a console line, for gear that has no network stack at all.
   *
   * A missing `serialport` is reported the same way as a missing node-pty build
   * — as a refused connection with a reason, not as a crash.
   */
  ipcMain.handle('session:createSerial', async (_e, payload: SerialConnectPayload) => {
    if (!isSerialAvailable()) {
      throw new Error(
        'Serial is unavailable in this build: the optional `serialport` module is missing.'
      )
    }

    const cols = payload.cols ?? 80
    const rows = payload.rows ?? 24
    const title = payload.title?.trim() || payload.path
    const options: SerialOptions = {
      path: payload.path,
      baudRate: payload.baudRate,
      dataBits: payload.dataBits,
      parity: payload.parity,
      stopBits: payload.stopBits
    }

    const info = await sessionManager.create(
      (_id, c, r) => Promise.resolve(new SerialBackend(options)),
      { kind: 'serial', title },
      cols,
      rows
    )
    blueprints.set(info.id, {
      kind: 'serial',
      options,
      cols,
      rows,
      post: payload.postConnectCommands
    })
    // Serial lines are already open, so there is no banner to wait for.
    runPostConnect(info.id, payload.postConnectCommands, 300)

    return { ok: true, session: info }
  })

  ipcMain.handle('session:duplicate', async (_e, sourceId: string): Promise<CreateSessionResult> => {
    const blueprint = blueprints.get(sourceId)
    if (!blueprint) {
      return {
        ok: false,
        error: {
          code: 'NOT_DUPLICABLE',
          message: 'This pane has no live connection to duplicate. Reconnect it first.'
        }
      }
    }

    if (blueprint.kind === 'local') {
      const info = await sessionManager.create(
        (_id, c, r) => Promise.resolve(new LocalShellBackend({}, c, r)),
        { kind: 'local', title: blueprint.title },
        blueprint.cols,
        blueprint.rows
      )
      blueprints.set(info.id, { ...blueprint })
      return { ok: true, session: info }
    }

    if (blueprint.kind === 'telnet') {
      const info = await sessionManager.create(
        (_id, c, r) => Promise.resolve(new TelnetBackend(blueprint.options, c, r)),
        { kind: 'telnet', title: blueprint.options.host },
        blueprint.cols,
        blueprint.rows
      )
      blueprints.set(info.id, { ...blueprint })
      runPostConnect(info.id, blueprint.post)
      return { ok: true, session: info }
    }

    if (blueprint.kind === 'serial') {
      const info = await sessionManager.create(
        (_id, c, r) => Promise.resolve(new SerialBackend(blueprint.options)),
        { kind: 'serial', title: blueprint.options.path },
        blueprint.cols,
        blueprint.rows
      )
      blueprints.set(info.id, { ...blueprint })
      runPostConnect(info.id, blueprint.post, 300)
      return { ok: true, session: info }
    }

    return openSsh(blueprint.options, blueprint.cols, blueprint.rows)
  })

  // ---- REST tool ---------------------------------------------------------

  /*
   * Sent from here rather than from the page because the renderer runs on
   * `file://`: a fetch from it is subject to CORS, and the services this tool is
   * for — a local Ollama, an Elasticsearch, a health endpoint — do not send
   * `Access-Control-Allow-Origin`. The renderer still never touches the network
   * directly, which is the same rule every other connection in the app follows.
   */
  ipcMain.handle('rest:send', (_e, request: RestRequest) => sendRestRequest(request))

  ipcMain.handle('rest:loadState', () => getRestStore().load())

  ipcMain.handle('rest:saveState', (_e, state: RestState) => {
    const saved = getRestStore().save(state)
    broadcast('rest:state', saved)
    return saved
  })

  // ---- tunnels -----------------------------------------------------------

  ipcMain.handle('tunnel:list', () => getTunnelManager().list())

  ipcMain.handle('tunnel:save', (_e, specs: TunnelSpec[]) => getTunnelManager().save(specs))

  ipcMain.handle('tunnel:remove', (_e, id: string) => getTunnelManager().remove(id))

  ipcMain.handle('tunnel:start', async (_e, id: string) => getTunnelManager().start(id))

  ipcMain.handle('tunnel:stop', (_e, id: string) => getTunnelManager().stop(id))

  ipcMain.on('session:write', (_e, id: string, data: string) => {
    sessionManager.write(id, data)
  })
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    sessionManager.resize(id, cols, rows)
  )
  ipcMain.on('session:close', (_e, id: string) => {
    blueprints.delete(id)
    closeSftp(id)
    sessionManager.close(id)
  })

  ipcMain.handle('session:list', () => sessionManager.list())
  ipcMain.handle('session:replay', (_e, id: string) => sessionManager.replay(id))

  // ---- command history ---------------------------------------------------
  // Addressed by session id: each session keeps its own file, and a stale one is
  // dropped a week after its last command.

  ipcMain.handle('history:list', (_e, sessionId: string) => getHistoryStore().list(sessionId))
  /** Every session's commands, newest first, for the inline suggestions. */
  ipcMain.handle('history:commands', () => getHistoryStore().globalCommands())
  ipcMain.handle('history:record', (_e, sessionId: string, command: string) => recordCommand(sessionId, command))
  ipcMain.handle('history:sessions', () => getHistoryStore().sessions())
  ipcMain.handle('history:delete', (_e, sessionId: string, id: string) =>
    getHistoryStore().remove(sessionId, id)
  )
  ipcMain.handle('history:clear', (_e, sessionId: string) => getHistoryStore().clear(sessionId))

  // ---- sftp --------------------------------------------------------------
  // Everything is addressed by *session id*: the renderer has no credentials and
  // must not need any, so the main process reuses the connection the pane was
  // opened with.
  const sftpTarget = (
    sessionId: string
  ): Extract<SessionBlueprint, { kind: 'ssh' }> | undefined => {
    const blueprint = blueprints.get(sessionId)
    return blueprint?.kind === 'ssh' ? blueprint : undefined
  }

  ipcMain.handle(
    'sftp:list',
    (_e, sessionId: string, path: string): Promise<SftpListResult> => {
      const target = sftpTarget(sessionId)
      if (!target) {
        return Promise.resolve({
          ok: false,
          message: 'SFTP needs a live SSH session. Connect to a host first.'
        })
      }
      return listDirectory(sessionId, target.options, { knownHosts }, path)
    }
  )

  ipcMain.handle(
    'sftp:download',
    async (_e, sessionId: string, remotePath: string): Promise<SftpTransferResult> => {
      const target = sftpTarget(sessionId)
      if (!target) return { ok: false, message: 'SFTP needs a live SSH session.' }

      const result = await dialog.showSaveDialog({
        title: 'Save remote file',
        defaultPath: remotePath.split('/').pop() ?? 'download'
      })
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
      return downloadFile(sessionId, target.options, { knownHosts }, remotePath, result.filePath)
    }
  )

  ipcMain.handle(
    'sftp:upload',
    async (_e, sessionId: string, remoteDir: string): Promise<SftpTransferResult> => {
      const target = sftpTarget(sessionId)
      if (!target) return { ok: false, message: 'SFTP needs a live SSH session.' }

      const result = await dialog.showOpenDialog({
        title: 'Upload a file',
        properties: ['openFile', 'showHiddenFiles']
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true }
      return uploadFile(sessionId, target.options, { knownHosts }, result.filePaths[0], remoteDir)
    }
  )

  // ---- host keys ---------------------------------------------------------

  ipcMain.handle('hostkey:trust', (_e, request: TrustHostKeyRequest) => {
    const { host, port, keyType, keyData } = request
    // Fail loudly on a malformed request instead of writing a junk entry.
    if (!host || !keyType || !keyData) {
      throw new Error(
        `Refusing to store an incomplete host key (host=${host}, keyType=${keyType}, ` +
          `keyData=${keyData ? keyData.length + ' chars' : 'missing'})`
      )
    }
    knownHosts.trust(host, port, `${keyType} ${keyData}`)
    return true
  })

  ipcMain.handle('hostkey:forget', (_e, host: string, port: number) => knownHosts.forget(host, port))

  ipcMain.handle('hostkey:list', () => knownHosts.list())

  ipcMain.handle('hostkey:removeAt', (_e, file: string, line: number) => {
    knownHosts.removeAt(file, line)
    return knownHosts.list()
  })

  /**
   * Remove several entries in one pass.
   *
   * Batch rather than a loop of `removeAt` from the renderer: line numbers are
   * positions, so removing them one at a time deletes the wrong keys unless the
   * caller works from the bottom up — and it would rewrite the file once per entry.
   */
  ipcMain.handle('hostkey:removeMany', (_e, entries: { file: string; line: number }[]) => {
    knownHosts.removeMany(Array.isArray(entries) ? entries : [])
    return knownHosts.list()
  })

  // ---- saved sessions ----------------------------------------------------

  /**
   * Every mutation broadcasts the new tree. Without this, a change made through
   * any path other than the component's own callback leaves the sidebar showing
   * stale data, since the renderer cannot observe the store directly.
   *
   * Sessions are decorated with `hasPassword`/`hasPassphrase` so the UI can show
   * that a secret exists without the secret ever leaving the main process.
   */
  const withCredentialFlags = (tree: SessionTree): SessionTree => {
    const store = getCredentials()
    return {
      ...tree,
      sessions: tree.sessions.map((session) => {
        const has = store.has(session.id)
        return { ...session, hasPassword: has.password, hasPassphrase: has.passphrase }
      })
    }
  }

  const commitTree = (tree: SessionTree): SessionTree => {
    const decorated = withCredentialFlags(tree)
    broadcast('tree:changed', decorated)
    broadcast('tree:tags', getSessionStore().allTags())
    return decorated
  }

  ipcMain.handle('tree:load', () => withCredentialFlags(getSessionStore().load()))
  ipcMain.handle('tree:allTags', () => getSessionStore().allTags())

  /**
   * Saving a session also carries its credentials, which are encrypted and kept
   * in a separate file so the session tree itself never holds a secret.
   */
  ipcMain.handle(
    'tree:saveSession',
    (
      _e,
      session: Partial<SavedSession> & {
        host: string
        credential?: { password?: string; passphrase?: string }
        copyCredentialFrom?: string
      }
    ) => {
      const store = getSessionStore()
      // The credential extras are this handler's business; the store only sees
      // session fields.
      const { credential, copyCredentialFrom, ...sessionFields } = session
      const tree = store.upsertSession(sessionFields)

      // Resolve the id: a new session gets one assigned by the store.
      const saved =
        (session.id && tree.sessions.find((s) => s.id === session.id)) ??
        tree.sessions.find(
          (s) => s.host === session.host && s.username === (session.username ?? 'root')
        )

      if (saved) {
        if (credential) {
          // Only touch the credential store when the editor actually sent
          // values; the store merges, so an omitted key keeps the stored secret
          // and an empty string clears it.
          getCredentials().set(saved.id, {
            password: credential.password,
            passphrase: credential.passphrase
          })
        } else if (copyCredentialFrom && copyCredentialFrom !== saved.id) {
          // Duplicating: carry the encrypted secret across, decrypted only in
          // this process and re-sealed under the new session id.
          const source = getCredentials().get(copyCredentialFrom)
          if (source.password || source.passphrase) getCredentials().set(saved.id, source)
        }
      }

      return commitTree(tree)
    }
  )

  /**
   * Save several sessions at once, for the batch "add hosts" form.
   *
   * One write and one tree broadcast instead of one of each per host. The same
   * password is sealed under every new session's own id — that is what a shared
   * password means here — so a host that turns out to want a different one is
   * fixed on its own later, without touching the rest.
   */
  ipcMain.handle(
    'tree:saveSessions',
    (
      _e,
      batch: {
        sessions: Array<Partial<SavedSession> & { host: string }>
        credential?: { password?: string }
      }
    ) => {
      const { tree, sessions } = getSessionStore().addSessions(batch.sessions ?? [])
      const password = batch.credential?.password
      if (password) {
        for (const session of sessions) getCredentials().set(session.id, { password })
      }
      return commitTree(tree)
    }
  )

  ipcMain.handle('tree:deleteSession', (_e, id: string) => {
    // Leave no orphaned secret behind.
    getCredentials().remove(id)
    return commitTree(getSessionStore().deleteSession(id))
  })
  ipcMain.handle('tree:moveSession', (_e, id: string, parentId: string | null) =>
    commitTree(getSessionStore().moveSession(id, parentId))
  )
  ipcMain.handle('tree:saveFolder', (_e, folder: Partial<SessionFolder> & { name: string }) =>
    commitTree(getSessionStore().upsertFolder(folder))
  )
  ipcMain.handle('tree:deleteFolder', (_e, id: string) =>
    commitTree(getSessionStore().deleteFolder(id))
  )
  ipcMain.handle('tree:moveFolder', (_e, id: string, parentId: string | null) =>
    commitTree(getSessionStore().moveFolder(id, parentId))
  )

  // ---- credentials -------------------------------------------------------
  // Secrets are written and read only here.

  ipcMain.handle('credential:status', () => getCredentials().status())

  /** Reveal a stored password for the session editor's reveal button. */
  ipcMain.handle('credential:reveal', (_e, sessionId: string) =>
    getCredentials().revealPassword(sessionId) ?? null
  )

  ipcMain.handle('credential:clear', (_e, sessionId: string) => {
    getCredentials().remove(sessionId)
    return commitTree(getSessionStore().load())
  })

  // ---- fonts -------------------------------------------------------------

  /**
   * Enumerated once and cached for the session: it is a slow platform call and
   * the answer does not change while the app runs.
   */
  let fontChoices: FontChoices | null = null
  ipcMain.handle('fonts:list', async (): Promise<FontChoices> => {
    fontChoices ??= await listFontChoices()
    return fontChoices
  })

  // ---- sharing saved hosts -----------------------------------------------

  /**
   * Export the saved hosts for someone else.
   *
   * The dialog lives here, so the renderer hands over a passphrase and nothing
   * else. `filePath` exists for tests: with it the dialog is skipped, which is the
   * only way a probe can drive an export without a human clicking Save.
   */
  ipcMain.handle(
    'share:export',
    async (event, request: ShareExportRequest): Promise<ShareExportResult> => {
      let target = request.filePath
      if (!target) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const stamp = new Date().toISOString().slice(0, 10)
        const result = await dialog.showSaveDialog(win ?? undefined!, {
          title: 'Export saved hosts',
          defaultPath: `termdeck-hosts-${stamp}.tdshare`,
          filters: [
            { name: 'TermDeck share', extensions: ['tdshare'] },
            { name: 'All files', extensions: ['*'] }
          ]
        })
        if (result.canceled || !result.filePath) return { ok: false, cancelled: true }
        target = result.filePath
      }

      const doc = buildShareDocument(getSessionStore().load(), (id) => getCredentials().get(id), {
        includeCredentials: request.includeCredentials,
        app: `TermDeck ${app.getVersion()}`
      })

      try {
        const bytes = packShare(doc, request.passphrase)
        await writeFile(target, bytes)
        return {
          ok: true,
          path: target,
          sessions: doc.sessions.length,
          folders: doc.folders.length,
          withPasswords: Object.values(doc.credentials).filter((c) => !!c.password).length,
          bytes: bytes.length
        }
      } catch (err) {
        if (err instanceof ShareError) return { ok: false, message: err.message }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** Pick a share file to import. */
  ipcMain.handle('share:pick', async (event): Promise<SharePickResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Import saved hosts',
      properties: ['openFile'],
      filters: [
        { name: 'TermDeck share', extensions: ['tdshare'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true }
    return { ok: true, filePath: result.filePaths[0] }
  })

  /**
   * Decrypt a share file and report what importing it would do, without writing
   * anything: the numbers in the dialog and the numbers the import produces come
   * from the same plan.
   */
  ipcMain.handle(
    'share:peek',
    async (_e, request: { filePath: string; passphrase: string }): Promise<SharePeekResult> => {
      try {
        const doc = unpackShare(await readFile(request.filePath), request.passphrase)
        const plan = planImport(doc, getSessionStore().load())
        return {
          ok: true,
          filePath: request.filePath,
          preview: {
            app: doc.app,
            exportedAt: doc.exportedAt,
            sessions: doc.sessions.length,
            folders: doc.folders.length,
            duplicates: plan.duplicates.length,
            withPasswords: plan.credentials.filter((entry) => !!entry.password).length,
            hasCredentials: Object.keys(doc.credentials).length > 0
          }
        }
      } catch (err) {
        if (err instanceof ShareError) return { ok: false, message: err.message }
        // A missing file is the common case here and deserves its own sentence.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return { ok: false, message: 'That file is no longer there.' }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** Import: create the groups and sessions the plan describes, in one write. */
  ipcMain.handle(
    'share:import',
    async (_e, request: ShareImportRequest): Promise<ShareImportResult> => {
      try {
        const doc = unpackShare(await readFile(request.filePath), request.passphrase)
        const plan = planImport(doc, getSessionStore().load(), {
          folderId: request.folderId ?? null,
          skipCredentials: request.skipCredentials
        })
        const tree = getSessionStore().importShare(plan)
        // Secrets are re-sealed under the ids minted here, so the file's ids never
        // reach the local credential store.
        getCredentials().setMany(plan.credentials)
        return { ok: true, tree: commitTree(tree), summary: summariseImport(plan) }
      } catch (err) {
        if (err instanceof ShareError) return { ok: false, message: err.message }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- data directory ----------------------------------------------------

  /**
   * Where the app keeps its data, and how to move it.
   *
   * The welcome page asks before anything has been created, which is the cheap
   * moment to move: there is nothing to migrate, and no session is holding a file
   * open. Changing it restarts the app, because every store is constructed around
   * the directory at start-up.
   */
  ipcMain.handle('data:directory', (): DataDirectoryStatus => {
    const defaultDir = app.getPath('userData')
    const current = configDir()
    return { current, default: defaultDir, moved: current !== defaultDir }
  })

  ipcMain.handle(
    'data:pickDirectory',
    async (event): Promise<string | null> => {
      // A fresh window rather than a parent: this can run before the shell has
      // finished showing, and a modal with no parent is still a modal.
      const win = BrowserWindow.fromWebContents(event.sender)
      const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
        title: 'Choose where TermDeck keeps its data',
        properties: ['openDirectory', 'createDirectory']
      })
      if (canceled || filePaths.length === 0) return null
      return filePaths[0]
    }
  )

  ipcMain.handle(
    'data:setDirectory',
    (_e, request: DataDirectoryRequest): DataDirectoryResult => {
      try {
        const defaultDir = app.getPath('userData')
        const target = request.dir?.trim() ?? ''
        if (!target) {
          // Back to the default, keeping whatever is already there.
          writePointer(defaultDir, null)
          return { ok: true, directory: defaultDir, moved: [], restartRequired: true }
        }
        // Creating it here turns "the folder does not exist / is not writable"
        // into an error the dialog can show, instead of a store that fails later.
        mkdirSync(target, { recursive: true })
        const result = request.move ? copyData(configDir(), target) : { copied: [], missing: [] }
        writePointer(defaultDir, target)
        return { ok: true, directory: target, moved: result.copied, restartRequired: true }
      } catch (err) {
        return {
          ok: false,
          directory: configDir(),
          moved: [],
          restartRequired: false,
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )

  /** Relaunch, for a change that can only take effect at start-up. */
  ipcMain.handle('data:restart', () => {
    app.relaunch()
    app.exit(0)
  })

  // ---- files -------------------------------------------------------------

  /**
   * Save text to a file the user picks. The renderer sends the content and a
   * suggested name; the main process owns the dialog and the write, so the
   * renderer never needs filesystem access.
   */
  ipcMain.handle(
    'file:saveText',
    async (event, request: SaveTextFileRequest): Promise<SaveTextFileResult> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined!, {
        title: 'Save terminal output',
        defaultPath: request.suggestedName,
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'Log', extensions: ['log'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: false, cancelled: true }
      try {
        await writeFile(filePath, request.content, 'utf8')
        return { ok: true, path: filePath }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- interface scale ---------------------------------------------------

  /**
   * Applied in the main process because `setZoomFactor` lives on webContents and
   * is the one mechanism that scales every measurement together — rail, side bar,
   * dialogs and terminal font. Electron does not persist it across a reload, so
   * the renderer re-sends the stored value on load and on every change.
   */
  ipcMain.handle('ui:setScale', (event, scale: number) => {
    const next = clampScale(scale)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(next)
    return next
  })

  // ---- layout ------------------------------------------------------------

  ipcMain.handle('layout:load', () => getLayoutStore().load())
  ipcMain.handle('layout:save', (_e, next: Partial<LayoutState>) => getLayoutStore().save(next))

  // ---- settings ----------------------------------------------------------

  ipcMain.handle('settings:load', () => getSettingsStore().load())
  ipcMain.handle('settings:save', (_e, next: AppSettings) => {
    const saved = getSettingsStore().save(next)
    // The renderer holds a copy for live use (terminal appearance, clipboard
    // behaviour, shortcuts). Broadcasting keeps every window in step when
    // settings change from anywhere, rather than silently diverging.
    broadcast('settings:changed', saved)
    return saved
  })

  // ---- snippets ----------------------------------------------------------

  const commitSettings = (next: AppSettings): AppSettings => {
    broadcast('settings:changed', next)
    return next
  }

  ipcMain.handle(
    'snippet:save',
    (_e, snippet: Partial<Snippet> & { label: string; command: string }) =>
      commitSettings(getSettingsStore().saveSnippet(snippet))
  )
  ipcMain.handle('snippet:delete', (_e, id: string) =>
    commitSettings(getSettingsStore().deleteSnippet(id))
  )
  ipcMain.handle('snippet:reorder', (_e, ids: string[]) =>
    commitSettings(getSettingsStore().reorderSnippets(ids))
  )

  // ---- platform helpers --------------------------------------------------

  ipcMain.handle('app:pickPrivateKey', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select a private key',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('app:copyToClipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('app:readClipboard', () => clipboard.readText())

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    localShellAvailable: isLocalShellAvailable(),
    configDir: configDir()
  }))

  // ---- lock screen -------------------------------------------------------
  // The password lives in the encrypted vault under a reserved id. The renderer
  // can set it and check it, never read it.

  ipcMain.handle('lock:status', () => lockStatus())

  ipcMain.handle('lock:save', (_e, request: SaveLockRequest) => {
    if (request.password === null) getCredentials().remove(LOCK_CREDENTIAL_ID)
    else if (typeof request.password === 'string') {
      // An empty string is a legitimate value: the lock screen then unlocks on a
      // click, with no password to remember.
      getCredentials().set(LOCK_CREDENTIAL_ID, { password: request.password })
    }
    return lockStatus()
  })

  ipcMain.handle('lock:verify', (_e, password: string) => {
    const stored = getCredentials().get(LOCK_CREDENTIAL_ID).password ?? ''
    // A constant-time compare is not a real defence here (this is a convenience
    // lock, not disk encryption) but there is no reason to leak the prefix.
    return sameSecret(stored, typeof password === 'string' ? password : '')
  })
}

/** Exposed for the smoke harnesses, which need the same stores the app uses. */
export function storeAccess(): {
  credentials: CredentialStore
  settings: SettingsStore
  sessions: SessionStore
  layout: LayoutStore
  knownHosts: KnownHosts
  history: HistoryStore
  configDir: string
} {
  return {
    credentials: getCredentials(),
    settings: getSettingsStore(),
    sessions: getSessionStore(),
    layout: getLayoutStore(),
    knownHosts,
    history: getHistoryStore(),
    configDir: configDir()
  }
}
