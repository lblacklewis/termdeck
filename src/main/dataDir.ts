/**
 * Where the app keeps its data.
 *
 * The default is Electron's `userData`, which is what every store was built
 * against. Letting the user move it needs one thing that lives *outside* the data:
 * a pointer in `userData`, read before any store is constructed. That file is the
 * whole reason this module exists — a setting stored inside the data directory
 * could not tell the app where the data directory is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Files and directories the app owns inside its config directory. */
const OWNED = [
  'settings.json',
  'layout.json',
  'sessions.json',
  'credentials.json',
  '.credential-seed',
  'history'
]

const POINTER = 'data-dir.json'

/**
 * The bootstrap file, in the *default* location.
 *
 * `defaultDir` is `app.getPath('userData')`; the caller passes it in rather than
 * this module importing Electron, so the same code runs in a plain Node script.
 */
export function pointerPath(defaultDir: string): string {
  return join(defaultDir, POINTER)
}

/**
 * The directory the app should actually use.
 *
 * Read synchronously at start-up: every store constructor needs it, and an
 * unusable pointer (missing directory, unreadable file) must fall back rather than
 * leave the app with nowhere to write.
 */
export function resolveDataDir(defaultDir: string, pointer = pointerPath(defaultDir)): string {
  if (!existsSync(pointer)) return defaultDir
  try {
    const raw = JSON.parse(readFileSync(pointer, 'utf8')) as { dataDir?: unknown }
    const dir = typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    if (!dir || dir === defaultDir) return defaultDir
    return dir
  } catch {
    // A corrupt pointer is not worth failing over: the default still works, and
    // the next save rewrites it.
    return defaultDir
  }
}

export interface MoveResult {
  /** Files that were copied into the new directory. */
  copied: string[]
  /** Files that did not exist in the old one, so there was nothing to move. */
  missing: string[]
}

/**
 * Copy the app's data into `target`.
 *
 * Copy, not move: the user is choosing where the app should look from now on, and
 * a half-finished move would be a data-loss bug. A file that is already there is
 * overwritten only if the source exists — the new directory is expected to be
 * empty, and anything else in it is left alone.
 */
export function copyData(from: string, to: string): MoveResult {
  const copied: string[] = []
  const missing: string[] = []
  mkdirSync(to, { recursive: true })
  for (const name of OWNED) {
    const source = join(from, name)
    if (!existsSync(source)) {
      missing.push(name)
      continue
    }
    const target = join(to, name)
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const entry of readdirSync(source)) {
        const inner = join(source, entry)
        if (statSync(inner).isFile()) copyFileSync(inner, join(target, entry))
      }
    } else {
      copyFileSync(source, target)
    }
    copied.push(name)
  }
  return { copied, missing }
}

/** Point the app at `dir` (or back at the default when `dir` is null). */
export function writePointer(defaultDir: string, dir: string | null): void {
  mkdirSync(defaultDir, { recursive: true })
  writeFileSync(pointerPath(defaultDir), JSON.stringify({ dataDir: dir }, null, 2) + '\n', 'utf8')
}
