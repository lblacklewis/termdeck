/**
 * Platform differences, as pure functions.
 *
 * Every one of these takes the platform as an argument instead of reading
 * `process.platform`. There are three callers with three different needs:
 *
 *  - the main process, which passes the real platform;
 *  - the renderer, where `process` does not exist at all (it takes the platform
 *    from `app:info`);
 *  - the smoke suites, which run on a Windows machine and have to be able to show
 *    what macOS *would* do. A branch that can only be reached on hardware we do
 *    not have is a branch nobody can check.
 *
 * The lists themselves live in `types.ts`, next to the settings they describe;
 * this module is only the part that varies by platform.
 */
import {
  DEFAULT_CLIPBOARD_SETTINGS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  type AppSettings,
  type ClipboardSettings,
  type Keybinding,
  type TerminalSettings
} from './types'

/** The default binding of `Ctrl+X` on macOS is `Cmd+X`. */
const MAC_MODIFIER = 'Meta'

/**
 * Rewrite the modifier of a chord: `Ctrl+Shift+T` → `Meta+Shift+T`.
 *
 * Only `Ctrl` changes; `Shift`, `Alt` and the key itself are left exactly as
 * they were, and a chord with no `Ctrl` in it (say `F11`) comes back untouched.
 *
 * This is the *fallback* for a binding that has no line in the table below — a
 * binding added later still gets something sane — but it is deliberately not how
 * macOS defaults are chosen. A Mac is not "Ctrl with a different modifier".
 */
export function metaChord(binding: string): string {
  if (!binding) return binding
  return binding
    .split('+')
    .map((part) => {
      const modifier = part.trim().toLowerCase()
      return modifier === 'ctrl' || modifier === 'control' ? MAC_MODIFIER : part
    })
    .join('+')
}

/**
 * The macOS default chords, chosen one by one.
 *
 * These follow what a Mac terminal user actually presses — iTerm2 and Terminal.app
 * are the reference — rather than transposing the Windows column:
 *
 * | chord | why |
 * | --- | --- |
 * | `Cmd+T` / `Cmd+W` | new tab / close tab, the same key doing the same thing here (a pane) |
 * | `Cmd+C` / `Cmd+V` | **the** copy and paste chords on a Mac. `Ctrl+Shift+C/V` is a Windows/X11 habit; on a Mac `Cmd+C` copies the selection and `Ctrl+C` stays SIGINT for the shell |
 * | `Cmd+Shift+]` / `Cmd+Shift+[` | next / previous tab, as in iTerm2 and Terminal.app |
 * | `Ctrl+Cmd+F` | full screen, as in every Mac app (there is no `F11` habit on a Mac) |
 * | `Cmd+Alt+←` / `Cmd+Alt+→` | move between sessions (iTerm2's tab-switching chord) |
 * | `Cmd+Q` / `Cmd+,` | Quit and Settings live in the **application menu** on a Mac, so these two are left unbound here and provided by `main/menu.ts` |
 * | `Cmd+K`… | not bound: there is no "clear buffer" command in this app yet |
 *
 * `closeDeadPane` is unbound too: `Cmd+W` already closes a pane whatever state it
 * is in, so a second chord for "a pane that has already ended" would only take a
 * key away. On Windows the two are separate because `Ctrl+W` belongs to the shell.
 */
export const MAC_BINDING_DEFAULTS: Record<string, string> = {
  newConnection: 'Meta+T',
  closeSession: 'Meta+W',
  closeDeadPane: '',
  openSettings: '',
  reconnectSession: 'Meta+R',
  toggleSidebar: 'Meta+B',
  openConnections: 'Meta+Shift+E',
  openTransfers: 'Meta+Shift+J',
  toggleSnippets: 'Meta+Shift+S',
  toggleBroadcast: 'Meta+Shift+B',
  copy: 'Meta+C',
  paste: 'Meta+V',
  nextTab: 'Meta+Shift+]',
  prevTab: 'Meta+Shift+[',
  quitApp: '',
  toggleFocus: 'Ctrl+Meta+F',
  lockApp: 'Ctrl+Meta+L',
  prevPage: 'Meta+Alt+ArrowLeft',
  nextPage: 'Meta+Alt+ArrowRight',
  zoomIn: 'Meta+=',
  zoomOut: 'Meta+-',
  scaleUp: 'Meta+Shift+=',
  scaleDown: 'Meta+Shift+-',
  tilePanes: 'Meta+Shift+T'
}

