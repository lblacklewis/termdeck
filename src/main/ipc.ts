import { app, BrowserWindow, dialog, ipcMain, clipboard } from 'electron'
import { access, constants, writeFile } from 'node:fs/promises'

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
import { clampScale, SettingsStore, SessionStore } from './store/Stores'
import { KnownHosts } from './ssh/KnownHosts'
import type {
  AppSettings,
  FontChoices,
  LayoutState,
  SavedSession,
  SaveTextFileRequest,
  SaveTextFileResult,
  SessionFolder,
  SessionTree,
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
  prompt?: unknown
} {
  if (err instanceof HostKeyRequiredError) {
    return { message: err.message, code: err.code, prompt: err.prompt }
  }
  return { message: err instanceof Error ? err.message : String(err) }
}

export function registerIpc(): void {
  sessionManager.on('data', (id, chunk, seq) => broadcast('session:data', id, chunk, seq))
  sessionManager.on('exit', (id, code, signal) => broadcast('session:exit', id, { code, signal }))
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

    const deps = { knownHosts }

    const info = await sessionManager.create(
      (_id, c, r) => Promise.resolve(new SshShellBackend(options, c, r, deps)),
      { kind: 'ssh', title: label },
      cols,
      rows
    )

    // A host-key rejection arrives asynchronously, so wait briefly for either
    // the first output (success) or a failure before reporting to the renderer.
    return await new Promise((resolve) => {
      let settled = false
      const done = (value: unknown): void => {
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

    return { ok: true, session: info }
  })

  ipcMain.on('session:write', (_e, id: string, data: string) => sessionManager.write(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    sessionManager.resize(id, cols, rows)
  )
  ipcMain.on('session:close', (_e, id: string) => sessionManager.close(id))

  ipcMain.handle('session:list', () => sessionManager.list())
  ipcMain.handle('session:replay', (_e, id: string) => sessionManager.replay(id))

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
}

/** Exposed for the smoke harnesses, which need the same stores the app uses. */
export function storeAccess(): {
  credentials: CredentialStore
  settings: SettingsStore
  sessions: SessionStore
  layout: LayoutStore
  knownHosts: KnownHosts
  configDir: string
} {
  return {
    credentials: getCredentials(),
    settings: getSettingsStore(),
    sessions: getSessionStore(),
    layout: getLayoutStore(),
    knownHosts,
    configDir: configDir()
  }
}
