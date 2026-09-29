/**
 * Reproduction for "connecting a session shows it under Open sessions but no
 * pane appears".
 *
 *   npm run build && electron smoke/repro.cjs --user-data-dir=...
 *
 * Walks the page/connect matrix (connect from each page, navigate between pages)
 * and reports the dock state at each step, so the exact step that strands the
 * layout is identified instead of guessed at.
 */
const path = require('node:path')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const SSH_USER = process.env.TD_SSH_USER || 'root'
const SSH_KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    all.push(c)
  }
}

/** Injected into the page: describes what the dock currently shows. */
const DOCK_STATE = `(() => {
  const api = window.__tdDockApi
  const container = document.querySelector('.td-dockview')
  const groups = document.querySelectorAll('.dv-groupview').length
  const tabs = [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())
  const terms = document.querySelectorAll('.xterm').length
  let panels = []
  try { panels = api ? api.panels.map((p) => p.id + ':' + (p.title || '')) : [] } catch (e) { panels = ['ERR'] }
  return {
    hasApi: !!api,
    totalPanels: api ? api.totalPanels : -1,
    panels,
    groups,
    tabs,
    terms,
    containerPresent: !!container,
    // Is the dock column actually laid out on screen?
    containerBox: container ? (() => {
      const b = container.getBoundingClientRect()
      return [Math.round(b.width), Math.round(b.height)]
    })() : null,
    containerVisible: container ? container.offsetParent !== null : false,
    activeRail: document.querySelector('.td-rail-btn.is-active')?.getAttribute('data-page') || null
  }
})()`

async function main() {
  require(path.join(ROOT, 'out', 'main', 'smokeEntry.js')).registerIpc()

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    // Shown so layout and painting are real; hidden windows suppress both.
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(2500)
  win.focus()
  await sleep(400)

  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const s = await api.loadSettings()
    await api.saveSettings({ ...s, hostKeys: { policy: 'trust' } })
    await api.saveSession({
      name: 'repro-ssh', host: ${JSON.stringify(SSH_HOST)}, port: 22,
      username: ${JSON.stringify(SSH_USER)}, authMethod: 'key',
      privateKeyPath: ${JSON.stringify(SSH_KEY)}, tags: []
    })
    return true
  })()`)
  await sleep(800)

  const go = async (page) => {
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid="rail-${page}"]'); if (b) b.click(); return true })()`
    )
    await sleep(600)
  }
  const state = async () => win.webContents.executeJavaScript(DOCK_STATE)

  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' })

  // --- 1. baseline: connect from the terminal page -----------------------
  const s0 = await state()
  push('starts with the dock mounted', s0.containerPresent && s0.hasApi,
    JSON.stringify(s0))

  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const tree = await api.loadSessionTree()
    const s = tree.sessions.find((x) => x.name === 'repro-ssh')
    const row = document.querySelector('.td-node[data-node-id="' + s.id + '"]')
    row.querySelector('.td-node-main').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true })
    )
    return true
  })()`)
  await sleep(6000)

  const s1 = await state()
  push('connect from terminal page opens a pane',
    s1.groups >= 1 && s1.tabs.length >= 1 && s1.terms >= 1, JSON.stringify(s1))

  // --- 2. navigate away and back, then connect ---------------------------
  await go('hosts')
  const s2 = await state()
  push('dock survives navigating away (api still live)',
    s2.containerPresent && s2.hasApi,
    JSON.stringify({ present: s2.containerPresent, api: s2.hasApi, rail: s2.activeRail }))

  await go('terminal')
  const s3 = await state()
  push('dock still shows the open pane after returning',
    s3.containerPresent && s3.hasApi && s3.groups >= 1,
    JSON.stringify(s3))

  // --- 3. connect while on a non-terminal page ---------------------------
  await go('hosts')
  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const tree = await api.loadSessionTree()
    const s = tree.sessions.find((x) => x.name === 'repro-ssh')
    const row = document.querySelector('[data-host-row="' + s.id + '"] [data-action="connect"]')
    if (row) row.click()
    return !!row
  })()`)
  await sleep(7000)

  const s4 = await state()
  const s4HostsPage = s4.activeRail
  push('connecting from another page still creates the pane',
    s4.hasApi && s4.totalPanels >= 2,
    'rail=' + s4HostsPage + ' ' + JSON.stringify(s4))

  await go('terminal')
  const s5 = await state()
  push('that pane is visible when returning to the terminal page',
    s5.containerPresent && s5.containerBox && s5.containerBox[0] > 100 && s5.containerBox[1] > 100,
    JSON.stringify({ box: s5.containerBox, visible: s5.containerVisible, tabs: s5.tabs }))
  push('both sessions are present as tabs',
    s5.tabs.length >= 2, JSON.stringify(s5.tabs))

  report(checks)
  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('repro crashed:', err)
    app.exit(1)
  })
)
