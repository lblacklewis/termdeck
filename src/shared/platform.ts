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
  DEFAULT_KEYBINDINGS,
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  type AppSettings,
  type Keybinding,
  type TerminalSettings
} from './types'

/** The default binding of `Ctrl+X` on macOS is `Cmd+X`. */
const MAC_MODIFIER = 'Meta'

/**
 * Defaults that exist on macOS and nowhere else.
 *
 * `Cmd+W` is how a Mac closes the thing in front of it, and — unlike `Ctrl+W` —
 * it is not a key the shell reads: `Ctrl` is the shell's modifier
 * (delete-previous-word), `Cmd` is the app's. So the binding v1.13.0 deliberately
 * gave up on Windows comes back on the Meta modifier, and the *system* window
 * close moves to `Cmd+Shift+W` (see `menuTemplateFor` in the main process) so the
 * two are not fighting over one chord.
 */
const MAC_ONLY_BINDING_DEFAULTS: Record<string, string> = {
  closeSession: 'Meta+W'
}

/**
 * Rewrite the modifier of a chord: `Ctrl+Shift+T` → `Meta+Shift+T`.
 *
 * Only `Ctrl` changes; `Shift`, `Alt` and the key itself are left exactly as
 * they were, and a chord with no `Ctrl` in it (say `F11`) comes back untouched.
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

/** The built-in shortcuts as this platform ships them. */
export function defaultBindings(platform: string): Keybinding[] {
  const base = DEFAULT_KEYBINDINGS.map((binding) => ({ ...binding }))
  if (platform !== 'darwin') return base

  return base.map((binding) => ({
    ...binding,
    keys: MAC_ONLY_BINDING_DEFAULTS[binding.id] ?? metaChord(binding.keys)
  }))
}

/**
 * Bindings whose default changed after the app had already shipped, per platform.
 *
 * A stored file is the user's word, so a value is only rewritten when it is
 * exactly the old default — anything else means they chose it themselves and it
 * stays. `mergeKeybindings` applies this on every load.
 *
 * Two generations of history are folded in here:
 *
 *  - `closeSession` was `Ctrl+W` until v1.13.0, which unbound it on Windows and
 *    Linux because readline reads that key. On macOS the same old value becomes
 *    `Meta+W` instead: the reason for retiring it does not apply to `Cmd+W`.
 *  - the whole Windows-targeted default set (`Ctrl+T`, `Ctrl+D`, …) becomes the
 *    Meta set on macOS, which is what anyone moving a config file between
 *    machines would expect.
 */
export function retiredBindingDefaults(
  platform: string
): Record<string, { from: string; to: string }> {
  const retired: Record<string, { from: string; to: string }> = {
    closeSession: { from: 'Ctrl+W', to: '' }
  }
  if (platform !== 'darwin') return retired

  const mac = new Map(defaultBindings('darwin').map((binding) => [binding.id, binding.keys]))
  for (const binding of DEFAULT_KEYBINDINGS) {
    // `closeSession`'s *current* default is already empty, so the value an old
    // install actually has on disk is the one retired above, not `binding.keys`.
    const from = binding.id === 'closeSession' ? 'Ctrl+W' : binding.keys
    const to = mac.get(binding.id) ?? binding.keys
    if (from && from !== to) retired[binding.id] = { from, to }
  }
  return retired
}

/** Migrate one stored binding value, if it happens to be a retired default. */
export function migrateBindingKeys(platform: string, id: string, keys: string): string {
  const retired = retiredBindingDefaults(platform)[id]
  return retired && keys === retired.from ? retired.to : keys
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

/** The whole settings document as this platform ships it, before anything is stored. */
export function defaultSettings(platform: string): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    terminal: defaultTerminalSettings(platform),
    keybindings: defaultBindings(platform)
  }
}
