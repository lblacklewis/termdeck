/**
 * Types shared between the Electron main process, the preload bridge and the
 * renderer. Keep this dependency-free so all three can import it.
 */

/*
 * The one module this file pulls a type from: the S3 tool's surface, which is
 * big enough to be worth reading on its own. It is a type-only import of a
 * sibling shared module, so "dependency-free" still holds — no runtime code, no
 * Node APIs, nothing the renderer cannot also import.
 */
import type { S3Api } from './s3Types'
/*
 * The highlighter's ids and its default rule set. Runtime values rather than types
 * only, for the same reason the sidebar defaults live here: the settings store has to
 * validate a stored file against the same list the renderer draws from.
 */
import {
  DEFAULT_HIGHLIGHT_RULES,
  type HighlightRuleId,
  type HighlightSchemeId
} from './highlight'

export type SessionKind = 'local' | 'ssh' | 'telnet' | 'serial'

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
  /**
   * Lines to run once the session is up, in order (see
   * `SavedSession.postConnectCommands`). Sent by the main process so they reach
   * the shell the same way for every transport.
   */
  postConnectCommands?: string[]
}

export interface LocalConnectPayload {
  title?: string
  cols?: number
  rows?: number
  /** Lines to type into the session once it is up. */
  postConnectCommands?: string[]
}

export interface TelnetConnectPayload {
  host: string
  port?: number
  title?: string
  cols?: number
  rows?: number
  /** Lines to type into the session once it is up. */
  postConnectCommands?: string[]
  savedSessionId?: string
}

export interface SerialConnectPayload {
  /** `COM3` on Windows, `/dev/ttyUSB0` elsewhere. */
  path: string
  baudRate?: number
  dataBits?: 5 | 6 | 7 | 8
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits?: 1 | 2
  title?: string
  cols?: number
  rows?: number
  /** Lines to type into the session once it is up. */
  postConnectCommands?: string[]
  savedSessionId?: string
}

export interface RestHeader {
  name: string
  value: string
}

/** One query parameter, kept beside the URL rather than inside it. */
export interface RestParam {
  name: string
  value: string
  enabled: boolean
}

/** One `application/x-www-form-urlencoded` field. */
export interface RestFormField {
  name: string
  value: string
  enabled: boolean
}

/**
 * How the body is meant.
 *
 * `none`/`json`/`raw` share the text box — `json` is the same text with a Content-Type
 * and a formatter — while `form` has its own key/value table. A request stored before
 * this existed has a body and no mode: the store infers `json` when it parses and
 * `raw` otherwise, so an old saved request keeps behaving the way it did.
 */
export type RestBodyMode = 'none' | 'json' | 'form' | 'raw'

export type RestAuthType = 'none' | 'bearer' | 'basic' | 'apikey'

/**
 * What to send on the way out, as data rather than as a header the user has to know
 * how to write. It becomes a header at send time (see `restAuthHeaders`) — never a
 * second place a header can live.
 */
export interface RestAuth {
  type: RestAuthType
  /** bearer */
  token?: string
  /** basic */
  username?: string
  password?: string
  /** apikey: the header it goes in, and its value. */
  key?: string
  value?: string
}

export interface RestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  /** Query parameters, kept in sync with the URL's own query string. */
  params?: RestParam[]
  headers: RestHeader[]
  bodyMode?: RestBodyMode
  body?: string
  /** The `form` body, when `bodyMode` is `form`. */
  form?: RestFormField[]
  auth?: RestAuth
  /** Give up after this long. Absent uses the default (15s). */
  timeoutMs?: number
  /**
   * Accept a certificate that does not verify. Off by default and deliberately
   * per-request: a self-signed box on the LAN is a normal thing to talk to, and
   * turning verification off for *everything* is how people stop noticing.
   */
  insecure?: boolean
}

/** A folder in the API collection tree. `parentId` null means the top level. */
export interface RestFolder {
  id: string
  name: string
  parentId: string | null
  expanded?: boolean
}

/** A request the user named and kept, now filed in the tree. */
export interface SavedRestRequest {
  id: string
  name: string
  /** The folder it lives in, or null for the top level. */
  folderId?: string | null
  request: RestRequest
}

/** One `{{name}}` environment variable. */
export interface RestVariable {
  name: string
  value: string
  enabled: boolean
}

/**
 * An environment: a named set of variables the request text can refer to.
 *
 * One is active at a time, and switching it changes what `{{name}}` resolves to —
 * which is the whole point: the same request runs against local, staging and
 * production without editing it.
 */
export interface RestEnvironment {
  id: string
  name: string
  variables: RestVariable[]
}

/**
 * How many calls the REST page keeps.
 *
 * Shared because both sides enforce it: the page trims what it adds, and the store trims
 * what it reads and writes — this file is the thing that would otherwise grow without
 * bound, and a bug in the page must not be able to fill the disk.
 */
export const REST_HISTORY_LIMIT = 60

/**
 * One call that was actually made.
 *
 * The full request is kept, not just the URL: the point of the list is to run the same
 * call again — or fix it — without retyping headers and a body. The outcome is kept too,
 * because "this one came back 500 last time" is most of what a history is for.
 */
export interface RestHistoryEntry {
  id: string
  /** When it was sent, ms since epoch. */
  at: number
  request: RestRequest
  status?: number
  ok: boolean
  durationMs: number
}

