import { app, BrowserWindow, dialog, ipcMain, clipboard } from 'electron'
import { access, constants, writeFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'

import { sessionManager } from './sessions/SessionManager'
import { LocalShellBackend, isLocalShellAvailable } from './sessions/LocalShellBackend'
import {
  SshShellBackend,
  HostKeyRequiredError,
  type SshConnectOptions
} from './sessions/SshShellBackend'
import { CredentialStore } from './store/CredentialStore'
import { LayoutStore } from './store/LayoutStore'
import { listFontChoices } from './fonts'
import { clampScale, HistoryStore, SettingsStore, SessionStore } from './store/Stores'
import { KnownHosts } from './ssh/KnownHosts'
import { closeSftp, downloadFile, listDirectory, uploadFile } from './sftp'
import type {
  AppSettings,
  CreateSessionResult,
  FontChoices,
  HostKeyPrompt,
  LayoutState,
  LockStatus,
  SaveLockRequest,
  SavedSession,
  SaveTextFileRequest,
  SaveTextFileResult,
  SessionFolder,
  SessionTree,
  SftpListResult,
  SftpTransferResult,
  Snippet,
  SshConnectPayload,
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
  | { kind: 'ssh'; options: SshConnectOptions; cols: number; rows: number }
  | { kind: 'local'; title: string; cols: number; rows: number }

const blueprints = new Map<string, SessionBlueprint>()

/**
 * What is being typed into each session, so history records commands.
 *
 * The pty sees a keystroke stream, not lines: arrow keys arrive as escape
 * sequences, backspace as a control byte, and a terminal reply can land in the
 * middle of it. This assembles the line the user actually ran and drops
 * everything else, rather than logging whatever happened to reach the shell.
 */
const typing = new Map<string, { line: string; escape: boolean }>()

/** Commands are recorded on Enter; this is what "Enter" means in a raw stream. */
function noteTypedInput(sessionId: string, data: string): void {
  const state = typing.get(sessionId) ?? { line: '', escape: false }

  for (const ch of data) {
    if (state.escape) {
      // Skip a whole CSI/SS3 sequence: the final byte is a letter or `~`.
      if (/[A-Za-z~]/.test(ch)) state.escape = false
      continue
    }
    if (ch === '\u001b') {
      state.escape = true
      continue
    }
    if (ch === '\r' || ch === '\n') {
      const line = state.line
      state.line = ''
      if (line.trim()) recordCommand(sessionId, line)
      continue
    }
    if (ch === '\u007f' || ch === '\b') {
      state.line = state.line.slice(0, -1)
      continue
    }
    // Ctrl+C abandons the line, Ctrl+U clears it; other control bytes are keys
    // (Tab completion, Ctrl+R, …) rather than text.
    if (ch === '\u0003' || ch === '\u0015') {
      state.line = ''
      continue
    }
    if (ch < ' ') continue
    state.line += ch
  }

  // A pasted wall of text must not grow the buffer without bound.
  if (state.line.length > 4000) state.line = state.line.slice(-4000)
  typing.set(sessionId, state)
}

/** Store one command and tell the UI, unless it was a no-op repeat. */
function recordCommand(sessionId: string, command: string): void {
  const store = getHistoryStore()
  const before = store.list(sessionId).length
  const title = sessionManager.list().find((s) => s.id === sessionId)?.title ?? 'session'
  const entries = store.add(sessionId, title, command)
  if (entries.length !== before) broadcast('history:changed', { sessionId, entries })
}


// Lazily created so `app.getPath('userData')` is available.
let credentials: CredentialStore | null = null
let settingsStore: SettingsStore | null = null
let sessionStore: SessionStore | null = null
let layoutStore: LayoutStore | null = null

/**
 * Host keys are read from the user's real OpenSSH files by default. The
 * environment override exists purely so the verification harnesses can drive
 * trust/mismatch flows without touching the developer's `~/.ssh/known_hosts`.
 */
const knownHosts = process.env['TERMDECK_KNOWN_HOSTS']
  ? new KnownHosts({ paths: [process.env['TERMDECK_KNOWN_HOSTS']] })
  : new KnownHosts()

function configDir(): string {
  return app.getPath('userData')
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

export function registerIpc(): void {
  sessionManager.on('data', (id, chunk, seq) => broadcast('session:data', id, chunk, seq))
  sessionManager.on('exit', (id, code, signal) => {
    // The blueprint describes a live session; drop it with the session so a
    // duplicated pane can never reconnect with options belonging to a dead one,
    // and release the SFTP session that was riding on the same connection.
    blueprints.delete(id)
    typing.delete(id)
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

    return openSsh(options, cols, rows)
  })

  ipcMain.handle('session:createLocal', async (_e, payload: CreateBase & { title?: string }) => {
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
    blueprints.set(info.id, { kind: 'local', title, cols, rows })

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

    return openSsh(blueprint.options, blueprint.cols, blueprint.rows)
  })

  ipcMain.on('session:write', (_e, id: string, data: string) => {
    noteTypedInput(id, data)
    sessionManager.write(id, data)
  })
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    sessionManager.resize(id, cols, rows)
  )
  ipcMain.on('session:close', (_e, id: string) => {
    blueprints.delete(id)
    typing.delete(id)
    closeSftp(id)
    sessionManager.close(id)
  })

  ipcMain.handle('session:list', () => sessionManager.list())
  ipcMain.handle('session:replay', (_e, id: string) => sessionManager.replay(id))

  // ---- command history ---------------------------------------------------
  // Addressed by session id: each session keeps its own file, and a stale one is
  // dropped a week after its last command.

  ipcMain.handle('history:list', (_e, sessionId: string) => getHistoryStore().list(sessionId))
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
