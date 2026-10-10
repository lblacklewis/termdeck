/**
 * Reset the stores a probe is about to make assertions against.
 *
 * The probes run against the real `userData` directory, and most of them open
 * sessions, save them, and leave them behind. A suite that then asserts "this
 * store contains exactly what I just created" passes on a fresh machine and
 * fails on the second run, which is worse than useless: it teaches you to ignore
 * a red suite.
 *
 *   const { resetStores } = require('./clearstore')
 *   resetStores(['sessions', 'layout'])
 *
 * Call it **before** the first `storeAccess()`: the stores are created lazily on
 * first access and read their file in the constructor, so deleting the file
 * first is enough to start empty. Once a store exists, removing its file would
 * swap it out from under objects the app already holds, and the next write would
 * put the old contents straight back.
 */
const { app } = require('electron')
const { existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const FILES = {
  sessions: 'sessions.json',
  layout: 'layout.json',
  settings: 'settings.json'
}

function resetStores(names) {
  const dir = app.getPath('userData')
  const removed = []
  for (const name of names) {
    const file = join(dir, FILES[name])
    if (!existsSync(file)) continue
    rmSync(file, { force: true })
    removed.push(FILES[name])
  }
  return removed
}

/**
 * Delete a probe's whole userData directory.
 *
 *   const { wipeProfile } = require('./clearstore')
 *   wipeProfile()          // before registerIpc() / storeAccess()

 * `resetStores` deletes the store *files*, which is only enough while the stores
 * have not been constructed yet — they read their file in the constructor, so
 * deleting it afterwards leaves the old contents in memory and the next write puts
 * them straight back on disk. That is a trap: the reset reports success, the run
 * looks clean, and the second run silently starts with the first run's data.
 *
 * This removes the directory itself, so there is nothing to have been cached and
 * nothing to be resurrected. Call it at the very top of `main`, before anything
 * touches a store, and before the window is created.
 */
function wipeProfile() {
  const dir = app.getPath('userData')
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return dir
  } catch {
    // A file still held open by a previous run: fall back to the per-file
    // reset, which is enough when the stores have not been constructed yet.
    return null
  }
}

module.exports = { resetStores, wipeProfile }