/**
 * What the REST page restores on open.
 *
 * `draft` is the request that was on screen last, so closing the window in the
 * middle of editing an endpoint does not lose it; `folders` + `saved` are the API
 * collection tree the user built; `environments` + `activeEnvironmentId` are the
 * variable sets `{{name}}` resolves against; `history` is what was sent, newest
 * first, capped. All of it is one file because it is one page's state.
 *
 * `bodyHeight` is here for the same reason: the request-body box is resized by
 * dragging its own grip, and that size is page furniture rather than a preference —
 * losing it on every trip to another tool page is the bug it fixes.
 */
export interface RestState {
  draft: RestRequest | null
  /** The collection tree's folders. Requests with no `folderId` sit at the top. */
  folders: RestFolder[]
  saved: SavedRestRequest[]
  environments: RestEnvironment[]
  /** Which environment `{{name}}` resolves against; null means none is chosen. */
  activeEnvironmentId: string | null
  history: RestHistoryEntry[]
  /** Pixels the user dragged the request-body box to, if they ever did. */
  bodyHeight?: number
}

/**
 * Why a request produced no answer, as a code the page can translate.
 *
 * The English sentence stays in `error` — it is what a page with no wording of its
 * own shows, what a log keeps, and what the probes assert on — but the four reasons
 * *this app* decides are also named, so a Chinese interface does not have an English
 * sentence in the middle of it. Failures that come out of Node's HTTP client
 * (`ECONNREFUSED`, a bad certificate, DNS) are left unnamed on purpose: their raw
 * text is the useful detail, and there is no sentence here to translate.
 *
 * Deliberately the same shape as the REST page's header-JSON problems.
 */
export type RestErrorCode = 'not-url' | 'bad-scheme' | 'timeout' | 'too-many-redirects'

export interface RestResponse {
  /** False only when the request never produced a response at all. */
  ok: boolean
  status?: number
  statusText?: string
  headers?: RestHeader[]
  body?: string
  /** Total wall time for the request, in ms. */
  durationMs: number
  /** Bytes received, before any decoding. */
  size: number
  /** Set when `ok` is false: the transport-level reason. */
  error?: string
  /** Set with `error` when the reason is one of ours, so the page can translate it. */
  errorCode?: RestErrorCode
  /** The URL that finally answered, after redirects. */
  finalUrl?: string
}

export interface TunnelSpec {
  id: string
  name: string
  /** Saved SSH session the tunnel rides on. */
  savedSessionId: string
  /** Where the listener sits on this machine. */
  localHost: string
  localPort: number
  /** Where it lands, as seen from the SSH host. */
  remoteHost: string
  remotePort: number
}

export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface TunnelState extends TunnelSpec {
  status: TunnelStatus
  /** Why it is not running, when it is not. */
  message?: string
  /** Live forwarded connections, so the UI can show it is actually in use. */
  connections: number
}

export interface SessionExitInfo {
  code: number | null
  signal: string | null
  /**
   * True when the app asked for this close (a pane closing, Ctrl+D on a finished
   * pane).
   *
   * The difference matters to the UI: a session that ended because someone closed
   * it is finished, while one whose connection dropped on its own is worth
   * retrying automatically.
   */
  expected: boolean
}

export interface AppInfo {
  platform: string
  /**
   * The app's own version, from `app.getVersion()`.
   *
   * Read in the main process rather than the renderer: the packaged renderer has no
   * way to reach `package.json`, and the version shown in Settings has to be the one
   * the running build was made from — the question it answers is "am I on the current
   * release?".
   */
  version: string
  versions: { electron: string; node: string; chrome: string }
  localShellAvailable: boolean
  /** Absolute path of the directory holding settings, sessions and the vault. */
  configDir: string
}

/**
 * Sent to the renderer when the window is asked to close.
 *
 * The confirmation itself is a normal in-app dialog, so the window close is held
 * in the main process until the user answers. The count comes from the main
 * process because it is the only side that knows every live backend.
 */
