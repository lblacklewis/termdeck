/**
 * Installed font enumeration.
 *
 * The settings dialog offers a font picker, which is only useful if it lists
 * what the machine actually has. Rather than shipping a hardcoded list of
 * fonts the user may not own, the names are read from the platform.
 *
 * This is a convenience, never a dependency: any failure returns an empty list
 * and the UI falls back to a bundled shortlist, so a locked-down machine still
 * gets a working picker.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FontChoices } from '../shared/types'

const run = promisify(execFile)

/**
 * Terminal faces that ship inside the app.
 *
 * These are the ones people expect to be able to choose for a terminal and which
 * a machine very often does not have. The @font-face rules in `global.css` carry
 * the same two names, so picking one of these always renders — whereas the rest of
 * the fallback list below only ever produced a silent fallback.
 */
export const BUNDLED_MONOSPACE_FONTS = ['Roboto Mono', 'JetBrains Mono']

/** Fonts every desktop is likely to have, used as autocomplete suggestions. */
export const FALLBACK_MONOSPACE_FONTS = [
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

/** Heuristic: fonts whose name suggests fixed width. */
const MONO_HINT = /mono|consol|courier|terminal|fixed|code|hack|inconsolata|menlo/i

/**
 * Enumerate installed font families.
 *
 * Windows reads the registry through PowerShell, Linux uses `fc-list`. macOS
 * would need a different route and simply falls back, which is honest: the
 * picker still works, it just offers the shortlist.
 */
export async function listInstalledFonts(): Promise<string[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Registered family names, not font file names: the registry keys hold
          // entries like "arial.ttf", which would make a nonsense picker.
          'Add-Type -AssemblyName System.Drawing; ' +
            '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ' +
            'ForEach-Object { $_.Name } | Sort-Object -Unique'
        ],
        { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
      )
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line.length < 64)
    }

    if (process.platform === 'linux') {
      const { stdout } = await run('fc-list', [':', 'family'], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024
      })
      // fc-list prints comma-separated aliases per font; take the first of each.
      const names = new Set<string>()
      for (const line of stdout.split('\n')) {
        for (const part of line.split(',')) {
          const name = part.trim()
          if (name) names.add(name)
        }
      }
      return [...names]
    }
  } catch {
    // Enumeration is best-effort by design.
    return []
  }
  return []
}

/**
 * What the picker shows.
 *
 * The bundled faces come first and are always selectable. After them come the
 * installed families, split by the monospace heuristic. The shortlist of fonts a
 * desktop "probably" has is *not* mixed in any more: it used to be appended to the
 * monospaced list, so the picker offered names that were not installed at all and
 * picking one changed nothing. Those names survive only as `suggested`, for
 * autocomplete, and the UI says so.
 */
export async function listFontChoices(): Promise<FontChoices> {
  const installed = await listInstalledFonts()
  const bundled = [...BUNDLED_MONOSPACE_FONTS]

  const monospace = installed
    .filter((name) => MONO_HINT.test(name) && !bundled.includes(name))
    .sort((a, b) => a.localeCompare(b))

  const offered = new Set([...bundled, ...monospace].map((name) => name.toLowerCase()))
  const installedLower = new Set(installed.map((name) => name.toLowerCase()))

  // Everything else installed is still offered: some people want a proportional
  // font, and excluding them would be a silent, unexplainable omission.
  const others = installed.filter((name) => !offered.has(name.toLowerCase())).sort((a, b) => a.localeCompare(b))

  const suggested = FALLBACK_MONOSPACE_FONTS.filter(
    (name) => !offered.has(name.toLowerCase()) && !installedLower.has(name.toLowerCase())
  )

  return { bundled, monospace, others, suggested }
}
