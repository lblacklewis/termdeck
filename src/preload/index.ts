import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  AppInfo,
  CreateSessionResult,
  CredentialStatus,
  FontChoices,
  HistoryEntry,
  HistorySessionSummary,
  KnownHostEntry,
  LayoutState,
  LocalConnectPayload,
  SerialConnectPayload,
  TelnetConnectPayload,
  LockStatus,
  QuitRequest,
  SaveLockRequest,
  SavedSession,
  SaveTextFileRequest,
  SaveTextFileResult,
  SessionExitInfo,
  SessionFolder,
  SessionInfo,
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
  SftpListResult,
  SftpTransferResult,
  Snippet,
  SshConnectPayload,
  RestRequest,
  RestResponse,
  RestState,
  TunnelSpec,
  TunnelState,
  TrustHostKeyRequest
} from '@shared/types'

export type { TermDeckApi } from '@shared/types'

/** Subscribe helper that returns an unsubscribe function. */
function on<T extends unknown[]>(channel: string, handler: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => handler(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // ---- sessions ---------------------------------------------------------
  createSshSession: (payload: SshConnectPayload): Promise<CreateSessionResult> =>
    ipcRenderer.invoke('session:createSsh', payload),

  createLocalSession: (payload: LocalConnectPayload): Promise<CreateSessionResult> =>
    ipcRenderer.invoke('session:createLocal', payload),

  createTelnetSession: (payload: TelnetConnectPayload): Promise<CreateSessionResult> =>
    ipcRenderer.invoke('session:createTelnet', payload),

  createSerialSession: (payload: SerialConnectPayload): Promise<CreateSessionResult> =>
    ipcRenderer.invoke('session:createSerial', payload),

  duplicateSession: (sourceId: string): Promise<CreateSessionResult> =>
    ipcRenderer.invoke('session:duplicate', sourceId),

  writeSession: (id: string, data: string): void => ipcRenderer.send('session:write', id, data),

  resizeSession: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('session:resize', id, cols, rows),

  closeSession: (id: string): void => ipcRenderer.send('session:close', id),

  listSessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke('session:list'),

  replaySession: (id: string): Promise<{ data: string; seq: number } | null> =>
    ipcRenderer.invoke('session:replay', id),

  // ---- host keys --------------------------------------------------------
  trustHostKey: (request: TrustHostKeyRequest): Promise<boolean> =>
    ipcRenderer.invoke('hostkey:trust', request),

  forgetHostKey: (host: string, port: number): Promise<number> =>
    ipcRenderer.invoke('hostkey:forget', host, port),

  listKnownHosts: (): Promise<KnownHostEntry[]> => ipcRenderer.invoke('hostkey:list'),
  globalCommandHistory: (): Promise<string[]> => ipcRenderer.invoke('history:commands'),
  recordCommand: (sessionId: string, command: string): Promise<void> =>
    ipcRenderer.invoke('history:record', sessionId, command),

  removeKnownHostEntry: (file: string, line: number): Promise<KnownHostEntry[]> =>
    ipcRenderer.invoke('hostkey:removeAt', file, line),
  removeKnownHostEntries: (
    entries: { file: string; line: number }[]
  ): Promise<KnownHostEntry[]> => ipcRenderer.invoke('hostkey:removeMany', entries),

  // ---- saved sessions ---------------------------------------------------
  loadSessionTree: (): Promise<SessionTree> => ipcRenderer.invoke('tree:load'),
  allTags: (): Promise<string[]> => ipcRenderer.invoke('tree:allTags'),
  saveSession: (
    session: Partial<SavedSession> & {
      host: string
      credential?: { password?: string; passphrase?: string }
    }
  ): Promise<SessionTree> => ipcRenderer.invoke('tree:saveSession', session),
  /** Add several sessions in one write; the shared password lands on each of them. */
  saveSessions: (batch: {
    sessions: Array<Partial<SavedSession> & { host: string }>
    credential?: { password?: string }
  }): Promise<SessionTree> => ipcRenderer.invoke('tree:saveSessions', batch),
  deleteSession: (id: string): Promise<SessionTree> => ipcRenderer.invoke('tree:deleteSession', id),
  moveSession: (id: string, parentId: string | null): Promise<SessionTree> =>
    ipcRenderer.invoke('tree:moveSession', id, parentId),
  saveFolder: (folder: Partial<SessionFolder> & { name: string }): Promise<SessionTree> =>
    ipcRenderer.invoke('tree:saveFolder', folder),
  deleteFolder: (id: string): Promise<SessionTree> => ipcRenderer.invoke('tree:deleteFolder', id),
  moveFolder: (id: string, parentId: string | null): Promise<SessionTree> =>
    ipcRenderer.invoke('tree:moveFolder', id, parentId),

  // ---- credentials ------------------------------------------------------
  credentialStatus: (): Promise<CredentialStatus> => ipcRenderer.invoke('credential:status'),
  revealCredential: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('credential:reveal', sessionId),
  clearCredential: (sessionId: string): Promise<SessionTree> =>
    ipcRenderer.invoke('credential:clear', sessionId),

  // ---- interface scale --------------------------------------------------
  setUiScale: (scale: number): Promise<number> => ipcRenderer.invoke('ui:setScale', scale),

  // ---- sharing saved hosts ----------------------------------------------
  /** Without `filePath` the main process opens its own save dialog. */
  exportShare: (request: ShareExportRequest): Promise<ShareExportResult> =>
    ipcRenderer.invoke('share:export', request),
  pickShareFile: (): Promise<SharePickResult> => ipcRenderer.invoke('share:pick'),
  peekShare: (filePath: string, passphrase: string): Promise<SharePeekResult> =>
    ipcRenderer.invoke('share:peek', { filePath, passphrase }),
  importShare: (request: ShareImportRequest): Promise<ShareImportResult> =>
    ipcRenderer.invoke('share:import', request),

  dataDirectory: (): Promise<DataDirectoryStatus> => ipcRenderer.invoke('data:directory'),
  pickDataDirectory: (): Promise<string | null> => ipcRenderer.invoke('data:pickDirectory'),
  setDataDirectory: (request: DataDirectoryRequest): Promise<DataDirectoryResult> =>
    ipcRenderer.invoke('data:setDirectory', request),
  restartApp: (): Promise<void> => ipcRenderer.invoke('data:restart'),

  // ---- fonts ------------------------------------------------------------
  listFonts: (): Promise<FontChoices> => ipcRenderer.invoke('fonts:list'),

  // ---- files ------------------------------------------------------------
  saveTextFile: (request: SaveTextFileRequest): Promise<SaveTextFileResult> =>
    ipcRenderer.invoke('file:saveText', request),

  // ---- layout -----------------------------------------------------------
  loadLayout: (): Promise<LayoutState> => ipcRenderer.invoke('layout:load'),
  saveLayout: (layout: Partial<LayoutState>): Promise<LayoutState> =>
    ipcRenderer.invoke('layout:save', layout),

  // ---- settings ---------------------------------------------------------
  loadSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:save', settings),

  // ---- snippets ---------------------------------------------------------
  saveSnippet: (snippet: Partial<Snippet> & { label: string; command: string }): Promise<AppSettings> =>
    ipcRenderer.invoke('snippet:save', snippet),
  deleteSnippet: (id: string): Promise<AppSettings> => ipcRenderer.invoke('snippet:delete', id),
  reorderSnippets: (ids: string[]): Promise<AppSettings> =>
    ipcRenderer.invoke('snippet:reorder', ids),

  // ---- platform helpers -------------------------------------------------
  pickPrivateKey: (): Promise<string | null> => ipcRenderer.invoke('app:pickPrivateKey'),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('app:copyToClipboard', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('app:readClipboard'),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  // ---- quit -------------------------------------------------------------
  // Confirming a pending quit. The window close itself is held in main.
  quitApp: (): void => ipcRenderer.send('app:quit'),

  // ---- focus mode -------------------------------------------------------
  setFullScreen: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setFullScreen', on),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('app:isFullScreen'),

  // ---- lock screen ------------------------------------------------------
  lockStatus: (): Promise<LockStatus> => ipcRenderer.invoke('lock:status'),
  saveLock: (request: SaveLockRequest): Promise<LockStatus> =>
    ipcRenderer.invoke('lock:save', request),
  verifyLock: (password: string): Promise<boolean> =>
    ipcRenderer.invoke('lock:verify', password),

  // ---- command history --------------------------------------------------
  // One file per session; every call names the session it is about.
  listHistory: (sessionId: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke('history:list', sessionId),
  historySessions: (): Promise<HistorySessionSummary[]> =>
    ipcRenderer.invoke('history:sessions'),
  deleteHistoryEntry: (sessionId: string, id: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke('history:delete', sessionId, id),
  clearHistory: (sessionId: string): Promise<HistoryEntry[]> =>
    ipcRenderer.invoke('history:clear', sessionId),

  // ---- sftp -------------------------------------------------------------
  sftpList: (sessionId: string, path: string): Promise<SftpListResult> =>
    ipcRenderer.invoke('sftp:list', sessionId, path),
  sftpDownload: (sessionId: string, remotePath: string): Promise<SftpTransferResult> =>
    ipcRenderer.invoke('sftp:download', sessionId, remotePath),
  sftpUpload: (sessionId: string, remoteDir: string): Promise<SftpTransferResult> =>
    ipcRenderer.invoke('sftp:upload', sessionId, remoteDir),

  // ---- events -----------------------------------------------------------
  onSessionData: (handler: (id: string, chunk: string, seq: number) => void): (() => void) =>
    on<[string, string, number]>('session:data', handler),
  onQuitRequested: (handler: (request: QuitRequest) => void): (() => void) =>
    on<[QuitRequest]>('app:quit-requested', handler),
  /** Full-screen state, including changes the app did not initiate. */
  onFullScreenChanged: (handler: (on: boolean) => void): (() => void) =>
    on<[boolean]>('app:focus-mode', handler),
  onHistoryChanged: (
    handler: (change: { sessionId: string; entries: HistoryEntry[] }) => void
  ): (() => void) => on<[{ sessionId: string; entries: HistoryEntry[] }]>('history:changed', handler),
  onSessionExit: (handler: (id: string, info: SessionExitInfo) => void): (() => void) =>
    on<[string, SessionExitInfo]>('session:exit', handler),

  onSessionError: (handler: (id: string, message: string) => void): (() => void) =>
    on<[string, string]>('session:error', handler),

  onSettingsChanged: (handler: (settings: AppSettings) => void): (() => void) =>
    on<[AppSettings]>('settings:changed', handler),

  onTreeChanged: (handler: (tree: SessionTree) => void): (() => void) =>
    on<[SessionTree]>('tree:changed', handler),

  onTagsChanged: (handler: (tags: string[]) => void): (() => void) =>
    on<[string[]]>('tree:tags', handler),

  // ---- REST tool ---------------------------------------------------------

  sendRestRequest: (request: RestRequest): Promise<RestResponse> =>
    ipcRenderer.invoke('rest:send', request),

  loadRestState: (): Promise<RestState> => ipcRenderer.invoke('rest:loadState'),

  saveRestState: (state: RestState): Promise<RestState> =>
    ipcRenderer.invoke('rest:saveState', state),

  onRestStateChanged: (handler: (state: RestState) => void): (() => void) =>
    on<[RestState]>('rest:state', handler),

  // ---- tunnels -----------------------------------------------------------

  listTunnels: (): Promise<TunnelState[]> => ipcRenderer.invoke('tunnel:list'),

  saveTunnels: (specs: TunnelSpec[]): Promise<TunnelState[]> =>
    ipcRenderer.invoke('tunnel:save', specs),

  removeTunnel: (id: string): Promise<TunnelState[]> => ipcRenderer.invoke('tunnel:remove', id),

  startTunnel: (id: string): Promise<TunnelState[]> => ipcRenderer.invoke('tunnel:start', id),

  stopTunnel: (id: string): Promise<TunnelState[]> => ipcRenderer.invoke('tunnel:stop', id),

  onTunnelsChanged: (handler: (tunnels: TunnelState[]) => void): (() => void) =>
    on<[TunnelState[]]>('tunnel:changed', handler)
}

contextBridge.exposeInMainWorld('termdeck', api)