export interface QuitRequest {
  /** Number of live terminal sessions that closing would end. */
  sessions: number
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
  /**
   * What this entry connects as. Absent — every entry saved before telnet and
   * serial existed — means SSH.
   */
  kind?: 'ssh' | 'telnet' | 'serial'
  /** Line settings. Only meaningful when `kind` is 'serial'. */
  serial?: {
    path: string
    baudRate: number
    dataBits: 5 | 6 | 7 | 8
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
    stopBits: 1 | 2
  }
  /**
   * Lines typed into the session once it is up: `sudo -i`, `cd /var/log`, a
   * pager setting, anything you retype every single time. Sent in order, a
   * moment after the connection is established.
   */
  postConnectCommands?: string[]
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

// ---- sharing saved hosts ------------------------------------------------

/**
 * Export a tree for someone else: folders, sessions, and optionally the stored
 * passwords, gzipped and encrypted under a passphrase both people know.
 */
export interface ShareExportRequest {
  passphrase: string
  includeCredentials: boolean
  /** Only used by tests: without it the main process asks where to save. */
  filePath?: string
}

export type ShareExportResult =
  | {
      ok: true
      path: string
      sessions: number
      folders: number
      withPasswords: number
      bytes: number
    }
  | { ok: false; cancelled?: boolean; message?: string }

/** What a share file would do if it were imported, shown before doing it. */
export interface SharePreview {
  app: string
  exportedAt: string
  sessions: number
  folders: number
  /** How many of them are already here (same host, username and port). */
  duplicates: number
  /** How many arrive with a stored password. */
  withPasswords: number
  /** Whether the file carries secrets at all. */
  hasCredentials: boolean
}

export type SharePickResult =
  | { ok: true; filePath: string }
  | { ok: false; cancelled?: true; message?: string }

export type SharePeekResult =
  | { ok: true; filePath: string; preview: SharePreview }
  | { ok: false; cancelled?: boolean; message?: string }

export interface ShareImportRequest {
  filePath: string
  passphrase: string
  /** Hang everything that was at the root of the file inside this group. */
  folderId?: string | null
  /** Ignore the secrets even though the file carries them. */
  skipCredentials?: boolean
}

export interface ShareImportSummary {
  added: number
  skipped: number
  folders: number
  reusedFolders: string[]
  withPasswords: number
}

export type ShareImportResult =
  | { ok: true; tree: SessionTree; summary: ShareImportSummary }
  | { ok: false; cancelled?: boolean; message?: string }

// ---- importing from ~/.ssh/config -----------------------------------------

/**
 * One machine read out of an OpenSSH `config` file.
 *
 * `username` is null when the config (including its `Host *` defaults) did not
 * set a `User`: importing must not invent one, and the session then falls back
 * to the app's own default at creation time. `proxy` quotes the `ProxyJump` /
 * `ProxyCommand` the entry would use — TermDeck does not chain connections, so
 * it is kept as a note rather than silently dropped.
 */
export interface SshConfigHost {
  /** The literal name on the Host line; also the session name on import. */
  alias: string
  /** `HostName` when set, otherwise the alias itself. */
  host: string
  /** `User` when set, otherwise null. */
  username: string | null
  /** `Port` when set, otherwise 22. */
  port: number
  /** First `IdentityFile`, with `~`/`%d` expanded; null when there is none. */
  privateKeyPath: string | null
  /** `ProxyJump` or `ProxyCommand` verbatim, for the session notes. */
  proxy: string | null
  /** Line of the Host directive, for pointing at the source. */
  line: number
}

/** What the config on this machine would import, before anything is written. */
export type SshConfigPeekResult =
  | {
      ok: true
      /** The file that was read (or would have been), for showing the user. */
      path: string
      /** Importable hosts, in file order; `duplicate` marks ones already saved. */
      hosts: Array<SshConfigHost & { duplicate: boolean }>
    }
  | { ok: false; message: string }

export interface SshConfigImportRequest {
  /** The chosen subset of a peek's hosts, verbatim. */
  hosts: SshConfigHost[]
  /** Hang the imported sessions in this group instead of the root. */
  folderId?: string | null
}

export type SshConfigImportResult =
  | { ok: true; tree: SessionTree; summary: { added: number; skipped: number } }
  | { ok: false; message: string }

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
export type PageId = 'terminal' | 'hosts' | 'known-hosts' | 'snippets' | 'logs' | 'tunnels' | 'rest' | 's3' | 'settings'

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
  /** Icon-only rail rather than the wider rail plus its list drawer. */
  railCollapsed: boolean
  snippetBarVisible: boolean
  /**
   * How the Hosts page lists its hosts.
   *
   * Part of the layout rather than the page's own state: the page is unmounted
   * when another rail section is showing, so a local `useState` put the choice
   * back to "list" every time the user came back to it.
   */
  hostsView: HostsView
  /**
   * Groups folded on the Hosts page, by group key: a folder id, or `__unfiled__`
   * for the catch-all that holds the hosts in no folder.
   *
   * Part of the layout for the same reason `hostsView` is — the page is unmounted
   * whenever another rail section is showing, and a fold that forgets itself the
   * moment you look at something else is worse than no folding at all.
   *
   * Deliberately *not* `SessionFolder.expanded`, which is the drawer's tree: those
   * are two views of the same folders with different jobs. Collapsing twenty groups
   * to see the shape of the host library should not leave the quick-connect list
   * folded underneath someone on the terminal page.
   */
  hostsFolded: string[]
}

/** Rows for scanning a long list, cards for picking one host out of a handful. */
export type HostsView = 'list' | 'cards'

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

/**
 * Fonts the picker can offer.
 *
 * `bundled` ships inside the app, so it always renders; `monospace` and `others`
 * are what the machine actually has installed. `suggested` is names that are
 * neither — kept only so the field can autocomplete them, because offering one as
 * a chip that silently falls back to another font is worse than saying nothing.
 */
