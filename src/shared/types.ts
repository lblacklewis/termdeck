/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this dependency-free so all three can import it.
 */

export type SessionKind = 'local' | 'ssh'

export interface SessionInfo {
  id: string
  kind: SessionKind
  title: string
  cols: number
  rows: number
  /** Epoch ms when the session was created, for the connections window. */
  startedAt: number
}

export type AuthMethod = 'password' | 'key' | 'agent'

export interface SshAuthPayload {
  /**
   * Password supplied for this attempt only. Omitted when the password should
   * come from the saved session's encrypted credential.
   */
  password?: string
  privateKeyPath?: string
  passphrase?: string
  /** Use the SSH agent (Pageant / ssh-agent). */
  useAgent?: boolean
}

export interface SshConnectPayload {
  host: string
  port?: number
  username: string
  title?: string
  cols?: number
  rows?: number
  auth: SshAuthPayload
  /**
   * What to do when the host key is not yet trusted.
   * `ask` aborts the attempt and surfaces the fingerprint to the caller.
   */
  hostKeyPolicy?: 'strict' | 'ask' | 'trust'
  /**
   * Saved session this connection came from. Its stored credentials are read in
   * the main process and never travel through this payload.
   */
  savedSessionId?: string
}

export interface LocalConnectPayload {
  title?: string
  cols?: number
  rows?: number
}

export interface SessionExitInfo {
  code: number | null
  signal: string | null
}

export interface AppInfo {
  platform: string
  versions: { electron: string; node: string; chrome: string }
  localShellAvailable: boolean
  /** Absolute path of the directory holding settings, sessions and the vault. */
  configDir: string
}

// ---- host keys ----------------------------------------------------------

export interface HostKeyPrompt {
  host: string
  port: number
  keyType: string
  /** e.g. `SHA256:AbCd...` */
  fingerprint: string
  /** base64 key blob, so the UI can persist it verbatim on approval. */
  keyData?: string
  /** Populated when a *different* key is already recorded for this host. */
  previousFingerprint?: string
  /** True when known_hosts already has a key that does not match. */
  mismatch: boolean
}

/**
 * A host key to persist. Passed as an object rather than positional arguments:
 * `trustHostKey(host, port, keyType, keyData)` is easy to call with the last two
 * swapped, which silently wrote an unparseable entry instead of failing.
 */
export interface TrustHostKeyRequest {
  host: string
  port: number
  keyType: string
  /** base64 key blob. */
  keyData: string
}

/** Thrown details when a connection is blocked pending host-key approval. */
export interface HostKeyRequiredError {
  code: 'HOST_KEY_REQUIRED'
  prompt: HostKeyPrompt
}

/**
 * Result of asking for a session. Connections report host-key problems and
 * auth failures as data rather than as thrown errors, because the caller needs
 * a fingerprint it can act on.
 */
export type CreateSessionResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; error: { message: string; code?: string; prompt?: HostKeyPrompt } }

// ---- saved sessions ----------------------------------------------------

/**
 * A saved connection.
 *
 * Credentials are NOT part of this object: they live in an encrypted store in
 * the main process and are looked up by `id` when connecting. That keeps
 * secrets out of the session list the renderer receives.
 */
export interface SavedSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  /** True when a password is stored for this session (the value is not sent). */
  hasPassword?: boolean
  /** True when a private-key passphrase is stored for this session. */
  hasPassphrase?: boolean
  /** Free-form labels used for filtering and colouring. */
  tags: string[]
  color?: string
  notes?: string
  /** Folder id, or null when the session sits at the root. */
  parentId: string | null
  createdAt: number
  updatedAt: number
}

/** A folder that may contain sessions and further folders. */
export interface SessionFolder {
  id: string
  name: string
  parentId: string | null
  color?: string
  /** Collapsed state is UI state, persisted for convenience. */
  expanded?: boolean
  createdAt: number
}

export interface SessionTree {
  folders: SessionFolder[]
  sessions: SavedSession[]
}

/** One entry in `known_hosts`, as shown by the Known Hosts page. */
export interface KnownHostEntry {
  /**
   * Hostname when the entry is stored in the clear, or `null` for a hashed
   * entry (OpenSSH hashes them by default and the original cannot be recovered).
   */
  host: string | null
  keyType: string
  /** `SHA256:...` of the stored key. */
  fingerprint: string
  /** Marker prefixes such as `@revoked` or `@cert-authority`. */
  marker?: string
  /** True when the hosts field is a `|1|salt|hash` entry. */
  hashed: boolean
  /** Source file the entry came from. */
  file: string
  line: number
}

/** Rail sections. `settings` opens a drawer rather than a page of its own. */
export type PageId = 'terminal' | 'hosts' | 'known-hosts' | 'snippets' | 'logs' | 'settings'

/** Persisted UI arrangement, restored on launch. */
export interface LayoutState {
  /**
   * dockview's serialised layout, as a JSON string.
   *
   * A string rather than an object because dockview's `toJSON()` result is not
   * structured-cloneable: sending it over IPC directly fails with "An object
   * could not be cloned", which silently loses the layout.
   */
  dockview: string | null
  page: PageId
  sidebarVisible: boolean
  snippetBarVisible: boolean
}

