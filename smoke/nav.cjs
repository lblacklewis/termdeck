/**
 * Session switching by keyboard.
 *
 *   npm run build && electron smoke/nav.cjs --user-data-dir=...
 *
 * The jump keys are the platform's own: Alt+digit on Windows/Linux, Cmd+digit on
 * macOS (sessionJumpModifier). They must land on the session at that position in
 * the arrangement; the platform's own step chords (Alt+[ / Alt+] on Windows/Linux,
 * Cmd+Alt+arrows on macOS) must walk the same list and wrap at both ends; and a
 * digit past the last session must do nothing at all. The rail is checked too, in
 * the other direction: these keys used to switch pages, and the rail must now stay
 * exactly where the user left it, which is what makes the change visible as a
 * change rather than as two keys that happen to do something.
 *
 * The menu checks are platform-dependent as well: Windows and Linux remove the
 * application menu outright (which is why Alt can no longer reveal a menu bar),
 * while macOS ships the standard App/Edit/Window menu and draws it in the system
 * menu bar, not over the layout.
 */
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const SUITE = 'nav.cjs'
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    // 平台推导不出来的检查显式 SKIP：打印出来、不计入失败，也不假装它通过了。
    if (c.skip) {
      console.log('SKIP  ' + SUITE + ':' + c.name + ' ' + DASH + ' ' + c.detail)
      all.push({ name: c.name, ok: true, detail: 'SKIP ' + DASH + ' ' + c.detail, skip: true })
      continue
    }
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

  /*
   * 按键按平台推导，不写死 Windows 那一组。
   *
   * 跳会话的修饰键来自 sessionJumpModifier（Windows 是 Alt，mac 是 Cmd），换会话的
   * chord 来自该平台的默认键位表 —— mac 上是 Cmd+Alt+左右，不是 Alt+[ / Alt+]。
   * 平台表本身由 smoke/mac.cjs 断言，这里断言的是「按本平台的键，行为对」。
   */
  const bindings = mod.defaultBindings(process.platform)
  const chordOf = (id) => {
    const found = bindings.find((b) => b.id === id)
    return found ? found.keys : ''
  }
  const jumpModifier = mod.sessionJumpModifier(process.platform)
  const jumpMod = jumpModifier === 'meta' ? { metaKey: true } : { altKey: true }
  const jumpLabel = jumpModifier === 'meta' ? 'Cmd' : 'Alt'
  /** 把一条 chord 拆成 KeyboardEvent 需要的按键与修饰键。 */
  const chordEvent = (chord) => {
    const parts = chord.split('+').map((p) => p.trim())
    const isMod = (p) =>
      ['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command'].indexOf(
        p.toLowerCase()
      ) >= 0
    const has = (names) => parts.some((p) => names.indexOf(p.toLowerCase()) >= 0)
    return {
      key: parts.filter((p) => !isMod(p)).pop() || '',
      ctrlKey: has(['ctrl', 'control']),
      shiftKey: has(['shift']),
      altKey: has(['alt', 'option']),
      metaKey: has(['meta', 'cmd', 'command'])
    }
  }
  const prevChord = chordEvent(chordOf('prevPage'))
  const nextChord = chordEvent(chordOf('nextPage'))
  const prevLabel = mod.displayChord(chordOf('prevPage'), process.platform)
  const nextLabel = mod.displayChord(chordOf('nextPage'), process.platform)

  // The app entry does this before creating its window; the probes build their own
  // window, so they have to ask for the same thing. On Windows and Linux this is the
  // same "no application menu" it has always been; on macOS it installs the standard
  // App / Edit / Window menu (the checks further down are platform-aware).
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
      /* 本平台的按键（主进程按平台算好）：跳会话的修饰键 + 换会话的两条 chord。 */
      const JUMP = ${JSON.stringify(jumpMod)}
      const JUMP_LABEL = ${JSON.stringify(jumpLabel)}
      const PREV = ${JSON.stringify(prevChord)}
      const NEXT = ${JSON.stringify(nextChord)}
      const PREV_LABEL = ${JSON.stringify(prevLabel)}
      const NEXT_LABEL = ${JSON.stringify(nextLabel)}
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
        '6': 54, '7': 55, '8': 56, '9': 57, '[': 219, ']': 221,
        ArrowLeft: 37, ArrowRight: 39
      }
      /*
       * 按的是本平台的那一组键，不是 Windows 那组写死的键：
       * 跳会话是 JUMP + digit（Alt 或 Cmd），换会话是 PREV / NEXT 两条 chord。
       */
      const press = async (event) => {
        const target = document.activeElement || document.body
        const code = KEY_CODES[event.key] || 0
        target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
          keyCode: code, which: code,
          bubbles: true, cancelable: true, composed: true
        }, event)))
        await wait(450)
      }
      /** Alt+digit / Cmd+digit：修饰键是该平台自己的那一个。 */
      const jumpKey = (digit) => Object.assign({ key: digit }, JUMP)
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

        step = 'jump digits'
        await press(jumpKey('2'))
        push(JUMP_LABEL + '+2 goes to the second session', activeTab() === ids[1], state())
        await press(jumpKey('1'))
        push(JUMP_LABEL + '+1 goes to the first session', activeTab() === ids[0], state())
        await press(jumpKey('3'))
        push(JUMP_LABEL + '+3 goes to the third session', activeTab() === ids[2], state())

        // Out of range: a fourth session does not exist, and nothing should happen.
        await press(jumpKey('4'))
        push('a digit past the last session is ignored', activeTab() === ids[2], state())

        step = 'bracket stepping'
        await press(jumpKey('1'))
        await press(NEXT)
        push(NEXT_LABEL + ' steps forward', activeTab() === ids[1], state())
        await press(PREV)
        push(PREV_LABEL + ' steps back', activeTab() === ids[0], state())

        step = 'wrapping'
        // Backwards from the first must land on the last, and forwards from the
        // last must land back on the first: neither end is a dead stop.
        await press(PREV)
        push('stepping back from the first wraps to the last', activeTab() === ids[2], state())
        await press(NEXT)
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

  /*
   * The menu check has to be made from the main process: the renderer cannot see
   * whether an application menu exists, and the layout shift it used to cause is
   * exactly what the shortcut family had to be safe against.
   *
   * 按平台：Windows / Linux 上应用没有菜单（Alt 也就翻不出菜单栏）；macOS 上
   * App / Edit / Window 是按设计存在的系统菜单栏，Cmd+C/V 就靠它，所以在 mac 上
   * 断言的是「菜单存在」，并且不再假装窗口级菜单栏这个概念在 mac 上有意义。
   */
  const isMac = process.platform === 'darwin'
  const appMenu = Menu.getApplicationMenu()
  report([
    isMac
      ? {
          name: 'macOS 上按设计有应用菜单（Cmd+C/V 来自它的 Edit 菜单）',
          ok: appMenu !== null,
          detail: 'menu=' + (appMenu ? 'installed' : 'none')
        }
      : {
          name: 'the application menu is removed, so Alt cannot reveal one',
          ok: appMenu === null,
          detail: 'menu=' + (appMenu ? 'installed' : 'none')
        },
    isMac
      ? {
          name: 'the menu bar cannot appear over the layout',
          ok: true,
          skip: true,
          detail:
            'macOS 的菜单固定在系统菜单栏，窗口级菜单栏是 Windows/Linux 的概念（本机 ' +
            process.platform + '）'
        }
      : {
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