/**
 * What v2.1.0 shipped as the macOS defaults.
 *
 * Kept because those values are on disk now: that release set the Mac defaults by
 * rewriting `Ctrl` as `Meta` (`Cmd+C` was still `Cmd+Shift+C` then), and a stored
 * value is migrated only when it is *exactly* a default this app has shipped. A
 * chord someone chose is never touched.
 */
const MAC_V210_DEFAULTS: Record<string, string> = Object.fromEntries(
  DEFAULT_KEYBINDINGS.map((binding) => [
    binding.id,
    binding.id === 'closeSession' ? 'Meta+W' : metaChord(binding.keys)
  ])
)

/** The built-in shortcuts as this platform ships them. */
export function defaultBindings(platform: string): Keybinding[] {
  const base = DEFAULT_KEYBINDINGS.map((binding) => ({ ...binding }))
  if (platform !== 'darwin') return base

  return base.map((binding) => ({
    ...binding,
    keys: MAC_BINDING_DEFAULTS[binding.id] ?? metaChord(binding.keys)
  }))
}

/**
 * Bindings whose default changed after the app had already shipped, per platform.
 *
 * A stored file is the user's word, so a value is only rewritten when it is
 * exactly one of the old defaults — anything else means they chose it themselves
 * and it stays. `mergeKeybindings` applies this on every load.
 *
 * Three generations are folded in here:
 *
 *  - `closeSession` was `Ctrl+W` until v1.13.0, which unbound it on Windows and
 *    Linux because readline reads that key. On macOS the same old value becomes
 *    `Cmd+W` instead: the reason for retiring it does not apply to the Meta key.
 *  - every other Windows default (`Ctrl+T`, `Ctrl+D`, …) becomes the Mac default
 *    for anyone who moved a config file between machines.
 *  - the macOS defaults v2.1.0 shipped (`Cmd+Shift+C`, `Cmd+Shift+V`, `F11`, …)
 *    become the ones this version ships (`Cmd+C`, `Cmd+V`, `Ctrl+Cmd+F`, …), so
 *    an install that has already run the Mac build gets the real Mac habits
 *    instead of keeping the transposed Windows ones forever.
 */
export function retiredBindingDefaults(
  platform: string
): Record<string, { from: string; to: string }[]> {
  // Windows and Linux carry exactly one generation: `closeSession` lost its old
  // default, and nothing else has moved yet.
  if (platform !== 'darwin') {
    return { closeSession: [{ from: 'Ctrl+W', to: '' }] }
  }

  const retired: Record<string, { from: string; to: string }[]> = {}
  const mac = new Map(defaultBindings('darwin').map((binding) => [binding.id, binding.keys]))
  for (const binding of DEFAULT_KEYBINDINGS) {
    const to = mac.get(binding.id) ?? binding.keys
    const sources = [
      // `closeSession`'s *current* default is already empty, so the value an old
      // install actually has on disk is its historical one, not `binding.keys`.
      binding.id === 'closeSession' ? 'Ctrl+W' : binding.keys,
      MAC_V210_DEFAULTS[binding.id] ?? ''
    ]
    const rules = retired[binding.id] ?? []
    for (const from of sources) {
      if (!from || from === to) continue
      if (rules.some((rule) => rule.from === from)) continue
      rules.push({ from, to })
    }
    if (rules.length > 0) retired[binding.id] = rules
  }
  return retired
}

/** Migrate one stored binding value, if it happens to be a retired default. */
export function migrateBindingKeys(platform: string, id: string, keys: string): string {
  const rules = retiredBindingDefaults(platform)[id] ?? []
  const hit = rules.find((rule) => rule.from === keys)
  return hit ? hit.to : keys
}

/**
 * How a chord is written for the user.
 *
 * The stored form is portable (`Meta+W`), the shown form is the platform's own
 * name for that modifier — a Mac user reads `Cmd+W`, and showing them "Meta+W"
 * would be answering a question nobody asked.
 */
export function displayChord(chord: string, platform: string): string {
  if (!chord || platform !== 'darwin') return chord
  return chord
    .split('+')
    .map((part) => (part.trim().toLowerCase() === 'meta' ? 'Cmd' : part))
    .join('+')
}