/**
 * What dockview stores per terminal panel.
 *
 * On a restored layout the session no longer exists (nothing is reconnected
 * automatically), so only its title survives and the pane shows a reconnect
 * placeholder until the user acts.
 */
export interface TerminalPanelMeta {
  /** Present for live sessions; absent for restored placeholders. */
  session?: SessionInfo
  /** Title to show when the session is gone. */
  title?: string
  /** Saved session this pane belongs to, for a restored placeholder. */
  savedSessionId?: string
  /** True when restored from a saved layout and not reconnected. */
  disconnected?: boolean
}

/** Save a chunk of text to a file the user picks. */
export interface SaveTextFileRequest {
  /** Pre-filled file name for the save dialog. */
  suggestedName: string
  content: string
}

export type SaveTextFileResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

/** Installed fonts, split so the picker can list monospaced ones first. */
export interface FontChoices {
  monospace: string[]
  others: string[]
}

// ---- credential storage ------------------------------------------------

/**
 * How saved credentials are protected. They are always encrypted at rest; the
 * question is only where the key comes from.
 */
export interface CredentialStatus {
  backend: 'os' | 'local'
  /** Human-readable explanation shown in Settings. */
  detail: string
  encrypted: boolean
  sessionCount: number
  credentialCount: number
}

// ---- themes ------------------------------------------------------------

/**
 * A colour scheme for both the application shell and the terminal.
 *
 * Themes are plain data so they can be added without touching CSS: the renderer
 * turns one into CSS custom properties.
 */
export interface Theme {
  id: string
  name: string
  /** `dark` themes get a light-on-dark terminal, and vice versa. */
  scheme: 'dark' | 'light'
  /** Swatch shown in the settings picker. */
  preview: [string, string, string]
  ui: {
    bg: string
    bgRaised: string
    bgSunken: string
    border: string
    borderStrong: string
    text: string
    textDim: string
    textFaint: string
    accent: string
    accentHover: string
    danger: string
    green: string
    orange: string
    /** Panel tint applied with translucency, e.g. `rgba(255,255,255,.03)`. */
    overlay: string
  }
  terminal: {
    background: string
    foreground: string
    cursor: string
    cursorAccent: string
    selectionBackground: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
}

// ---- settings ----------------------------------------------------------

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  /**
   * Blink period in milliseconds.
   *
   * xterm has no blink-rate option, so the pane drives the animation from this
   * value with its own CSS rather than living with the built-in cadence.
   */
  cursorBlinkMs: number
  scrollback: number
  /**
   * Show a timestamp gutter beside each pane. Times are recorded per line as it
   * is written; they are not persisted, since scrollback is not either.
   */
  showTimestamps: boolean
}

export interface ClipboardSettings {
  /** Left-click (or drag) writes the selection to the OS clipboard. */
  copyOnSelect: boolean
  /** Right-click pastes the clipboard into the terminal. */
  pasteOnRightClick: boolean
  /** Middle-click pastes the primary selection. */
  pasteOnMiddleClick: boolean
  /** Warn before pasting text containing newlines. */
  confirmMultilinePaste: boolean
}

/** A keybinding expressed as `Ctrl+Shift+T` style chords. */
export interface Keybinding {
  id: string
  label: string
  /** Empty string disables the binding. */
  keys: string
  /** Built-in bindings cannot be deleted, only re-bound or cleared. */
  builtin: boolean
}

export interface HostKeySettings {
  policy: 'ask' | 'strict' | 'trust'
}

/**
 * A saved command.
 *
 * The command is sent to the terminal **exactly as written**. Nothing is
 * appended: whether a shell runs it depends on whether the user's text ends with
 * a newline, which is their call rather than ours.
 */
export interface Snippet {
  id: string
  label: string
  /** Sent verbatim. A trailing newline is what makes a shell execute it. */
  command: string
  /** Group name; empty means ungrouped. Groups are created implicitly. */
  group: string
  /** Shown as the button tooltip. */
  description?: string
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  terminal: TerminalSettings
  clipboard: ClipboardSettings
  keybindings: Keybinding[]
  hostKeys: HostKeySettings
  snippets: Snippet[]
  /** Id of the active theme; see `THEMES` in shared/themes. */
  theme: string
}

