/**
 * Ctrl+W 属于 shell，不属于应用。
 *
 *   npx electron smoke/keys.cjs --user-data-dir=node_modules/.smoke-data/keys
 *
 * Ctrl+W 在 readline 系（bash / zsh / Python / Node REPL）里是"删掉光标前一个词"，
 * 是肌肉记忆。以前它绑在"关闭当前会话"上，于是应用把 shell 要用的键吃掉了 ——
 * 而且光改默认值没用：每个跑过这个应用的机器上，存盘里都躺着旧的 'Ctrl+W'。
 *
 * 所以这里断言两件事，各自都会在旧代码上失败：
 *
 *   1. **默认值**不再是 Ctrl+W（settings 的默认表）；
 *   2. **迁移**：存盘里还是旧默认 'Ctrl+W' 的，读回来变成空；但用户自己改成别的值（如
 *      Ctrl+Shift+W）必须原样留着 —— 迁移不是大锤；
 *   3. **真按键**：焦点在终端里按下 Ctrl+W，终端的**数据通道必须吐出 0x17**（否则那个字节
 *      到不了 PTY），窗格和会话也不许少一个。
 *
 * 真按键用 `sendInputEvent` 送进去，和用户按下去走的是同一条路。
 * "有没有被应用吃掉"不看 defaultPrevented（xterm 自己转发的键也会 preventDefault），
 * 而是看**终端的数据通道有没有吐出 0x17** —— 应用抢键用的是捕获阶段 + stopPropagation，
 * 被抢走的键根本到不了 textarea，也就不会产生任何数据。
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DASH = String.fromCharCode(8212)

const checks = []
const push = (name, ok, detail) =>
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? true : detail })

function report() {
  let failed = 0
  for (const check of checks) {
    const ok = check.ok === true
    if (!ok) failed += 1
    console.log((ok ? 'PASS  ' : 'FAIL  ') + check.name +
      (check.detail === true ? '' : ' ' + DASH + ' ' + String(check.detail ?? '')))
  }
  console.log(String.fromCharCode(10) + (checks.length - failed) + '/' + checks.length + ' checks passed')
  return failed
}

async function main() {
  const guard = setTimeout(() => {
    console.error('keys probe watchdog')
    app.exit(1)
  }, 220000)

  require(path.join(ROOT, 'smoke', 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()
  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({ ...settings, onboarded: true })

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
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
  // The dock API is a debug hook; this probe counts panes to prove none was closed.
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2600)

  // ---- 1. defaults -------------------------------------------------------
  const defaults = await win.webContents.executeJavaScript(
    'window.termdeck.loadSettings().then((s) => s.keybindings)'
  )
  const byId = (list, id) => list.find((entry) => entry.id === id) || { keys: 'MISSING' }
  const closeDefault = byId(defaults, 'closeSession').keys
  push('closing a session is not bound to Ctrl+W out of the box', closeDefault === '',
    "closeSession default='" + closeDefault + "'")
  push('but it is still a binding that can be set', byId(defaults, 'closeSession').id === 'closeSession',
    'listed in the shortcut list=' + (byId(defaults, 'closeSession').id || 'MISSING'))

  // ---- 2. the real key, with the settings still at their defaults ---------
  /*
   * Order matters. This section has to run *before* the migration section below,
   * because that one writes settings: pressing the key after having written an empty
   * binding would prove nothing about the default the app ships with.
   */
  const setup = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    const button = document.querySelector('[data-testid="local-shell"]')
    if (!button) return { error: 'no local-shell button' }
    const before = (await api.listSessions()).length
    button.click()
    const end = Date.now() + 25000
    while (Date.now() < end) {
      if ((await api.listSessions()).length > before) break
      await wait(300)
    }
    const up = (await api.listSessions())[0]
    if (!up) return { error: 'no session' }
    for (let i = 0; i < 60; i += 1) {
      const pane = document.querySelector('[data-terminal-id="' + up.id + '"]')
      if (pane && pane.querySelector('.xterm-rows')) break
      await wait(250)
    }
    await wait(900)
    // Focus the terminal the way a click would.
    const textarea = document.querySelector('[data-terminal-id="' + up.id + '"] .xterm-helper-textarea')
    if (textarea) textarea.focus()
    await wait(300)
    /*
     * Watch the terminal's own data channel.
     *
     * This — not the event's defaultPrevented flag — is the honest signal. xterm calls
     * preventDefault for every key it handles (it has taken the key over, which is
     * exactly right), so a prevented event proves nothing by itself. What matters is
     * whether the byte the shell expects ever gets produced: the app's shortcut matcher
     * listens on window in the *capture* phase and calls stopPropagation, so a key it
     * claims never reaches the textarea and produces no data at all.
     */
    window.__tdBytes = ''
    window.__tdPrevented = 0
    window.__tdTerminals[up.id].term.onData((data) => {
      window.__tdBytes += data
    })
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey &&
          (event.key === 'w' || event.key === 'W')) {
        setTimeout(() => {
          if (event.defaultPrevented) window.__tdPrevented += 1
        }, 0)
      }
    }, true)
    return { id: up.id, sessions: (await api.listSessions()).length }
  })()`)
  push('a local shell is up with focus in the terminal', !!setup.id, setup.error || 'id=' + setup.id)

  if (setup.id) {
    for (let i = 0; i < 3; i += 1) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] })
      await sleep(250)
    }
    await sleep(700)
    const after = await win.webContents.executeJavaScript(`(async () => {
      const api = window.termdeck
      const bytes = window.__tdBytes || ''
      const panels = window.__tdDockApi ? window.__tdDockApi.panels.length : -1
      return {
        // 0x17 is Ctrl+W: what a readline shell reads as delete-previous-word.
        gotCtrlW: bytes.indexOf(String.fromCharCode(23)) >= 0,
        byteCount: bytes.length,
        prevented: window.__tdPrevented || 0,
        sessions: (await api.listSessions()).length,
        panels
      }
    })()`)
    push('Ctrl+W reaches the terminal instead of being eaten',
      after.gotCtrlW === true && after.byteCount > 0,
      'bytes=' + after.byteCount + ' carriedCtrlW=' + after.gotCtrlW +
        ' (prevented=' + after.prevented + ' — xterm takes over keys it forwards, so that is expected)')
    push('and pressing it does not close the session', after.sessions === setup.sessions,
      'sessions before=' + setup.sessions + ' after=' + after.sessions)
    push('nor does it take the pane away', after.panels === 1, 'panels=' + after.panels)
  }

  // ---- 3. 切换窗格后键盘自己跟着走 -----------------------------------------
  /*
   * 用户原话："窗口切换之后默认需要点击一下才能输入；做到切换 session 后直接可以
   * 编辑输入，不操作鼠标"。
   *
   * 之前只有"键盘已经在终端里"这一条路会回焦（activatePanel），鼠标点标签 / 点侧栏
   * 会话行之后焦点停在按钮或 body 上，于是必须再点一下终端。
   *
   * 断言分三层，各自都会在旧代码上失败：
   *   (a) 规则表是纯函数（focusPolicy.ts），按注入的输入逐行断言；
   *   (b) 真窗口里把焦点丢到 body（就是点标签之后的样子），激活另一个窗格，
   *       键盘必须自己落到那个终端的 xterm-helper-textarea 上；
   *   (c) 硬证据：此后不做任何鼠标操作，直接按键，字节必须进**那个**会话的数据通道。
   * 另有一条回归护栏：正在输入的输入框不被抢（旧代码也满足，但改了规则必须守住）。
   */
  try {
    const { buildSync } = require('esbuild')
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-focus-'))
    const entry = path.join(dir, 'entry.ts')
    const policyPath = path
      .join(ROOT, 'src', 'renderer', 'src', 'components', 'focusPolicy.ts')
      .split(path.sep)
      .join('/')
    fs.writeFileSync(entry, 'export * from ' + JSON.stringify(policyPath), 'utf8')
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(dir, 'focusPolicy.cjs'),
      logLevel: 'silent'
    })
    const policy = require(path.join(dir, 'focusPolicy.cjs'))
    const home = (terminal, editable, modal) => ({ terminal: terminal, editable: editable, modal: modal })
    push('nothing focused at all: the pane takes the keyboard',
      policy.shouldPaneTakeFocus(null) === true)
    push('typing in a shell: switching panes follows the keyboard',
      policy.shouldPaneTakeFocus(home(true, true, false)) === true,
      'the terminal own textarea is a textarea too, so it must be recognised first')
    push('typing in a field: the caret stays where it is',
      policy.shouldPaneTakeFocus(home(false, true, false)) === false)
    push('a modal is open: it keeps the keyboard',
      policy.shouldPaneTakeFocus(home(false, false, true)) === false)
    push('a plain button or the page body: the pane takes it',
      policy.shouldPaneTakeFocus(home(false, false, false)) === true)
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    push('the focus rule could not be bundled', false,
      String((err && err.message) || err))
  }

  const opened = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    const button = document.querySelector('[data-testid="local-shell"]')
    if (!button) return { error: 'no local-shell button' }
    const before = (await api.listSessions()).length
    button.click()
    const end = Date.now() + 25000
    while (Date.now() < end) {
      const panes = window.__tdDockApi ? window.__tdDockApi.panels.length : 0
      if ((await api.listSessions()).length > before && panes >= 2) break
      await wait(300)
    }
    for (let i = 0; i < 60; i += 1) {
      const terms = window.__tdTerminals ? Object.keys(window.__tdTerminals).length : 0
      if (terms >= 2) break
      await wait(250)
    }
    return {
      sessions: (await api.listSessions()).length,
      panes: window.__tdDockApi ? window.__tdDockApi.panels.length : -1,
      terminals: window.__tdTerminals ? Object.keys(window.__tdTerminals).length : 0
    }
  })()`)
  push('a second pane is open to switch to',
    opened.panes >= 2 && opened.terminals >= 2, JSON.stringify(opened))

  const switched = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const dock = window.__tdDockApi
    const ids = dock.panels.map((p) => p.id).filter((id) => id !== 'welcome')
    const active = dock.activePanel ? dock.activePanel.id : null
    const other = ids.find((id) => id !== active)
    if (!other) return { error: 'no other pane to switch to' }
    // What a click on a tab leaves behind: the tab is a div, so focus falls to body.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
    const before = document.activeElement
      ? document.activeElement.tagName + '.' + document.activeElement.className
      : 'none'
    dock.getPanel(other).api.setActive()
    await wait(600)
    const element = document.activeElement
    // Watch that pane's own data channel: a keystroke reaching this shell must
    // show up here, which is stronger than reading who owns the focus.
    window.__tdSwitchBytes = ''
    const holder = window.__tdTerminals[other]
    if (holder) holder.term.onData((data) => { window.__tdSwitchBytes += data })
    return {
      other: other,
      before: before,
      after: element ? element.tagName + '.' + element.className : 'none',
      inTerminal: !!(element && element.classList &&
        element.classList.contains('xterm-helper-textarea')),
      hasTerminal: !!holder
    }
  })()`)
  push('switching panes gives the keyboard to the new pane by itself',
    switched.inTerminal === true && switched.hasTerminal === true,
    switched.error || ('focus was ' + switched.before + ' -> ' + switched.after))

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'X' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'X' })
  await sleep(500)
  const typed = await win.webContents.executeJavaScript(
    '({ bytes: window.__tdSwitchBytes || "" })'
  )
  push('and the next keystroke reaches that session without touching the mouse',
    typed.bytes.indexOf('x') >= 0 || typed.bytes.indexOf('X') >= 0,
    'bytes=' + JSON.stringify(typed.bytes))

  const guarded = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const dock = window.__tdDockApi
    const ids = dock.panels.map((p) => p.id).filter((id) => id !== 'welcome')
    const active = dock.activePanel ? dock.activePanel.id : null
    const other = ids.find((id) => id !== active)
    const field = document.querySelector('[data-testid="tree-search"]')
    if (!other) return { error: 'no other pane to switch to' }
    if (!field) return { error: 'no session search field' }
    field.focus()
    const wasThere = document.activeElement === field
    dock.getPanel(other).api.setActive()
    await wait(400)
    return {
      wasThere: wasThere,
      stillThere: document.activeElement === field,
      after: document.activeElement ? document.activeElement.tagName : 'none'
    }
  })()`)
  push('a field being typed in keeps the caret when panes switch behind it',
    guarded.wasThere === true && guarded.stillThere === true,
    guarded.error || ('before=' + guarded.wasThere + ' after=' + guarded.stillThere +
      ' focus=' + guarded.after))

  // ---- 4. migration, for installs that already have the old value ---------
  const migrated = await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const settings = await api.loadSettings()
    const withOld = settings.keybindings.map((b) =>
      b.id === 'closeSession' ? { ...b, keys: 'Ctrl+W' } : b)
    await api.saveSettings({ ...settings, keybindings: withOld })
    const afterOld = await api.loadSettings()
    const withOwn = afterOld.keybindings.map((b) =>
      b.id === 'closeSession' ? { ...b, keys: 'Ctrl+Shift+W' } : b)
    await api.saveSettings({ ...afterOld, keybindings: withOwn })
    const afterOwn = await api.loadSettings()
    return {
      storedOld: afterOld.keybindings.find((b) => b.id === 'closeSession').keys,
      storedOwn: afterOwn.keybindings.find((b) => b.id === 'closeSession').keys
    }
  })()`)
  push('an existing install keeps the old default migrated away', migrated.storedOld === '',
    "after loading a file that said Ctrl+W: '" + migrated.storedOld + "'")
  push('a chord the user chose is left alone', migrated.storedOwn === 'Ctrl+Shift+W',
    "after loading a file that said Ctrl+Shift+W: '" + migrated.storedOwn + "'")

  clearTimeout(guard)
  win.destroy()
  const code = report() === 0 ? 0 : 1
  fs.writeFileSync(
    path.join(ROOT, 'node_modules', '.smoke-data', 'keys-last.json'),
    JSON.stringify(checks, null, 2)
  )
  app.exit(code)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('keys probe crashed: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  })
)