export interface FontChoices {
  bundled: string[]
  monospace: string[]
  others: string[]
  suggested: string[]
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
  cursorStyle: 'block' | 'underline' | 'bar' | 'outline'
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
   *
   * Off by default: with the panes split it costs horizontal room in every pane
   * at once, and the column is only wanted while actively reading output.
   */
  showTimestamps: boolean
  /** Inline suggestions from command history while typing. */
  suggestions: boolean
  /**
   * Colour what is worth spotting in output: addresses, links, error words.
   *
   * Off by default — it repaints text the remote host chose the colour of, and that
   * is a decision the user should make once, on purpose.
   */
  highlightEnabled: boolean
  highlightScheme: HighlightSchemeId
  /**
   * Which rules are on, by id.
   *
   * Ids rather than a map of booleans so a rule added in a later version does not
   * switch itself on for everyone who already has a settings file.
   */
  highlightRules: HighlightRuleId[]
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

// ---- the terminal drawer -------------------------------------------------

/** A block in the Terminal page's sidebar. */
export type SidebarSectionId = 'sessions' | 'openSessions' | 'history' | 'sftp'

export interface SidebarSectionState {
  id: SidebarSectionId
  /** A hidden section keeps its place in the order. */
  visible: boolean
  /**
   * Body folded away, leaving just the heading.
   *
   * Not the same as `visible`: collapsing is a quick "not now" for a section you
   * are keeping, so the order, the hidden-section menu and the settings row are
   * all left alone.
   */
  collapsed?: boolean
  /** Explicit body height in px, set by dragging the divider. Auto when absent. */
  height?: number
}

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionState[] = [
  { id: 'sessions', visible: true },
  { id: 'openSessions', visible: true },
  { id: 'history', visible: true },
  /*
   * Folded by default, and it stays folded until someone opens it.
   *
   * The SFTP panel is not just a list: opening it opens a *second* connection to
   * the host — a channel, a directory listing, a handle on the far side. Someone
   * sitting in a terminal has not asked for any of that, so none of it is created
   * until the section is expanded.
   */
  { id: 'sftp', visible: true, collapsed: true }
]

export const SIDEBAR_SECTION_LABELS: Record<SidebarSectionId, string> = {
  sessions: 'Sessions',
  openSessions: 'Open sessions',
  history: 'History',
  sftp: 'SFTP'
}

export interface SidebarSettings {
  /** Top-to-bottom order of the drawer, including the sections that are hidden. */
  sections: SidebarSectionState[]
  /** Drawer width in px, dragged from its inner edge. */
  width: number
  /** Which side of the window the drawer is docked to. */
  side: SidebarSide
}

export type SidebarSide = 'left' | 'right'

export const DEFAULT_SIDEBAR_WIDTH = 268
export const DEFAULT_SIDEBAR_SIDE: SidebarSide = 'left'

// ---- break reminder ------------------------------------------------------

/**
 * How the wellness timer behaves.
 *
 * `reminder` nudges once the work has gone on long enough; `pomodoro` runs
 * fixed rounds and tells you when to stop and when to start again. Both share
 * the same idle gate and the same recorded statistics.
 */
export type BreakMode = 'reminder' | 'pomodoro'

/**
 * Retrying a connection that dropped.
 *
 * Only *passive* drops are retried: a session the user ended (closing the pane,
 * Ctrl+D, or a clean `exit` at the prompt) is finished, not broken.
 */
export interface ReconnectSettings {
  enabled: boolean
  /** How many times to try before giving up and leaving the button to the user. */
  attempts: number
  /** Seconds to wait between attempts (and before the first one). */
  delaySeconds: number
}

/**
 * A nudge to get up, after this much *focused* use.
 *
 * Counted only while the window has focus, so a reminder never fires at someone
 * who has already walked away — and shown only once the terminals have gone
 * quiet for `idleSeconds`, so it never lands in the middle of a command.
 */
export interface BreakSettings {
  enabled: boolean
  mode: BreakMode
  /** Reminder interval, or the length of one pomodoro work round. */
  minutes: number
  /** Length of a pomodoro break. */
  breakMinutes: number
  /** How long every session must be silent before the nudge appears. */
  idleSeconds: number
  /** How long "later" means (reminder mode). */
  snoozeMinutes: number
}

export const DEFAULT_BREAK_SETTINGS: BreakSettings = {
  enabled: false,
  mode: 'reminder',
  minutes: 45,
  breakMinutes: 5,
  idleSeconds: 5,
  snoozeMinutes: 10
}

/**
 * Three tries, ten seconds apart: long enough for a Wi-Fi blip or a VPN reconnect,
 * short enough that a host which is really down is handed back to the user instead
 * of being hammered.
 */
export const DEFAULT_RECONNECT_SETTINGS: ReconnectSettings = {
  enabled: true,
  attempts: 3,
  delaySeconds: 10
}

/**
 * What the nudge has seen so far.
 *
 * The point of keeping this is that "longest unbroken stretch" is the number
 * that actually tells you something about your day, and it is only meaningful if
 * it survives a restart.
 */
export interface BreakStats {
  /** Longest continuous stretch recorded, in minutes. */
  longestMinutes: number
  /** How many breaks have been taken. */
  breaks: number
  /** Completed pomodoro work rounds. */
  pomodoros: number
  /** Epoch ms of the last break, 0 when there has never been one. */
  lastBreakAt: number
}

export const DEFAULT_BREAK_STATS: BreakStats = {
  longestMinutes: 0,
  breaks: 0,
  pomodoros: 0,
  lastBreakAt: 0
}

// ---- lock screen ---------------------------------------------------------

/**
 * What the renderer is allowed to know about the lock.
 *
 * There is no "enabled" flag and no password in settings: the lock exists, the
 * shortcut locks, and whether unlocking needs a password is decided by whether
 * one is stored. The password itself lives in the encrypted vault and never
 * crosses IPC — the renderer can only ask whether a guess matches.
 */
export interface LockStatus {
  /** True when a non-empty password is stored. */
  hasPassword: boolean
}

export interface SaveLockRequest {
  /**
   * `null` clears the stored password (the lock then unlocks on a click); a
   * string, including the empty string, replaces it.
   */
  password: string | null
}

// ---- command history -----------------------------------------------------

/**
 * One command the user ran, recorded as it was typed.
 *
 * History is kept **per session**, in its own file, and expires after
 * `HISTORY_RETENTION_DAYS`: opening a separate shell for each host means the
 * commands that belong to a host should not bleed into another's list, and old
 * commands are not something to keep forever.
 */
export interface HistoryEntry {
  id: string
  command: string
  /** Title of the session it was typed into. */
  session: string
  at: number
}

/** How long a session's history file is kept. */
export const HISTORY_RETENTION_DAYS = 7

/** A session that still has history on disk, for the panel's picker. */
export interface HistorySessionSummary {
  sessionId: string
  title: string
  count: number
  /** Epoch ms of the newest command in it. */
  updatedAt: number
}

// ---- sftp ----------------------------------------------------------------

export interface SftpEntry {
  name: string
  /** Absolute remote path. */
  path: string
  type: 'file' | 'directory' | 'link' | 'other'
  size: number
  /** Epoch ms, 0 when the server did not report one. */
  modified: number
}

export type SftpListResult =
  | { ok: true; path: string; entries: SftpEntry[] }
  | { ok: false; message: string }

export type SftpTransferResult =
  | { ok: true; path: string }
  | { ok: false; cancelled?: true; message?: string }

export type TransferKind = 'upload' | 'download'

/**
 * `running` until the file is closed, then one of the endings.
 *
 * `cancelled` is a state of its own rather than an error: the streams are destroyed
 * mid-flight, which surfaces as a perfectly ordinary close, so the ending has to be
 * decided by who asked for it.
 */
export type TransferStatus = 'running' | 'done' | 'error' | 'cancelled'

/** One file moving in or out, as the transfers window draws it. */
export interface TransferInfo {
  id: string
  kind: TransferKind
  sessionId: string
  /** Host label, for the window's second line. */
  session: string
  /** File name, the part worth reading at a glance. */
  name: string
  localPath: string
  remotePath: string
  /** Total bytes, or `0` when the size could not be read before starting. */
  size: number
  /** Bytes moved so far. */
  done: number
  status: TransferStatus
  message?: string
  startedAt: number
  finishedAt?: number
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
  /**
   * Global shortcut that runs this snippet, in the same notation as a keybinding
   * (`Ctrl+Shift+U`). Empty or absent means the button is the only way in.
   *
   * Snippets carry their own shortcut rather than owning a keybinding entry so
   * that deleting a snippet also removes its key — a binding list entry outliving
   * the snippet it pointed at is how a key ends up doing nothing.
   */
  keys?: string
  /**
   * A colour for the chip, as `#rrggbb`. Drawn as a stripe along the bottom edge of
   * the button, so a wall of similar-looking commands can be told apart at a glance.
   * Absent means "no stripe".
   */
  color?: string
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  terminal: TerminalSettings
  clipboard: ClipboardSettings
  keybindings: Keybinding[]
  hostKeys: HostKeySettings
  snippets: Snippet[]
  /** Terminal-page drawer: order, visibility and sizes of its sections. */
  sidebar: SidebarSettings
  /** Get-up-and-stretch reminder. */
  break: BreakSettings
  /** What to do when a connection drops on its own. */
  reconnect: ReconnectSettings
  /** What that reminder has recorded about the working day. */
  breakStats: BreakStats
  /** Id of the active theme; see `THEMES` in shared/themes. */
  theme: string
  /**
   * Interface scale, as a multiplier (1 = 100%).
   *
   * Applied with `webContents.setZoomFactor`, so every measurement — rail, side
   * bar, dialogs, terminal font — scales together. Without it a dense desktop UI
   * is uncomfortably small on a 2560px-wide display and there is nothing the user
   * can do about it.
   */
  uiScale: number
  /** Interface language; the catalog lives in the renderer (see `i18n/zh.ts`). */
  language: Language
  /**
   * False until the first-run welcome has been dealt with.
   *
   * Absent in a settings file written before the welcome existed, which is exactly
   * the case the welcome is for: an existing install gets it once, and a fresh one
   * gets it before anything else.
   */
  onboarded?: boolean
}

/** Languages with a catalog. `en` is the source text and needs no catalog. */
export type Language = 'en' | 'zh-CN'

/** Where the app is currently keeping its data. */
export interface DataDirectoryStatus {
  current: string
  /** Electron's userData, i.e. where it looks when nothing overrides it. */
  default: string
  /** True when a pointer file has moved it somewhere else. */
  moved: boolean
}

export interface DataDirectoryRequest {
  /** Absolute path, or empty to go back to the default location. */
  dir: string | null
  /** Copy the existing settings, sessions and credentials across first. */
  move?: boolean
}

export interface DataDirectoryResult {
  ok: boolean
  directory: string
  /** Names of the files that were copied, when moving. */
  moved: string[]
  /** True when the app has to restart for the change to take effect. */
  restartRequired: boolean
  message?: string
}

/** Defaults live in the main process so they have a single source of truth. */
export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: 'newConnection', label: 'New connection', keys: 'Ctrl+T', builtin: true },
  /*
   * Unbound by default — `Ctrl+W` belongs to the shell.
   *
   * It is delete-previous-word in every readline line editor: bash, zsh, and the
   * Python and Node REPLs all read it, and it is muscle memory there. An app that
   * closes a pane on it eats a key the terminal needs, and closing a session is not
   * what that key means to anyone typing in one. It stays in this list, so anyone who
   * wants it on a chord can set one; the retired default is migrated for existing
   * installs in `mergeKeybindings` rather than left in place.
   */
  { id: 'closeSession', label: 'Close active session', keys: '', builtin: true },
  /*
   * `Ctrl+D` closes a pane whose session has already ended — and only then.
   *
   * In a live shell `Ctrl+D` is EOF: swallowing it would break logging out and
   * every REPL that reads it, so the binding does nothing at all while the pane
   * still has something to send it to.
   */
  { id: 'closeDeadPane', label: 'Close a finished session', keys: 'Ctrl+D', builtin: true },
  { id: 'openSettings', label: 'Open settings', keys: 'Ctrl+,', builtin: true },
  /*
   * Reconnect only *acts* on a pane whose session has ended, and declines the key
   * otherwise — the same rule as Ctrl+D above. Ctrl+R is reverse-i-search in every
   * readline shell, and swallowing it in a live terminal would be a regression
   * dressed as a shortcut.
   */
  { id: 'reconnectSession', label: 'Reconnect the active session', keys: 'Ctrl+R', builtin: true },
  { id: 'toggleSidebar', label: 'Toggle sidebar', keys: 'Ctrl+B', builtin: true },
  { id: 'openConnections', label: 'Open connections window', keys: 'Ctrl+Shift+E', builtin: true },
  /*
   * File transfers, in their own window. Ctrl+Shift+J is free in a terminal and does
   * not shadow a shell binding; the window itself is read-only apart from cancelling.
   */
  { id: 'openTransfers', label: 'Open transfers window', keys: 'Ctrl+Shift+J', builtin: true },
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
  { id: 'prevTab', label: 'Previous tab', keys: 'Ctrl+Shift+Tab', builtin: true },
  /*
   * Quit, with a confirmation step.
   *
   * Deliberately not Ctrl+Q: that is XON (resume output) in a terminal, and
   * swallowing it would break the shell's flow control for anyone who uses it.
   */
  { id: 'quitApp', label: 'Quit TermDeck', keys: 'Ctrl+Shift+Q', builtin: true },
  { id: 'toggleFocus', label: 'Focus mode (full screen)', keys: 'F11', builtin: true },
  { id: 'lockApp', label: 'Lock TermDeck', keys: 'Ctrl+Alt+L', builtin: true },
  /*
   * Session navigation. `Alt`+digit jumps straight to a session (1 = the first
   * pane in the arrangement); these two walk the same list and wrap around, so
   * neither end is a dead stop. The digits are a family rather than one binding:
   * which number means which session is the layout's order, not a setting.
   */
  { id: 'prevPage', label: 'Previous session', keys: 'Alt+[', builtin: true },
  { id: 'nextPage', label: 'Next session', keys: 'Alt+]', builtin: true },
  /*
   * Interface zoom. The chords shown here are `Ctrl+=` and `Ctrl+-`; the aliases
   * people actually press — `Ctrl+Shift+=` for a real `+`, and the numpad keys —
   * are handled in the renderer, because a single chord string cannot express
   * "either of these".
   */
  { id: 'zoomIn', label: 'Larger terminal font', keys: 'Ctrl+=', builtin: true },
  { id: 'zoomOut', label: 'Smaller terminal font', keys: 'Ctrl+-', builtin: true },
  /*
   * The interface scale lives on its own chord now. `Ctrl`+`+`/`-` used to zoom the
   * whole window (Electron's `setZoomFactor`), which also shrank the terminal
   * chrome — so the one control people reach for to make *text* readable also
   * changed the size of everything around it.
   */
  { id: 'scaleUp', label: 'Larger interface', keys: 'Ctrl+Shift+=', builtin: true },
  { id: 'scaleDown', label: 'Smaller interface', keys: 'Ctrl+Shift+-', builtin: true },
  { id: 'tilePanes', label: 'Arrange panes', keys: 'Ctrl+Shift+T', builtin: true }
]

