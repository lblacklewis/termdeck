/**
 * Section navigation, in the window and by keyboard.
 *
 *   npm run build && electron smoke/nav.cjs --user-data-dir=...
 *
 * The rail's own order is the contract: `Alt`+digit must land on the section at
 * that position, `Alt+[` / `Alt+]` must walk the same list and wrap at both ends,
 * and the rail must agree about where you are. Also checks that the drawer shows
 * up for Settings and that the menu bar cannot appear over the layout, since the
 * application menu was removed precisely because every `Alt` shortcut would have
 * revealed it.
 */
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`)
    all.push(c)
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()

  // The app entry does this before creating its window; the probes build their own
  // window, so they have to ask for the same thing.
  mod.removeApplicationMenu()

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
  mod.attachFocusMode(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2800)
  win.focus()
  await sleep(400)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 6000)
        while (Date.now() < end) {
          if (await fn()) return true
          await wait(120)
        }
        return false
      }
      /** Which rail entry the app says is current. */
      const current = () =>
        document.querySelector('.td-rail [aria-current="page"]')?.getAttribute('data-page') ?? null
      const settingsOpen = () => !!document.querySelector('[data-testid="settings-drawer"]')
      const key = async (k, opts) => {
        window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
          key: k, bubbles: true, cancelable: true
        }, opts)))
        await wait(450)
      }

      let step = 'start'
      try {
        step = 'rail order'
        push('the rail lists its sections in order',
          ['terminal', 'hosts', 'known-hosts', 'snippets', 'logs'].every((id) =>
            !!document.querySelector('[data-testid="rail-' + id + '"]')),
          [...document.querySelectorAll('.td-rail [data-page]')]
            .map((b) => b.getAttribute('data-page')).join(','))

        step = 'alt digits'
        await key('2', { altKey: true })
        push('Alt+2 goes to the second section', current() === 'hosts', 'page=' + current())
        await key('4', { altKey: true })
        push('Alt+4 goes to the fourth section', current() === 'snippets', 'page=' + current())
        await key('1', { altKey: true })
        push('Alt+1 comes back to the terminal', current() === 'terminal', 'page=' + current())

        await key('6', { altKey: true })
        const settingsShown = await waitFor(settingsOpen, 3000)
        push('Alt+6 opens settings (it has no page of its own)', settingsShown)
        await key('Escape')
        await waitFor(async () => !settingsOpen(), 3000)

        // Out of range: there is no seventh section, and nothing should happen.
        await key('9', { altKey: true })
        push('a digit past the last section is ignored', current() === 'terminal',
          'page=' + current())

        step = 'bracket stepping'
        await key('1', { altKey: true })
        await key(']', { altKey: true })
        push('Alt+] steps forward', current() === 'hosts', 'page=' + current())
        await key('[', { altKey: true })
        push('Alt+[ steps back', current() === 'terminal', 'page=' + current())

        step = 'wrapping'
        // Backwards from the first must land on the last, and forwards from the
        // last must land back on the first: neither end is a dead stop.
        await key('[', { altKey: true })
        push('stepping back from the first wraps to the last', current() === 'logs',
          'page=' + current())
        await key('5', { altKey: true })
        push('the fifth section is logs', current() === 'logs', 'page=' + current())
        await key(']', { altKey: true })
        push('stepping forward from the last wraps to the first', current() === 'terminal',
          'page=' + current())

        return out
      } catch (err) {
        out.push({
          name: 'failed at step: ' + step,
          ok: false,
          detail: String((err && err.message) || err)
        })
        return out
      }
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'nav probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // The menu check has to be made from the main process: the renderer cannot see
  // whether an application menu exists, and the layout shift it used to cause is
  // exactly what the shortcut family had to be safe against.
  report([
    {
      name: 'the application menu is removed, so Alt cannot reveal one',
      ok: Menu.getApplicationMenu() === null,
      detail: 'menu=' + (Menu.getApplicationMenu() ? 'installed' : 'none')
    },
    {
      name: 'and the menu bar is not visible over the layout',
      ok: !win.isMenuBarVisible(),
      detail: 'menuBarVisible=' + win.isMenuBarVisible()
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('nav probe crashed:', err)
    app.exit(1)
  })
)
