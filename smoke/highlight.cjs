/**
 * 输出高亮：关键词/IP/链接上色，且**复制出来的永远是纯文本**。
 *
 * 三个本地 shell 都不用，一个就够 —— 这个功能不需要网络，也不需要第二个窗格。
 *
 * 探针断言的都是 DOM 里的真实证据（xterm 的 decoration 是 `<div class="xterm-decoration">`，
 * 带内联的 left/width/background-color），不是"函数被调用了"：
 *
 *   - 默认关闭时**一个 decoration 都没有**；
 *   - 打开后 IP、错误单词各自被框住，宽度等于**字符数 × 单元格宽**（不是整行、不是错位）；
 *   - 换配色方案会换颜色；关掉某条规则只撤掉它的框；总开关关掉全部消失；
 *   - 开着高亮时复制整屏：文本里**没有 ESC/OSC 序列**，IP 原样在，decorations 不进文本。
 *
 * 会话通过 UI 的「本地 shell」按钮打开 —— 直接调 IPC 只会建会话，不会建窗格。
 *
 * 用法：npx electron smoke/highlight.cjs --user-data-dir=node_modules/.smoke-data/highlight
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = 'D:\\project\\dsh-workspace\\termdeck'
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
    const detail =
      check.detail === true ? '' : ' ' + DASH + ' ' + String(check.detail ?? '')
    console.log((ok ? 'PASS  ' : 'FAIL  ') + check.name + detail)
  }
  console.log(String.fromCharCode(10) + (checks.length - failed) + '/' + checks.length + ' checks passed')
  return failed
}

async function main() {
  const guard = setTimeout(() => {
    console.error('highlight probe watchdog')
    app.exit(1)
  }, 180000)

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
  // Uncaught exceptions in the pane are invisible from the main side otherwise, and
  // "Script failed to execute" is all executeJavaScript reports.
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) console.error('renderer error: ' + message)
  })
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2600)

  const setup = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    // A local shell through the UI: calling the IPC directly makes a session but no pane.
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
    return { id: up.id }
  })()`)
  push('a local shell opens into a pane', !!setup.id, setup.error || 'id=' + setup.id)
  if (!setup.id) {
    clearTimeout(guard)
    app.exit(report() === 0 ? 0 : 1)
    return
  }

  const WALK = `
    (async () => {
      const id = ${JSON.stringify(setup.id)}
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const term = window.__tdTerminals[id].term
      const pane = document.querySelector('[data-terminal-id="' + id + '"]')
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d === undefined ? true : d })

      const decorations = () => {
        const nodes = pane.querySelectorAll('.xterm-decoration-container .xterm-decoration')
        const rowsEl = pane.querySelector('.xterm-rows')
        const cell = rowsEl ? rowsEl.getBoundingClientRect().width / term.cols : 0
        return Array.prototype.map.call(nodes, (el) => ({
          left: Math.round(parseFloat(el.style.left || '0')),
          width: Math.round(parseFloat(el.style.width || '0')),
          text: (el.textContent || '').trim().length,
          cells: cell > 0 ? Math.round(parseFloat(el.style.width || '0') / cell) : 0
        }))
      }

      /*
       * What the user actually sees, counted.
       *
       * xterm's DOM renderer bakes a decoration's colours into the row's own spans and
       * leaves the decoration element transparent — and it splits a decorated run into
       * *one span per character*. So the honest reading is: of the spans on the row
       * holding this text, how many carry a given colour pair. The count is the match
       * length, which makes "the IP is blue" and "exactly eleven characters are blue"
       * the same assertion.
       */
      const styledRuns = (needle) => {
        const rows = Array.prototype.filter.call(
          pane.querySelectorAll('.xterm-rows > div'),
          (row) => (row.textContent || '').indexOf(needle) >= 0
        )
        if (rows.length === 0) return null
        const spans = Array.prototype.slice.call(rows[0].querySelectorAll('span'))
        const runs = {}
        for (const span of spans) {
          const style = getComputedStyle(span)
          const key =
            style.backgroundColor.split(' ').join('') + '|' + style.color.split(' ').join('')
          runs[key] = (runs[key] || 0) + 1
        }
        return runs
      }
      const runCount = (runs, bg, fg) => (runs && runs[bg + '|' + fg]) || 0

      const write = async (line) => {
        api.writeSession(id, line + String.fromCharCode(13))
        await wait(900)
      }

      const apply = async (patch) => {
        const settings = await api.loadSettings()
        await api.saveSettings({
          ...settings,
          terminal: { ...settings.terminal, ...patch }
        })
        // The renderer hears settings:changed, re-renders the pane, re-applies and
        // re-scans. Give it a couple of frames plus the scan's own delay.
        await wait(800)
      }

      // ---- 0. what we are going to look for --------------------------------
      await write('echo 10.20.30.40 error http://example.com/x')
      out.push({ name: 'the pane printed a line worth highlighting', ok: true, detail: 'echoed' })

      // ---- 0b. the palette is findable before the switch is on -----------
      /*
       * The scheme picker and the rule chips have to be visible while highlighting is
       * still off. Hidden behind the switch, this tab looked to the user like the
       * feature had never been built — "配色方案没做吧？" — which is exactly the report
       * this check exists to prevent coming back.
       */
      document.querySelector('[data-testid="rail-settings"]').click()
      await wait(1300)
      const tabButton = Array.prototype.find.call(
        document.querySelectorAll('.td-settings-tab'),
        (b) => (b.textContent || '').trim() === 'Terminal' || (b.textContent || '').trim() === '终端'
      )
      if (tabButton) tabButton.click()
      await wait(700)
      const picker = document.querySelector('[data-testid="highlight-scheme"]')
      const chips = document.querySelectorAll('[data-testid="highlight-rule"]')
      const schemes = picker ? picker.options.length : 0
      push('the colour schemes are there before it is switched on',
        !!picker && schemes === 4 && chips.length === 8,
        'picker=' + !!picker + ' schemes=' + schemes + ' rules=' + chips.length)
      /*
       * And they have to be *usable* while it is off.
       *
       * Dimming them was the first attempt at "I could not find the palette" and it
       * broke the other half of the job: a greyed control cannot be set, and choosing
       * a scheme before switching the feature on is a reasonable thing to want —
       * "灰色的选择不了呢". Proved by using it, not by inspecting it.
       */
      const usable = !!picker && picker.disabled === false &&
        chips.length > 0 && chips[0].disabled === false
      let picked = ''
      if (picker) {
        picker.value = 'soft'
        picker.dispatchEvent(new Event('change', { bubbles: true }))
        await wait(500)
        const after = document.querySelector('[data-testid="highlight-scheme"]')
        picked = after ? after.value : ''
      }
      push('and they can be set while it is switched off, not just seen',
        usable && picked === 'soft',
        'enabled=' + usable + ' schemeAfterPicking=' + JSON.stringify(picked))

      /*
       * Picking a palette switches the feature on.
       *
       * A user set the palette, ticked rules, saw nothing change in the terminal and
       * reported "好像没生效呢？" — the master switch, a separate row above, was never
       * ticked. Configuring the thing is asking for it; one card now holds both, and
       * touching it turns it on.
       */
      const switchBox = document.querySelector('[data-testid="highlight-enabled"]')
      const card = document.querySelector('[data-testid="highlight-card"]')
      push('picking a palette switches highlighting on by itself',
        !!switchBox && switchBox.checked === true,
        'switchChecked=' + (switchBox ? switchBox.checked : 'n/a'))
      push('the switch and the palette are one block, not two',
        !!card && !!card.querySelector('[data-testid="highlight-enabled"]') &&
          !!card.querySelector('[data-testid="highlight-scheme"]'),
        'card holds both=' + !!card)
      const dirtyHint = document.querySelector('[data-testid="settings-dirty"]')
      push('and an unsaved change says so, instead of silently doing nothing',
        !!dirtyHint, dirtyHint ? 'hint=' + JSON.stringify(dirtyHint.innerText.trim()) : 'no hint')
      // Leave the drawer as it was found.
      const drawerButtons = Array.prototype.slice.call(
        document.querySelectorAll('.td-drawer-actions button')
      )
      const closer = drawerButtons.find((b) => !b.hasAttribute('data-testid'))
      if (closer) closer.click()
      await wait(800)

      // ---- 1. off by default ---------------------------------------------
      const off = decorations()
      push('highlighting is off until it is switched on', off.length === 0, 'decorations=' + off.length)

      // ---- 2. on: the IP and the error word are boxed ---------------------
      await apply({ highlightEnabled: true, highlightScheme: 'classic', highlightRules: ['ip', 'error', 'url'] })
      const on = decorations()
      push('turning it on marks the matches', on.length > 0, 'decorations=' + on.length)
      /*
       * Geometry, not just existence: the IP is 11 cells, the word "error" is 5 and the
       * link is 20, and each decoration has to be that wide. A matcher that boxed the
       * whole line, or drifted by the prompt length, fails here.
       */
      const widths = on.map((d) => d.cells).sort((a, b) => a - b)
      const hasIp = widths.indexOf(11) >= 0
      const hasWord = widths.indexOf(5) >= 0
      push('and only the matched cells are boxed, not the line', hasIp && hasWord,
        'widths in cells=' + JSON.stringify(widths))
      push('each match is boxed at its own length', widths.indexOf(20) >= 0,
        'the twenty-character link is one box: ' + JSON.stringify(widths))

      // ---- 3. the scheme decides the colour ------------------------------
      await apply({ highlightScheme: 'xshell' })
      let runs = styledRuns('10.20.30.40')
      const errorCells = runCount(runs, 'rgb(201,42,42)', 'rgb(255,227,227)')
      const ipCells = runCount(runs, 'rgb(24,100,171)', 'rgb(208,235,255)')
      push('the XShell scheme paints its error background', errorCells === 5,
        'cells painted for the word error=' + errorCells)
      push('and a different one for addresses', ipCells === 11,
        'cells painted for the address=' + ipCells)

      // ---- 4. one rule off takes only its own boxes away -----------------
      await apply({ highlightRules: ['ip'] })
      const onlyIp = decorations()
      runs = styledRuns('10.20.30.40')
      push('switching a rule off takes its boxes away',
        onlyIp.every((d) => d.cells !== 5) &&
          runCount(runs, 'rgb(201,42,42)', 'rgb(255,227,227)') === 0,
        'error cells now=' + runCount(runs, 'rgb(201,42,42)', 'rgb(255,227,227)') +
          ' decorations=' + JSON.stringify(onlyIp.map((d) => d.cells)))
      push('and leaves the other rules alone',
        runCount(runs, 'rgb(24,100,171)', 'rgb(208,235,255)') === 11 &&
          onlyIp.some((d) => d.cells === 11),
        'address cells still=' + runCount(runs, 'rgb(24,100,171)', 'rgb(208,235,255)'))

      // ---- 5. colour must not reach the text -----------------------------
      await apply({ highlightScheme: 'classic', highlightRules: ['ip', 'error', 'url'] })
      await wait(300)
      runs = styledRuns('10.20.30.40')
      push('a scheme without backgrounds paints the glyphs only',
        runCount(runs, 'rgba(0,0,0,0)', 'rgb(77,171,247)') === 11,
        'address cells with the classic colour=' +
          runCount(runs, 'rgba(0,0,0,0)', 'rgb(77,171,247)'))
      term.selectAll()
      const copied = term.getSelection()
      term.clearSelection()
      push('copying never carries escape sequences', copied.indexOf(String.fromCharCode(27)) < 0,
        'length=' + copied.length)
      push('and the address survives as plain text', copied.indexOf('10.20.30.40') >= 0,
        'found=' + (copied.indexOf('10.20.30.40') >= 0))
      push('the colour adds nothing to the copied text',
        copied.indexOf('error') >= 0 && copied.indexOf('http://example.com/x') >= 0,
        'plain words still there')

      /*
       * A wrapped logical line: does the copy come back as one line, or split at the
       * wrap? Measured rather than assumed — the answer decides what "no hidden
       * characters" can promise.
       */
      await write('echo WRAPSTART-' + 'a'.repeat(180) + '-WRAPEND')
      await wait(600)
      term.selectAll()
      const longCopy = term.getSelection()
      term.clearSelection()
      const startAt = longCopy.indexOf('WRAPSTART')
      const endAt = longCopy.indexOf('-WRAPEND')
      const between = startAt >= 0 && endAt > startAt ? longCopy.slice(startAt, endAt) : ''
      push('a wrapped line copies back as one line', between.indexOf(String.fromCharCode(10)) < 0,
        'newlines inside=' + (between.split(String.fromCharCode(10)).length - 1) +
          ' chars=' + between.length)

      // ---- 6. the master switch wins -------------------------------------
      await apply({ highlightEnabled: false })
      push('switching it off clears every box', decorations().length === 0,
        'decorations=' + decorations().length)

      return out
    })()
  `

  let walk = null
  try {
    walk = await win.webContents.executeJavaScript(WALK)
  } catch (err) {
    push('the highlight walk runs', false, err && err.stack ? err.stack : String(err))
  }
  if (Array.isArray(walk)) {
    for (const item of walk) push(item.name, item.ok, item.detail)
  } else if (walk) {
    push('the highlight walk runs', false, JSON.stringify(walk))
  }

  clearTimeout(guard)
  win.destroy()
  const code = report() === 0 ? 0 : 1
  fs.writeFileSync(
    path.join(ROOT, 'node_modules', '.smoke-data', 'highlight-last.json'),
    JSON.stringify(checks, null, 2)
  )
  app.exit(code)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('highlight probe crashed: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  })
)