/**
 * Interface scale steps.
 *
 * One ladder for the settings picker and for the zoom shortcuts: two lists would
 * drift, and "the chips do not include the size the shortcut just picked" is
 * exactly the kind of thing nobody notices until it is confusing.
 */
export const UI_SCALES = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

/** The next ladder step up or down, or the same value at either end. */
export function stepScale(current: number, direction: 1 | -1): number {
  const sorted = UI_SCALES
  if (direction > 0) return sorted.find((s) => s > current + 0.001) ?? current
  return [...sorted].reverse().find((s) => s < current - 0.001) ?? current
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily:
    '"Cascadia Mono", "JetBrains Mono", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  /**
   * A hollow box: transparent inside, outlined in the terminal's text colour.
   *
   * The default because it is the shape that hides the least — a filled block
   * covers the character under it, which is exactly the one the user is about to
   * overtype.
   */
  cursorStyle: 'outline',
  cursorBlink: true,
  // Deliberately slower than xterm's own ~0.5s cadence, which reads as a flicker.
  cursorBlinkMs: 900,
  scrollback: 4_000,
  /**
   * On by default. A per-line time column is what makes output auditable, and it
   * is what the reference client (WindTerm) shows; it can be turned off in
   * Settings → Terminal.
   */
  showTimestamps: false,
  suggestions: true,
  highlightEnabled: false,
  highlightScheme: 'classic',
  highlightRules: DEFAULT_HIGHLIGHT_RULES
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
  sidebar: {
    sections: DEFAULT_SIDEBAR_SECTIONS,
    width: DEFAULT_SIDEBAR_WIDTH,
    side: DEFAULT_SIDEBAR_SIDE
  },
  break: DEFAULT_BREAK_SETTINGS,
  breakStats: DEFAULT_BREAK_STATS,
  reconnect: DEFAULT_RECONNECT_SETTINGS,
  theme: 'termius-dark',
  uiScale: 1,
  language: 'en'
}

