/**
 * Quitting asks first.
 *
 *   npm run build && electron smoke/quit.cjs --user-data-dir=...
 *
 * Closing the window ends every live SSH login and local shell at once, with no
 * undo, so the window close is held in the main process and handed to the
 * renderer, which shows a normal in-app dialog. This suite drives each path that
 * can reach a quit — the window's X, a second close, Escape, and the quit
 * shortcut — and ends by confirming, which is the only thing that may actually
 * close the window.
 *
 * The report is written incrementally with `fs.writeSync(1, ...)`: the last step
 * really does quit the app, and a buffered pipe write would be lost when the
 * process exits.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const DASH = String.fromCharCode(8212)
let passed = 0
let failed = 0

function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' ' + DASH + ' ' + detail : ''}\n`
  fs.writeSync(1, line)
  if (ok) passed += 1
  else failed += 1
}

/*
 * A check that cannot run on this platform at all is neither a pass nor a failure:
 * print it as SKIP and count it as satisfied, the way smoke/mac.cjs and smoke/nav.cjs
 * do, so the tally stays comparable instead of silently shrinking.
 */
function skip(name, reason) {
  fs.writeSync(1, `SKIP  ${name} ${DASH} ${reason}\n`)
  passed += 1
}

/** Turn a stored chord ('Ctrl+Shift+Q' / 'Meta+Shift+Q') into a KeyboardEvent init. */
function chordEvent(chord) {
  const parts = chord.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((p) => p.trim().toLowerCase())
  const init = { key: key, bubbles: true, cancelable: true }
  if (mods.indexOf('ctrl') >= 0 || mods.indexOf('control') >= 0) init.ctrlKey = true
  if (mods.indexOf('shift') >= 0) init.shiftKey = true
  if (mods.indexOf('alt') >= 0) init.altKey = true
  if (mods.indexOf('meta') >= 0 || mods.indexOf('cmd') >= 0) init.metaKey = true
  return JSON.stringify(init)
}

function finish() {
  fs.writeSync(1, `\n${passed}/${passed + failed} checks passed\n`)
  app.exit(failed === 0 ? 0 : 1)
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerQuitIpc()
  mod.storeAccess().layout.clear()

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  // The wiring under test. `out/main/index.js` is a self-contained app entry and
  // exports nothing, so the suites attach the same function the app uses.
  mod.attachQuitConfirmation(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2600)

  const run = (code) => win.webContents.executeJavaScript(code)
  const dialogUp = () => run('!!document.querySelector("[data-testid=\\"quit-confirm\\"]")')
  const liveSessions = () => mod.sessionManager.list().length

  // A live shell, so the confirmation has a connection to warn about.
  const fitted = await require(path.join(__dirname, 'panestep.cjs')).openFittedShell(win)
  check('a live shell is open before quitting', fitted, 'sessions=' + liveSessions())

  // ---- 1. the window's X asks first ---------------------------------------
  win.close()
  await sleep(800)
  check('closing the window asks before it quits', await dialogUp())
  check('the window is still open while it asks', !win.isDestroyed())
  check('the live connection is untouched while it asks', liveSessions() === 1,
    'sessions=' + liveSessions())
  const detail = await run(
    '(() => { const e = document.querySelector("[data-testid=\\"quit-detail\\"]");' +
      ' return e ? e.textContent : "" })()'
  )
  check('it says how many connections would be closed',
    /1 active connection\b/.test(detail || ''), JSON.stringify(detail))

  // ---- 2. cancel is safe --------------------------------------------------
  await run('document.querySelector("[data-testid=\\"quit-cancel\\"]").click(); true')
  await sleep(400)
  check('cancelling dismisses the question', !(await dialogUp()))
  check('cancelling keeps the window open', !win.isDestroyed())
  check('cancelling leaves the connection alone', liveSessions() === 1,
    'sessions=' + liveSessions())

  // A cancelled quit must not have latched: the X asks again.
  win.close()
  await sleep(800)
  check('closing again asks again', await dialogUp())

  // ---- 3. Escape cancels --------------------------------------------------
  await run(
    'window.dispatchEvent(new KeyboardEvent("keydown",' +
      ' { key: "Escape", bubbles: true, cancelable: true })); true'
  )
  await sleep(400)
  check('Escape cancels the question', !(await dialogUp()))
  check('Escape keeps the window open', !win.isDestroyed())

  // ---- 4. the quit shortcut asks the same question ------------------------
  /*
   * The shortcut only exists where the platform ships one: Windows / Linux bind
   * Ctrl+Shift+Q, macOS deliberately leaves `quitApp` unbound because Quit there is
   * the application menu's Cmd+Q (see MAC_BINDING_DEFAULTS in src/shared/platform.ts,
   * and smoke/mac.cjs which covers that menu item). Pressing a chord that is not
   * bound would be asserting Windows behaviour on a Mac, so on macOS these three are
   * an explicit SKIP — and the confirmation is re-opened below so step 5 still has a
   * dialog to confirm.
   */
  const quitChord = (mod.defaultBindings(process.platform).find((b) => b.id === 'quitApp') || {}).keys
  if (quitChord) {
    await run(
      'window.dispatchEvent(new KeyboardEvent("keydown",' + chordEvent(quitChord) + ')); true'
    )
    await sleep(700)
    check('the quit shortcut opens the same confirmation', await dialogUp(), 'chord=' + quitChord)
    check('the shortcut did not quit on the spot', !win.isDestroyed())
    const shortcutDetail = await run(
      '(() => { const e = document.querySelector("[data-testid=\\"quit-detail\\"]");' +
        ' return e ? e.textContent : "" })()'
    )
    check('the shortcut dialog names the live connection',
      /1 active connection\b/.test(shortcutDetail || ''), JSON.stringify(shortcutDetail))
  } else {
    const why = 'quitApp is unbound on ' + process.platform + ' (Quit is the application menu Cmd+Q)'
    skip('the quit shortcut opens the same confirmation', why)
    skip('the shortcut did not quit on the spot', why)
    skip('the shortcut dialog names the live connection', why)
    win.close()
    await sleep(800)
  }

  // ---- 5. confirming really quits -----------------------------------------
  win.once('closed', () => {
    check('confirming closes the window', true)
    check('the quit was recorded as deliberate', mod.isQuitting())
    finish()
  })

  await run('document.querySelector("[data-testid=\\"quit-confirm-btn\\"]").click(); true')

  // If the close never arrives, say so instead of hanging the suite.
  await sleep(8000)
  check('confirming closes the window', false, 'still open after 8s')
  check('the quit was recorded as deliberate', mod.isQuitting(),
    'isQuitting=' + mod.isQuitting())
  finish()
}

app.whenReady().then(() =>
  main().catch((err) => {
    fs.writeSync(1, `FAIL  quit probe crashed ${DASH} ${String((err && err.message) || err)}\n`)
    app.exit(1)
  })
)
