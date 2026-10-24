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
import { BUNDLED_MONOSPACE_FONTS, fallbackMonospaceFonts } from '../shared/platform'
import type { FontChoices } from '../shared/types'

const run = promisify(execFile)

export { BUNDLED_MONOSPACE_FONTS }

/** Heuristic: fonts whose name suggests fixed width. */
const MONO_HINT = /mono|consol|courier|terminal|fixed|code|hack|inconsolata|menlo/i

/**
 * Family names out of `system_profiler SPFontsDataType -json`.
 *
 * macOS has no `fc-list`, so the enumeration goes through `system_profiler`,
 * which prints one dictionary per font: `_name` is the registered family name
 * (what a CSS `font-family` and xterm's `fontFamily` match on), while `path` is
 * a file name that would make a nonsense picker. The nesting of this report has
 * changed between macOS releases, so every `_name` in the document is collected
 * rather than one level guessed at.
 *
 * Kept separate from the process call so it can be tested with a fixture: the
 * shape of this output is the only thing that can be checked off a Mac.
 */
export function parseMacFontFamilies(stdout: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }

  const names = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (typeof record['_name'] === 'string') {
      const name = record['_name'].trim()
      if (name && name.length < 64) names.add(name)
    }
    // Every nested value, not just `_items`: the report shape has changed between
    // macOS releases, and the one thing that must not happen is parsing it into an
    // empty list while the data was right there under another key.
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parsed)

  return [...names]
}

/**
 * Enumerate installed font families.
 *
 * Windows reads the registry through PowerShell, Linux uses `fc-list`, macOS
 * goes through `system_profiler` (which is slow, hence the timeout and the
 * caller's cache). Any failure at all returns an empty list.
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

    if (process.platform === 'darwin') {
      // The whole font catalogue is a few MB of JSON and takes seconds on a cold
      // cache — on a CI runner it has taken long enough to hit a 20s limit. The
      // caller keeps the result for the life of the process, so a generous timeout
      // costs nothing after the first call.
      //
      // Absolute path: a GUI-launched app inherits launchd's PATH, which is not
      // guaranteed to include /usr/sbin. A missing `system_profiler` would silently
      // empty the picker, which is exactly the kind of failure nobody reports.
      const { stdout } = await run('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], {
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024
      })
      return parseMacFontFamilies(stdout)
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

  const suggested = fallbackMonospaceFonts(process.platform).filter(
    (name) => !offered.has(name.toLowerCase()) && !installedLower.has(name.toLowerCase())
  )

  return { bundled, monospace, others, suggested }
}
