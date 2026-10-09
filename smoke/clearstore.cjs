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

module.exports = { resetStores }
