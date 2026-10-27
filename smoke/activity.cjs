/**
 * 背景窗格活动标识：不在前台的窗格开始打印时，标签头与会话行出现提示点，
 * 窗格到前台的那一刻消失。
 *
 * 两个本地 shell 就够：第二个打开后成为活动窗格，第一个自然落到后台。
 * 输出用 `writeSession` 打进后台窗格的 shell（echo 一行），真实走 IPC →
 * 渲染端 onSessionData → 活动上报这条链路，不是直接调内部函数。
 *
 * 探针断言的都是真实证据：
 *   - dockview 标签元素上的 `has-activity` class（`.dv-tab[data-tab-panel-id]`
 *     是 dockview-core 自己写的属性，panel id 就在上面）；
 *   - 侧栏打开会话行里的 `session-activity` 圆点（带 data-session-id）；
 *   - 活动窗格自己的输出永远不标；聚焦清标；后台再打印会再次标上；
 *     会话关掉后标识随之清理。
 *
 * 旧实现没有活动标识：标签 class 永远不出现、圆点元素不存在 —— 前两条断言
 * 显式 FAIL，退出码 1。
 *
 * 用法：npx electron smoke/activity.cjs --user-data-dir=node_modules/.smoke-data/activity
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
    console.error('activity probe watchdog')
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
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) console.error('renderer error: ' + message)
  })
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2600)

  // ---- two panes, the second one in front ------------------------------
  const opened = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    const button = document.querySelector('[data-testid="local-shell"]')
    if (!button) return { error: 'no local-shell button' }
    const ids = async () => (await api.listSessions()).map((s) => s.id)
    const before = await ids()
    button.click()
    const end = Date.now() + 25000
    while (Date.now() < end) {
      if ((await ids()).length > before.length) break
      await wait(300)
    }
    const first = (await ids()).find((id) => !before.includes(id))
    if (!first) return { error: 'first shell did not open' }
    for (let i = 0; i < 60; i += 1) {
      const pane = document.querySelector('[data-terminal-id="' + first + '"]')
      if (pane && pane.querySelector('.xterm-rows')) break
      await wait(250)
    }
    const before2 = await ids()
    button.click()
    const end2 = Date.now() + 25000
    while (Date.now() < end2) {
      if ((await ids()).length > before2.length) break
      await wait(300)
    }
    const second = (await ids()).find((id) => !before2.includes(id))
    if (!second) return { error: 'second shell did not open' }
    for (let i = 0; i < 60; i += 1) {
      const pane = document.querySelector('[data-terminal-id="' + second + '"]')
      if (pane && pane.querySelector('.xterm-rows')) break
      await wait(250)
    }
    const active = window.__tdDockApi ? (window.__tdDockApi.activePanel || {}).id : null
    return { first, second, active }
  })()`)

  push('two local shells open into panes', !!opened && !!opened.first && !!opened.second,
    opened && opened.error ? opened.error : 'first=' + (opened && opened.first) + ' second=' + (opened && opened.second))
  if (!opened || !opened.first || !opened.second) {
    clearTimeout(guard)
    app.exit(report() === 0 ? 0 : 1)
    return
  }
  push('the second pane is the one in front', opened.active === opened.second,
    'active=' + opened.active)

  const WALK = `
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const bg = ${JSON.stringify(opened.first)}
      const front = ${JSON.stringify(opened.second)}
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d === undefined ? true : d })

      const tab = (id) => document.querySelector('.dv-tab[data-tab-panel-id="' + id + '"]')
      const flagged = (id) => {
        const el = tab(id)
        return el ? el.classList.contains('has-activity') : null
      }
      const dot = (id) => document.querySelector('[data-testid="session-activity"][data-session-id="' + id + '"]')

      // ---- 1. 后台窗格打印 -> 标签与会话行都亮起来 ------------------------
      api.writeSession(bg, 'echo BGOUT-1' + String.fromCharCode(13))
      await wait(1500)
      const bgFlag = flagged(bg)
      if (bgFlag === null) {
        push('the background pane flags its tab on output', false,
          'explicit FAIL: no .dv-tab element carries data-tab-panel-id=' + bg +
            ' - the activity marker does not exist in this build')
      } else {
        push('the background pane flags its tab on output', bgFlag === true,
          'hasActivity=' + bgFlag)
      }
      push('and the front pane never flags from its own output', flagged(front) === false,
        'frontFlag=' + String(flagged(front)))
      const bgDot = dot(bg)
      if (!bgDot) {
        push('the sidebar row shows the activity dot', false,
          'explicit FAIL: no [data-testid=session-activity] element for the background session' +
            ' - the marker does not exist in this build')
      } else {
        push('the sidebar row shows the activity dot', bgDot.getAttribute('data-session-id') === bg,
          'sessionId=' + bgDot.getAttribute('data-session-id'))
      }
      push('and the front pane row has none', !dot(front), 'frontDot=' + String(!!dot(front)))

      // ---- 2. 到前台 -> 清掉 ------------------------------------------------
      const dock = window.__tdDockApi
      if (!dock) {
        push('focusing the pane clears the flag', false, 'explicit FAIL: no __tdDockApi')
      } else {
        dock.getPanel(bg).api.setActive()
        await wait(1000)
        push('focusing the pane clears the flag', flagged(bg) === false && !dot(bg),
          'hasActivity=' + String(flagged(bg)) + ' dot=' + String(!!dot(bg)))
      }

      // ---- 3. 活动窗格自己打印 -> 永远不标 ----------------------------------
      api.writeSession(bg, 'echo FRONT-OUT' + String.fromCharCode(13))
      await wait(1500)
      push('the active pane does not flag itself', flagged(bg) === false,
        'hasActivity=' + String(flagged(bg)))

      // ---- 4. 再落回后台 -> 再打印 -> 再标上 ---------------------------------
      dock.getPanel(front).api.setActive()
      await wait(800)
      api.writeSession(bg, 'echo BGOUT-2' + String.fromCharCode(13))
      await wait(1500)
      push('a pane that falls behind flags again on the next output', flagged(bg) === true,
        'hasActivity=' + String(flagged(bg)))

      // ---- 5. 会话关掉 -> 标识跟着清理 ---------------------------------------
      api.writeSession(bg, 'exit' + String.fromCharCode(13))
      await wait(2500)
      push('a closed session leaves no flag behind', !dot(bg) && flagged(bg) !== true,
        'dot=' + String(!!dot(bg)) + ' tabStillThere=' + String(!!tab(bg)))

      return out
    })()
  `

  let walk = null
  try {
    walk = await win.webContents.executeJavaScript(WALK)
  } catch (err) {
    push('the activity walk runs', false, err && err.stack ? err.stack : String(err))
  }
  if (Array.isArray(walk)) {
    for (const item of walk) push(item.name, item.ok, item.detail)
  } else if (walk) {
    push('the activity walk runs', false, JSON.stringify(walk))
  }

  clearTimeout(guard)
  win.destroy()
  const code = report() === 0 ? 0 : 1
  fs.writeFileSync(
    path.join(ROOT, 'node_modules', '.smoke-data', 'activity-last.json'),
    JSON.stringify(checks, null, 2)
  )
  app.exit(code)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('activity probe crashed: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  })
)