/**
 * Which modifier jumps straight to a session: `Alt`+digit, or `Cmd`+digit on macOS.
 *
 * A family rather than a setting: which number means which session is the layout's
 * order. The Mac habit for "go to tab" is `Cmd`+digit (iTerm2, Terminal.app), and
 * `Option`+digit is the wrong modifier to hang a global shortcut on there — it types
 * a symbol in every Mac text field.
 *
 * Returned as the modifier name so the renderer can keep matching the way it already
 * does (the digit is the event's own key, not part of the chord).
 */
export function sessionJumpModifier(platform: string): 'alt' | 'meta' {
  return platform === 'darwin' ? 'meta' : 'alt'
}

/**
 * Terminal faces that ship inside the app.
 *
 * These are the ones people expect to be able to choose for a terminal and which
 * a machine very often does not have. The @font-face rules in `global.css` carry
 * the same two names, so picking one of these always renders.
 */
export const BUNDLED_MONOSPACE_FONTS = ['Roboto Mono', 'JetBrains Mono']

/** Fonts most desktops have, used as autocomplete suggestions. */
export const BASE_MONOSPACE_FONTS = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'Courier New',
  'DejaVu Sans Mono',
  'Fira Code',
  'Hack',
  'IBM Plex Mono',
  'Inconsolata',
  'JetBrains Mono',
  'Lucida Console',
  'Menlo',
  'Monaco',
  'Noto Sans Mono',
  'Roboto Mono',
  'Source Code Pro',
  'Ubuntu Mono'
]

/** Faces worth suggesting on a Mac that are not in the shared list. */
const MAC_MONOSPACE_FONTS = ['SF Mono', 'Andale Mono']

/** The autocomplete shortlist for this platform, most-likely first. */
export function fallbackMonospaceFonts(platform: string): string[] {
  if (platform === 'darwin') return [...MAC_MONOSPACE_FONTS, ...BASE_MONOSPACE_FONTS]
  return [...BASE_MONOSPACE_FONTS]
}

/**
 * The default terminal face.
 *
 * The bundled faces (Roboto Mono / JetBrains Mono) render on every platform, but
 * a Mac user expects the system's own monospace first, the same way a Windows
 * user expects Cascadia. Everything except macOS keeps exactly the family list
 * the app has always shipped, so this changes nothing for existing installs.
 */
export function defaultFontFamily(platform: string): string {
  if (platform === 'darwin') {
    return '"SF Mono", Menlo, Monaco, "Roboto Mono", "JetBrains Mono", monospace'
  }
  return DEFAULT_TERMINAL_SETTINGS.fontFamily
}

/** Terminal settings as this platform ships them. */
export function defaultTerminalSettings(platform: string): TerminalSettings {
  return { ...DEFAULT_TERMINAL_SETTINGS, fontFamily: defaultFontFamily(platform) }
}

/**
 * Should the platform's own copy/paste handle this key press instead of the app?
 *
 * On macOS `Cmd+C` is the system copy chord *and* the app's terminal-copy binding, so
 * which one should act depends entirely on where the focus is. The terminal reads keys
 * through a hidden `<textarea>` inside `.xterm`, so "it is a textarea" says nothing on
 * its own — an input counts only when it is outside every terminal pane.
 *
 * Kept as a decision table so the whole rule can be asserted without a window; the
 * renderer's job is only to read the focus and hand it the three facts.
 */
export function isNativeEditTarget(target: {
  tagName: string
  isContentEditable: boolean
  insideTerminal: boolean
}): boolean {
  const editable =
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
  return editable && !target.insideTerminal
}

/**
 * Clipboard behaviour as this platform ships it.
 *
 * Two Mac differences, both habits rather than preferences:
 *
 *  - **No copy-on-select.** A Mac terminal copies when you press `Cmd+C`; putting
 *    every accidental selection on the clipboard is a Windows/X11 habit (and on a
 *    Mac the clipboard is shared with everything else you are doing).
 *  - **No middle-click paste.** There is no middle button to press. Right-click
 *    paste stays on both platforms: this app has no terminal context menu yet, so
 *    turning it off would leave the gesture doing nothing at all.
 */
export function defaultClipboardSettings(platform: string): ClipboardSettings {
  const base = { ...DEFAULT_CLIPBOARD_SETTINGS }
  if (platform !== 'darwin') return base
  return { ...base, copyOnSelect: false, pasteOnMiddleClick: false }
}

/** The whole settings document as this platform ships it, before anything is stored. */
export function defaultSettings(platform: string): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    terminal: defaultTerminalSettings(platform),
    clipboard: defaultClipboardSettings(platform),
    keybindings: defaultBindings(platform)
  }
}
