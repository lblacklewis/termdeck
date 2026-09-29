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

const run = promisify(execFile)

/** Fonts every desktop is likely to have, used when enumeration fails. */
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
 * The list the picker shows: installed fonts that look monospaced, followed by
 * the bundled shortlist so a good default is always selectable.
 */
export async function listFontChoices(): Promise<{ monospace: string[]; others: string[] }> {
  const installed = await listInstalledFonts()
  const monospace = installed.filter((name) => MONO_HINT.test(name)).sort((a, b) => a.localeCompare(b))

  // Everything else is still offered: some people want a proportional font, and
  // excluding them would be a silent, unexplainable omission.
  const monoSet = new Set(monospace)
  const others = installed.filter((name) => !monoSet.has(name)).sort((a, b) => a.localeCompare(b))

  for (const name of FALLBACK_MONOSPACE_FONTS) {
    if (!monoSet.has(name)) monospace.push(name)
  }

  return { monospace, others }
}
