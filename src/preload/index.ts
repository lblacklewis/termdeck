import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  AppInfo,
  CreateSessionResult,
  CredentialStatus,
  FontChoices,
  KnownHostEntry,
  LayoutState,
  LocalConnectPayload,
  SavedSession,
  SaveTextFileRequest,
  SaveTextFileResult,
  SessionExitInfo,
  SessionFolder,
  SessionInfo,
  SessionTree,
  Snippet,
  SshConnectPayload,
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

  removeKnownHostEntry: (file: string, line: number): Promise<KnownHostEntry[]> =>
    ipcRenderer.invoke('hostkey:removeAt', file, line),

  // ---- saved sessions ---------------------------------------------------
  loadSessionTree: (): Promise<SessionTree> => ipcRenderer.invoke('tree:load'),
  allTags: (): Promise<string[]> => ipcRenderer.invoke('tree:allTags'),
  saveSession: (
    session: Partial<SavedSession> & {
      host: string
      credential?: { password?: string; passphrase?: string }
    }
  ): Promise<SessionTree> => ipcRenderer.invoke('tree:saveSession', session),
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

  // ---- events -----------------------------------------------------------
  onSessionData: (handler: (id: string, chunk: string, seq: number) => void): (() => void) =>
    on<[string, string, number]>('session:data', handler),

  onSessionExit: (handler: (id: string, info: SessionExitInfo) => void): (() => void) =>
    on<[string, SessionExitInfo]>('session:exit', handler),

  onSessionError: (handler: (id: string, message: string) => void): (() => void) =>
    on<[string, string]>('session:error', handler),

  onSettingsChanged: (handler: (settings: AppSettings) => void): (() => void) =>
    on<[AppSettings]>('settings:changed', handler),

  onTreeChanged: (handler: (tree: SessionTree) => void): (() => void) =>
    on<[SessionTree]>('tree:changed', handler),

  onTagsChanged: (handler: (tags: string[]) => void): (() => void) =>
    on<[string[]]>('tree:tags', handler)
}

contextBridge.exposeInMainWorld('termdeck', api)