// ---- renderer bridge ---------------------------------------------------

/** Shape of `window.termdeck`, exposed by the preload script. */
export interface TermDeckApi extends S3Api {
  createSshSession(payload: SshConnectPayload): Promise<CreateSessionResult>
  createLocalSession(payload: LocalConnectPayload): Promise<CreateSessionResult>
  createTelnetSession(payload: TelnetConnectPayload): Promise<CreateSessionResult>
  createSerialSession(payload: SerialConnectPayload): Promise<CreateSessionResult>
  /**
   * Open a second, independent connection to the same host as a live session.
   *
   * Resolved in the main process from the options the session was started with,
   * so the copy uses the same credentials without them crossing IPC again.
   */
  duplicateSession(sourceId: string): Promise<CreateSessionResult>

  /** Rebuild a session whose pane is still on screen after it ended. */
  reconnectSession(sourceId: string): Promise<CreateSessionResult>
  writeSession(id: string, data: string): void
  resizeSession(id: string, cols: number, rows: number): void
  closeSession(id: string): void
  listSessions(): Promise<SessionInfo[]>
  replaySession(id: string): Promise<{ data: string; seq: number } | null>

  pickPrivateKey(): Promise<string | null>
  copyToClipboard(text: string): Promise<void>
  readClipboard(): Promise<string>
  appInfo(): Promise<AppInfo>