/** Defaults live in the main process so they have a single source of truth. */
export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: 'newConnection', label: 'New connection', keys: 'Ctrl+T', builtin: true },
  { id: 'closeSession', label: 'Close active session', keys: 'Ctrl+W', builtin: true },
  { id: 'openSettings', label: 'Open settings', keys: 'Ctrl+,', builtin: true },
  { id: 'toggleSidebar', label: 'Toggle sidebar', keys: 'Ctrl+B', builtin: true },
  { id: 'openConnections', label: 'Open connections window', keys: 'Ctrl+Shift+E', builtin: true },
  { id: 'toggleSnippets', label: 'Toggle snippet bar', keys: 'Ctrl+Shift+S', builtin: true },
  {
    id: 'toggleBroadcast',
    label: 'Broadcast input to all panes',
    keys: 'Ctrl+Shift+B',
    builtin: true
  },
  { id: 'copy', label: 'Copy selection', keys: 'Ctrl+Shift+C', builtin: true },
  { id: 'paste', label: 'Paste', keys: 'Ctrl+Shift+V', builtin: true },
  { id: 'nextTab', label: 'Next tab', keys: 'Ctrl+Tab', builtin: true },
  { id: 'prevTab', label: 'Previous tab', keys: 'Ctrl+Shift+Tab', builtin: true }
]

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily:
    '"Cascadia Mono", "JetBrains Mono", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  // Deliberately slower than xterm's own ~0.5s cadence, which reads as a flicker.
  cursorBlinkMs: 900,
  scrollback: 10_000,
  /**
   * On by default. A per-line time column is what makes output auditable, and it
   * is what the reference client (WindTerm) shows; it can be turned off in
   * Settings → Terminal.
   */
  showTimestamps: true
}

export const DEFAULT_CLIPBOARD_SETTINGS: ClipboardSettings = {
  copyOnSelect: true,
  pasteOnRightClick: true,
  pasteOnMiddleClick: true,
  confirmMultilinePaste: true
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  clipboard: DEFAULT_CLIPBOARD_SETTINGS,
  keybindings: DEFAULT_KEYBINDINGS,
  hostKeys: { policy: 'ask' },
  snippets: [],
  theme: 'termius-dark'
}

// ---- renderer bridge ---------------------------------------------------

/** Shape of `window.termdeck`, exposed by the preload script. */
export interface TermDeckApi {
  createSshSession(payload: SshConnectPayload): Promise<CreateSessionResult>
  createLocalSession(payload: LocalConnectPayload): Promise<CreateSessionResult>
  writeSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): void
  closeSession(id: string): void
  listSessions(): Promise<SessionInfo[]>
  replaySession(id: string): Promise<{ data: string; seq: number } | null>

  pickPrivateKey(): Promise<string | null>
  copyToClipboard(text: string): Promise<void>
  readClipboard(): Promise<string>
  appInfo(): Promise<AppInfo>

  // host keys
  trustHostKey(request: TrustHostKeyRequest): Promise<boolean>
  forgetHostKey(host: string, port: number): Promise<number>
  /** Every entry across the configured known_hosts files. */
  listKnownHosts(): Promise<KnownHostEntry[]>
  /** Remove one entry by its file and line number. */
  removeKnownHostEntry(file: string, line: number): Promise<KnownHostEntry[]>

  // saved sessions + folders
  loadSessionTree(): Promise<SessionTree>
  /**
   * Upsert by id. Omitted fields keep their stored value, so callers can send
   * only what changed (e.g. `{ id, name, expanded }` when toggling a folder).
   *
   * `credential` is optional and only applied when present, so renaming a
   * session never clears a stored password. `copyCredentialFrom` duplicates the
   * encrypted secret of another session (used by "Duplicate").
   */
  saveSession(
    session: Partial<SavedSession> & {
      host: string
      credential?: { password?: string; passphrase?: string }
      copyCredentialFrom?: string
    }
  ): Promise<SessionTree>
  deleteSession(id: string): Promise<SessionTree>
  saveFolder(folder: Partial<SessionFolder> & { name: string }): Promise<SessionTree>
  deleteFolder(id: string): Promise<SessionTree>
  moveSession(id: string, parentId: string | null): Promise<SessionTree>
  moveFolder(id: string, parentId: string | null): Promise<SessionTree>
  allTags(): Promise<string[]>

  // credentials (encrypted at rest, never read back into the renderer)
  credentialStatus(): Promise<CredentialStatus>
  /** Explicit reveal, used by the session editor's show-password button. */
  revealCredential(sessionId: string): Promise<string | null>
  clearCredential(sessionId: string): Promise<SessionTree>

  // settings
  loadSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>

  // layout
  loadLayout(): Promise<LayoutState>
  saveLayout(layout: Partial<LayoutState>): Promise<LayoutState>

  // files
  saveTextFile(request: SaveTextFileRequest): Promise<SaveTextFileResult>

  // fonts
  listFonts(): Promise<FontChoices>

  // snippets (stored inside settings so they travel with a settings backup)
  saveSnippet(snippet: Partial<Snippet> & { label: string; command: string }): Promise<AppSettings>
  deleteSnippet(id: string): Promise<AppSettings>
  reorderSnippets(ids: string[]): Promise<AppSettings>

  onSessionData(handler: (id: string, chunk: string, seq: number) => void): () => void
  onSessionExit(handler: (id: string, info: SessionExitInfo) => void): () => void
  onSessionError(handler: (id: string, message: string) => void): () => void
  /** Fires whenever settings are saved, so the UI never runs on stale values. */
  onSettingsChanged(handler: (settings: AppSettings) => void): () => void
  /** Fires on every saved-session or folder mutation. */
  onTreeChanged(handler: (tree: SessionTree) => void): () => void
  onTagsChanged(handler: (tags: string[]) => void): () => void
}
