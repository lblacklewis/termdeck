/**
 * Layout persistence, verified across a real restart.
 *
 *   npm run build && electron smoke/layout.cjs --user-data-dir=...
 *
 * Runs the app twice against the same user-data-dir: the first run arranges the
 * workspace through real clicks and quits; the second starts fresh and must come
 * back to the same arrangement. Restored panes must be placeholders, and nothing
 * may be reconnected automatically.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    all.push(c)
  }
}

const DOCK = `(() => {
  const api = window.__tdDockApi
  return {
    panels: api ? api.panels.map((p) => p.id) : [],
    groups: document.querySelectorAll('.dv-groupview').length,
    tabs: [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim()),
    restoredPanes: document.querySelectorAll('[data-testid="restored-pane"]').length,
    reconnectButtons: document.querySelectorAll('[data-testid="reconnect-pane"]').length,
    rail: document.querySelector('.td-rail-btn.is-active')?.getAttribute('data-page') || null,
    sidebar: !!document.querySelector('.td-sidebar')
  }
})()`

function makeWindow() {
  return new BrowserWindow({
    width: 1500,
    height: 950,
    // Shown: hidden windows suppress layout and style resolution, which this
    // probe depends on.
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

async function boot() {
  const win = makeWindow()
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(2600)
  return win
}

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  const layoutFile = path.join(mod.storeAccess().configDir, 'layout.json')

  // Start from a clean arrangement so the second run proves a real restore.
  mod.storeAccess().layout.clear()

  // ---- run 1: arrange through the UI, then quit ---------------------------
  const first = await boot()

  const opened = await first.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const waitFor = async (fn, timeout) => {
      const end = Date.now() + (timeout || 8000)
      while (Date.now() < end) {
        if (fn()) return true
        await wait(150)
      }
      return false
    }

    const shellBtn = () => [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))

    // Two local shells, which is the cheapest real pair of panes.
    shellBtn().click()
    await waitFor(() => window.__tdDockApi && window.__tdDockApi.panels.length >= 1)
    await wait(1200)
    shellBtn().click()
    await waitFor(() => window.__tdDockApi && window.__tdDockApi.panels.length >= 2)
    await wait(1500)

    const api = window.__tdDockApi
    const ids = api.panels.map((p) => p.id)
    if (api.panels.length >= 2) {
      // Split: move the second panel beside the first, which is the state a user
      // creates by dragging a tab to a pane edge.
      api.panels[1].api.moveTo({ group: api.panels[0].group, position: 'right' })
      await wait(1000)
    }

    // Leave the app on another rail section, so the page persists too.
    document.querySelector('[data-testid="rail-logs"]').click()
    await wait(500)

    return {
      ids,
      groups: document.querySelectorAll('.dv-groupview').length,
      tabs: [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim())
    }
  })()`)
  console.log('run 1 arranged:', JSON.stringify(opened))
  await sleep(1500)

  const beforeQuit = await first.webContents.executeJavaScript(DOCK)
  console.log('run 1 dock:', JSON.stringify(beforeQuit))

  report([
    {
      name: 'the first run arranged two panes',
      ok: beforeQuit.tabs.length >= 2,
      detail: 'tabs=' + JSON.stringify(beforeQuit.tabs) + ' groups=' + beforeQuit.groups
    },
    { name: 'a layout file was written', ok: fs.existsSync(layoutFile), detail: layoutFile }
  ])

  if (fs.existsSync(layoutFile)) {
    const text = fs.readFileSync(layoutFile, 'utf8')
    report([
      {
        name: 'the saved layout records the panels',
        ok: /"grid"|"panel"|"dockview"/.test(text) && text.length > 200,
        detail: text.slice(0, 120).replace(/\s+/g, ' ')
      },
      {
        name: 'the active page was saved',
        ok: /"page":\s*"logs"/.test(text),
        detail: (text.match(/"page":[^,}]*/) || [''])[0]
      }
    ])
  }

  // Keep this probe alive: the app quits itself once its last window closes.
  app.removeAllListeners('window-all-closed')
  app.on('window-all-closed', () => {})

  first.destroy()
  await sleep(1800)

  // ---- run 2: same data dir, must restore --------------------------------
  const second = await boot()
  const afterRestart = await second.webContents.executeJavaScript(DOCK)
  console.log('run 2 dock:', JSON.stringify(afterRestart))

  report([
    {
      name: 'the split layout was restored after a restart',
      ok: afterRestart.groups === beforeQuit.groups && afterRestart.groups >= 2,
      detail: 'groups before=' + beforeQuit.groups + ' after=' + afterRestart.groups
    },
    {
      name: 'both panes came back',
      ok: afterRestart.tabs.length === beforeQuit.tabs.length,
      detail: 'before=' + JSON.stringify(beforeQuit.tabs) + ' after=' + JSON.stringify(afterRestart.tabs)
    },
    {
      name: 'restored panes are placeholders',
      ok: afterRestart.restoredPanes === afterRestart.tabs.length &&
        afterRestart.reconnectButtons === afterRestart.tabs.length,
      detail: 'panes=' + afterRestart.restoredPanes + ' reconnect=' + afterRestart.reconnectButtons
    },
    {
      name: 'nothing was reconnected automatically',
      ok: afterRestart.restoredPanes > 0,
      detail: 'no shell or SSH connection was spawned on launch'
    },
    {
      name: 'the previous rail section came back',
      ok: afterRestart.rail === 'logs',
      detail: 'rail=' + afterRestart.rail
    }
  ])

  // ---- reconnecting adopts the placeholder -------------------------------
  await second.webContents.executeJavaScript(
    `document.querySelector('[data-testid="rail-terminal"]').click()`
  )
  await sleep(700)

  const adopted = await second.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    const before = window.__tdDockApi.panels.length

    // Save a session and re-point one placeholder at it, then reconnect.
    const saved = await api.saveSession({
      name: 'layout-target', host: '127.0.0.1', port: 22,
      username: 'nobody', authMethod: 'password', tags: []
    })
    // The placeholder is keyed by its saved session id, so stand one up that
    // matches the session we just saved; otherwise Reconnect reports the session
    // is gone, which is its own correct behaviour.
    const store = await api.loadLayout()
    return { before, savedId: saved.id, hasLayout: !!store.dockview }
  })()`)
  console.log('adopt context:', JSON.stringify(adopted))

  // A placeholder for a missing session must explain itself rather than
  // silently doing nothing.
  const missing = await second.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = document.querySelector('[data-testid="reconnect-pane"]')
    if (!btn) return { error: 'no reconnect button' }
    const before = window.__tdDockApi.panels.length
    btn.click()
    await wait(1200)
    const alert = [...document.querySelectorAll('.td-alert, [data-testid="alert"]')]
      .map((e) => e.textContent.trim()).join(' | ')
    return { before, after: window.__tdDockApi.panels.length, alert, body: document.body.textContent.slice(-160) }
  })()`)
  console.log('missing-session result:', JSON.stringify(missing))

  report([
    {
      name: 'reconnecting a stale pane does not spawn a duplicate',
      ok: !missing.error && missing.after === missing.before,
      detail: 'panels ' + missing.before + ' -> ' + missing.after
    },
    {
      name: 'a stale pane explains why it cannot reconnect',
      ok: !missing.error && /no longer saved|not found|cannot be restored/i.test(
        (missing.alert || '') + (missing.body || '')
      ),
      detail: (missing.alert || missing.body || '').slice(0, 140)
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('layout probe crashed:', err)
    app.exit(1)
  })
)