  // sharing saved hosts. The file dialogs live in the main process; the renderer
  // only ever handles a passphrase and, for a peek, the plan it produces.
  exportShare(request: ShareExportRequest): Promise<ShareExportResult>
  pickShareFile(): Promise<SharePickResult>
  peekShare(filePath: string, passphrase: string): Promise<SharePeekResult>
  importShare(request: ShareImportRequest): Promise<ShareImportResult>

  // importing hosts from this machine's ~/.ssh/config; the file lives in the
  // main process, the renderer only ever sees the parsed, secret-free result
  peekSshConfig(): Promise<SshConfigPeekResult>
  importSshConfig(request: SshConfigImportRequest): Promise<SshConfigImportResult>

  // where the app keeps its data (settings, sessions, credentials)
  dataDirectory(): Promise<DataDirectoryStatus>
  pickDataDirectory(): Promise<string | null>
  setDataDirectory(request: DataDirectoryRequest): Promise<DataDirectoryResult>
  /** Relaunch, for a data-directory change to take effect. */
  restartApp(): Promise<void>

  // focus mode / full screen
  /** Enter or leave full screen; resolves with the state that was applied. */
  setFullScreen(on: boolean): Promise<boolean>
  isFullScreen(): Promise<boolean>

  // lock screen. The password never travels back out of the main process.
  lockStatus(): Promise<LockStatus>
  saveLock(request: SaveLockRequest): Promise<LockStatus>
  /** True when the password unlocks (and true immediately for an empty one). */
  verifyLock(password: string): Promise<boolean>

  // command history — one file per session, expiring after a week
  /** Every command in one session's own history, newest first. */
  listHistory(sessionId: string): Promise<HistoryEntry[]>
  /** Sessions that still have history on disk, newest first. */
  historySessions(): Promise<HistorySessionSummary[]>
  deleteHistoryEntry(sessionId: string, id: string): Promise<HistoryEntry[]>
  clearHistory(sessionId: string): Promise<HistoryEntry[]>

  // sftp, over the connection a live session is already using
  sftpList(sessionId: string, path: string): Promise<SftpListResult>
  /** Save one remote file to a local path the user picks. */
  sftpDownload(sessionId: string, remotePath: string): Promise<SftpTransferResult>
  /** Upload a local file the user picks into a remote directory. */
  sftpUpload(sessionId: string, remoteDir: string): Promise<SftpTransferResult>

  /*
   * The same two transfers with the paths already decided.
   *
   * Split out from the pair above because a native file dialog is a *front end*: the
   * transfer itself is the same code, and keeping it reachable without a dialog is what
   * lets it be driven by a probe (and by any future drag-and-drop).
   */
  startUpload(sessionId: string, remoteDir: string, localPath: string): Promise<SftpTransferResult>
  startDownload(
    sessionId: string,
    remotePath: string,
    localPath: string
  ): Promise<SftpTransferResult>

