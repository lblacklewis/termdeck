/**
 * Session switching by keyboard.
 *
 *   npm run build && electron smoke/nav.cjs --user-data-dir=...
 *
 * `Alt`+digit must land on the session at that position in the arrangement,
 * `Alt+[` / `Alt+]` must walk the same list and wrap at both ends, and a digit
 * past the last session must do nothing at all. The rail is checked too, in the
 * other direction: these keys used to switch *pages*, and the rail must now stay
 * exactly where the user left it, which is what makes the change visible as a
 * change rather than as two keys that happen to do something.
 *
 * Also checks that the menu bar cannot appear over the layout, since the
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
  // window, so they have to ask for the same thing. On Windows and Linux this is the
  // same "no application menu" it has always been.
  mod.installApplicationMenu({
    appName: 'TermDeck',
    askQuit: function () {}
  })

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
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          if (await fn()) return true
          await wait(150)
        }
        return false
      }
      /** Which rail entry the app says is current. */
      const railPage = () =>
        document.querySelector('.td-rail [aria-current="page"]')?.getAttribute('data-page') ?? null
      /*
       * The session tabs, in the order dockview lays them out. That order is the
       * contract: 1 is the first tab the user can see.
       */
      const tabs = () => [...document.querySelectorAll('.dv-tab[data-tab-panel-id]')]
      const tabIds = () => tabs().map((t) => t.getAttribute('data-tab-panel-id'))
      const activeTab = () => {
        const tab = tabs().find((t) => t.classList.contains('dv-active-tab'))
        return tab ? tab.getAttribute('data-tab-panel-id') : null
      }
      /*
       * Dispatched at whatever holds focus, not at the window.
       *
       * The listener is on the window, but a real key press travels a real path to
       * get there — through xterm's own key handling, since the pane is what has
       * focus. Dispatching straight at the window would skip that path and report
       * a working shortcut for a key the terminal actually swallows.
       *
       * The legacy keyCode matters as much as key here: a KeyboardEvent built by
       * hand defaults it to 0, and xterm dispatches on keyCode, so a press without
       * one is a press the terminal silently ignores — the probe would be testing
       * a key that behaves nothing like the real one.
       */
      const KEY_CODES = {
        '1': 49, '2': 50, '3': 51, '4': 52, '5': 53,
        '6': 54, '7': 55, '8': 56, '9': 57, '[': 219, ']': 221
      }
      const key = async (k, opts) => {
        const target = document.activeElement || document.body
        const code = KEY_CODES[k] || 0
        target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
          key: k, keyCode: code, which: code,
          bubbles: true, cancelable: true, composed: true
        }, opts)))
        await wait(450)
      }
      /** Put the keyboard inside a pane, the way clicking one does. */
      const focusPane = async (id) => {
        const entry = (window.__tdTerminals || {})[id]
        if (entry && entry.term && entry.term.focus) entry.term.focus()
        await wait(300)
      }
      /** True when the key events below are landing in a real terminal. */
      const inTerminal = () => {
        const el = document.activeElement
        return !!el && (el.className || '').indexOf('xterm-helper-textarea') !== -1
      }
      const state = () => 'active=' + String(activeTab()).slice(0, 8) +
        ' rail=' + railPage() + ' tabs=' + tabIds().length

      let step = 'start'
      try {
        step = 'open sessions'
        if (!document.querySelector('.td-sidebar')) {
          const toggle = document.querySelector('[data-testid="rail-toggle"]')
          if (toggle) toggle.click()
          await wait(700)
        }
        const shell = () => document.querySelector('[data-testid="local-shell"]')
        push('the drawer offers a local shell to open sessions with', !!shell())
        if (!shell()) return out

        for (let n = 1; n <= 3; n++) {
          shell().click()
          const up = await waitFor(() => tabIds().length >= n, 15000)
          if (!up) {
            push('session ' + n + ' opens a pane', false, state())
            return out
          }
        }
        await wait(900)
        const ids = tabIds()
        push('three sessions are open as three tabs', ids.length === 3,
          'tabs=' + ids.length + ' ids=' + ids.map((i) => String(i).slice(0, 8)).join(','))

        /*
         * The keyboard has to be *in a terminal* for the rest of this to mean
         * anything: a key dispatched at a button would bubble to the same window
         * listener while proving nothing about typing in a pane.
         */
        await focusPane(activeTab())
        push('the keyboard is in a terminal, so the shortcuts are tested where they are used',
          inTerminal(),
          'focus=' + (document.activeElement
            ? document.activeElement.className || document.activeElement.tagName
            : 'none'))

        step = 'alt digits'
        await key('2', { altKey: true })
        push('Alt+2 goes to the second session', activeTab() === ids[1], state())
        await key('1', { altKey: true })
        push('Alt+1 goes to the first session', activeTab() === ids[0], state())
        await key('3', { altKey: true })
        push('Alt+3 goes to the third session', activeTab() === ids[2], state())

        // Out of range: a fourth session does not exist, and nothing should happen.
        await key('4', { altKey: true })
        push('a digit past the last session is ignored', activeTab() === ids[2], state())

        step = 'bracket stepping'
        await key('1', { altKey: true })
        await key(']', { altKey: true })
        push('Alt+] steps forward', activeTab() === ids[1], state())
        await key('[', { altKey: true })
        push('Alt+[ steps back', activeTab() === ids[0], state())

        step = 'wrapping'
        // Backwards from the first must land on the last, and forwards from the
        // last must land back on the first: neither end is a dead stop.
        await key('[', { altKey: true })
        push('stepping back from the first wraps to the last', activeTab() === ids[2], state())
        await key(']', { altKey: true })
        push('stepping forward from the last wraps to the first', activeTab() === ids[0], state())

        step = 'rail untouched'
        /*
         * The regression guard. These keys used to cycle rail sections, so the
         * three sessions above must not have moved the rail off Terminal; if they
         * did, the shortcuts are still page navigation wearing new labels.
         */
        push('switching sessions never changes the rail page', railPage() === 'terminal',
          'rail=' + railPage())
        push('the drawer is still the Terminal page drawer',
          !!document.querySelector('.td-sidebar') && !!document.querySelector('.td-dockview'),
          'sidebar=' + !!document.querySelector('.td-sidebar'))
        // Switching panes must not push the keyboard out of the terminal: the
        // whole point is that you keep typing where you were typing.
        push('and the keyboard is still in a terminal afterwards', inTerminal(),
          'focus=' + (document.activeElement
            ? document.activeElement.className || document.activeElement.tagName
            : 'none'))

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