  /**
   * The absolute path behind a dropped File.
   *
   * Electron stopped putting a path on File objects (32+), so a drop has to ask the
   * main process; this returns '' for anything it cannot resolve, which is the signal to
   * try another source.
   */
  pathForFile(file: File): string

  // transfers: every file currently moving, for the transfers window
  listTransfers(): Promise<TransferInfo[]>
  /** Ask one transfer to stop; the streams are destroyed. */
  cancelTransfer(id: string): Promise<TransferInfo[]>
  /** Drop the finished ones from the list. */
  clearFinishedTransfers(): Promise<TransferInfo[]>
  onTransfers(listener: (transfers: TransferInfo[]) => void): () => void

  // host keys
  trustHostKey(request: TrustHostKeyRequest): Promise<boolean>
  forgetHostKey(host: string, port: number): Promise<number>
  /** Every entry across the configured known_hosts files. */
  listKnownHosts(): Promise<KnownHostEntry[]>
  /** Every session's command history, newest first, for inline suggestions. */
  globalCommandHistory(): Promise<string[]>
  recordCommand(sessionId: string, command: string): Promise<void>
  /** Remove one entry by its file and line number. */
  removeKnownHostEntry(file: string, line: number): Promise<KnownHostEntry[]>
  /** Remove several entries in one write (see the handler for why it is batched). */
  removeKnownHostEntries(entries: { file: string; line: number }[]): Promise<KnownHostEntry[]>

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
  /**
   * Add several sessions in one write, and apply one password to all of them.
   *
   * The batch form's whole point: typing a password once covers every host it
   * creates. Each session still gets its own sealed copy, so a host that rejects
   * the password is corrected on its own afterwards.
   */
  saveSessions(batch: {
    sessions: Array<Partial<SavedSession> & { host: string }>
    credential?: { password?: string }
  }): Promise<SessionTree>
  deleteSession(id: string): Promise<SessionTree>
  saveFolder(folder: Partial<SessionFolder> & { name: string }): Promise<SessionTree>
  deleteFolder(id: string): Promise<SessionTree>
  moveSession(id: string, parentId: string | null): Promise<SessionTree>
  moveFolder(id: string, parentId: string | null): Promise<SessionTree>
  /** Fold or unfold every folder in one commit — the drawer's fold-all control. */
  setFoldersExpanded(expanded: boolean): Promise<SessionTree>
  /** Delete several hosts in one commit, clearing each stored secret. */
  deleteSessions(ids: string[]): Promise<SessionTree>
  /** Copy several hosts in one commit, carrying each stored secret across. */
  duplicateSessions(ids: string[]): Promise<SessionTree>
  /** Re-file several hosts in one commit. */
  moveSessions(ids: string[], parentId: string | null): Promise<SessionTree>
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

  // interface scale
  setUiScale(scale: number): Promise<number>

  // snippets (stored inside settings so they travel with a settings backup)
  saveSnippet(snippet: Partial<Snippet> & { label: string; command: string }): Promise<AppSettings>
  deleteSnippet(id: string): Promise<AppSettings>
  reorderSnippets(ids: string[]): Promise<AppSettings>

  onSessionData(handler: (id: string, chunk: string, seq: number) => void): () => void
  onSessionExit(handler: (id: string, info: SessionExitInfo) => void): () => void
  onSessionError(handler: (id: string, message: string) => void): () => void
  /**
   * The window was asked to close (its X, Alt+F4, or a quit shortcut).
   *
   * The close is held in the main process, so the UI has to answer by calling
   * `quitApp()` to let it through — or do nothing, which cancels the quit.
   */
  onQuitRequested(handler: (request: QuitRequest) => void): () => void
  /**
   * The macOS application menu's "Settings…" item.
   *
   * On a Mac `Cmd+,` belongs to the menu rather than to a binding (see
   * `shared/platform.ts`), so the renderer has to be told to open the drawer — and
   * the item works even when no pane has focus.
   */
  onOpenSettings(handler: () => void): () => void
  /** Confirm a pending quit and exit. */
  quitApp(): void
  /** Fired for every full-screen change, including ones the app did not start. */
  onFullScreenChanged(handler: (on: boolean) => void): () => void
  /** Fired when a command is recorded, for the session it belongs to. */
  onHistoryChanged(
    handler: (change: { sessionId: string; entries: HistoryEntry[] }) => void
  ): () => void
  /** Fires whenever settings are saved, so the UI never runs on stale values. */
  onSettingsChanged(handler: (settings: AppSettings) => void): () => void
  /** Fires on every saved-session or folder mutation. */
  onTreeChanged(handler: (tree: SessionTree) => void): () => void

  sendRestRequest(request: RestRequest): Promise<RestResponse>

  loadRestState(): Promise<RestState>
  saveRestState(state: RestState): Promise<RestState>
  onRestStateChanged(handler: (state: RestState) => void): () => void

  listTunnels(): Promise<TunnelState[]>
  saveTunnels(specs: TunnelSpec[]): Promise<TunnelState[]>
  removeTunnel(id: string): Promise<TunnelState[]>
  startTunnel(id: string): Promise<TunnelState[]>
  stopTunnel(id: string): Promise<TunnelState[]>
  onTunnelsChanged(handler: (tunnels: TunnelState[]) => void): () => void
  onTagsChanged(handler: (tags: string[]) => void): () => void
}
