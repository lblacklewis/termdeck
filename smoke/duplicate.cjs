/**
 * "Duplicate connection" must open another SSH login, not a local shell.
 *
 *   npm run build && electron smoke/duplicate.cjs --user-data-dir=...
 *
 * The reported symptom was exact: duplicating an SSH pane produced a *local*
 * shell. The renderer used to resolve the host itself from the saved-session
 * list, so any connection that did not start from a saved entry (a quick
 * connect, or a pane reconnected after a restart) fell through to
 * `createLocalSession`. The copy is now rebuilt in the main process from the
 * options the original session was started with, and this probe checks that end
 * to end: the tab-menu action, a double-click on the tab, and the assertion that
 * decides it — every session the app reports is `kind: 'ssh'`, and a command
 * typed into the copy runs on the *remote* host.
 *
 * A negative check is included as well: a double-click inside a terminal selects
 * a word and must not duplicate anything.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const USER = process.env.TD_SSH_USER || 'root'
const KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

async function main() {
  /*
   * Host keys go to a scratch file. It has to be set before the IPC module is
   * loaded, and it keeps a probe that trusts the host on sight from editing the
   * developer's real `~/.ssh/known_hosts`.
   */
  const knownHostsPath = path.join(os.tmpdir(), 'termdeck-duplicate-known-hosts')
  try {
    fs.rmSync(knownHostsPath, { force: true })
  } catch {
    /* a missing file is the point */
  }
  process.env['TERMDECK_KNOWN_HOSTS'] = knownHostsPath

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  // Trust the host key on sight: this probe is about what a duplicate connects
  // *to*, and a host-key prompt is a dialog the probe cannot aim at.
  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({ ...settings, hostKeys: { policy: 'trust' } })

  mod.storeAccess().sessions.upsertSession({
    name: 'cloud',
    host: HOST,
    port: 22,
    username: USER,
    authMethod: 'key',
    privateKeyPath: KEY,
    parentId: null,
    tags: []
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
      /*
       * Never throttle this window.
       *
       * Electron throttles an occluded/background renderer, and a throttled
       * renderer serves *stale* computed styles and skips xterm's paint: the
       * probe then reads a pane that is 100x100 with an empty screen even though
       * its inline size says otherwise. That is a measurement artefact, not a
       * broken pane, and it made this suite fail at random.
       */
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          const v = await fn()
          if (v) return true
          await wait(200)
        }
        return false
      }
      const NL = String.fromCharCode(10)
      let step = 'start'
      try {

      const sessions = () => window.termdeck.listSessions()
      const kinds = (list) => list.map((s) => s.kind).join(',')
      const tabs = () => [...document.querySelectorAll('.dv-tab[data-tab-panel-id]')]
      const tabFor = (id) =>
        tabs().find((t) => t.getAttribute('data-tab-panel-id') === id)
      const paneText = (id) => {
        const el = document.querySelector('[data-terminal-id="' + id + '"]')
        // The rendered glyphs only. The terminal root also holds xterm's own
        // generated stylesheet, so its raw textContent is mostly CSS.
        const rows = el && el.querySelector('.xterm-rows')
        return rows ? (rows.textContent || '') : ''
      }
      const dbl = (el) =>
        el.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, composed: true, detail: 2
        }))

      // ---- 1. one real SSH login to copy ----------------------------------
      step = 'connect'
      const row = [...document.querySelectorAll('.td-node[data-node-kind="session"]')]
        .find((n) => (n.textContent || '').includes('cloud'))
      push('the saved host is in the sidebar', !!row)
      if (!row) return out
      const open = row.querySelector('.td-node-main')
      if (!open) {
        push('the session row has a clickable body', false)
        return out
      }
      dbl(open)

      const connected = await waitFor(async () => (await sessions()).length > 0, 20000)
      push('double-clicking the saved host opens a session', connected)
      if (!connected) return out

      const first = (await sessions())[0]
      push('the original connection is SSH', first.kind === 'ssh', 'kind=' + first.kind)
      const paneUp = await waitFor(
        () => !!document.querySelector('[data-terminal-id="' + first.id + '"]'),
        15000
      )
      push('the pane is on screen', paneUp)
      if (!paneUp) return out
      const firstRect = document
        .querySelector('[data-terminal-id="' + first.id + '"]')
        .getBoundingClientRect()
      push('the first pane renders at full height',
        firstRect.height > 200,
        'pane=' + Math.round(firstRect.width) + 'x' + Math.round(firstRect.height) +
        ' panel=' + window.__tdDockApi.getPanel(first.id).api.height)

      // ---- 2. duplicate from the tab menu (the reported path) -------------
      step = 'menu'
      const tab = tabFor(first.id)
      push('the pane has a tab', !!tab)
      if (!tab) return out
      const box = tab.getBoundingClientRect()
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(box.x + box.width / 2),
        clientY: Math.round(box.y + box.height / 2)
      }))
      await wait(400)
      const menu = document.querySelector('[data-testid="tab-menu"]')
      push('right-clicking the tab opens the tab menu', !!menu)
      const item = menu && menu.querySelector('[data-menu-id="duplicateConnection"]')
      push('the menu offers Duplicate connection', !!item)
      if (!item) return out
      item.click()

      const doubled = await waitFor(
        async () =>
          (await sessions()).length >= 2 && window.__tdDockApi.panels.length >= 2,
        30000
      )
      const afterMenu = await sessions()
      push('duplicating opens a second session', doubled,
        'sessions=' + afterMenu.length + ' panels=' + window.__tdDockApi.panels.length)
      push('the duplicate is SSH, not a local shell',
        afterMenu.length === 2 && afterMenu.every((s) => s.kind === 'ssh'),
        'kinds=' + kinds(afterMenu))

      const copy = afterMenu.find((s) => s.id !== first.id)
      if (!copy) return out

      // ---- 3. the copy really is a login on the remote host ---------------
      step = 'remote'
      const copyPaneUp = await waitFor(
        () => !!document.querySelector('[data-terminal-id="' + copy.id + '"]'),
        15000
      )
      push('the duplicated pane is on screen', copyPaneUp)
      /*
       * Retried rather than written once: the pane mounts, replays the buffered
       * banner and only then starts painting rows, so a single write can land
       * while the terminal is still coming up and read back empty.
       */
      let remote = false
      for (let i = 0; i < 6 && !remote; i++) {
        window.termdeck.writeSession(copy.id, 'uname -s' + NL)
        remote = await waitFor(() => /Linux/.test(paneText(copy.id)), 3000)
      }
      const copyBox = document.querySelector('[data-terminal-id="' + copy.id + '"]')
      const copyRect = copyBox && copyBox.getBoundingClientRect()
      const copyPanel = window.__tdDockApi.getPanel(copy.id)
      push('the duplicate runs commands on the remote host', remote,
        'tail=' + JSON.stringify(paneText(copy.id).slice(-90)) +
        ' pane=' +
        (copyRect ? Math.round(copyRect.width) + 'x' + Math.round(copyRect.height) : 'none') +
        ' panel=' +
        (copyPanel ? copyPanel.api.width + 'x' + copyPanel.api.height : 'none') +
        ' active=' + (window.__tdDockApi.activePanel?.id === copy.id) +
        ' groups=' + document.querySelectorAll('.dv-groupview').length)

      // ---- 4. a double-click in the terminal must not duplicate ----------
      step = 'negative'
      const before = (await sessions()).length
      const screen = document.querySelector('[data-terminal-id="' + first.id + '"]')
      const screenEl = screen && (screen.querySelector('.xterm-screen') || screen)
      if (screenEl) dbl(screenEl)
      await wait(2500)
      const settled = (await sessions()).length
      push('a double-click inside the terminal does not duplicate anything',
        settled === before, 'sessions ' + before + ' -> ' + settled)

      // ---- 5. double-clicking a tab duplicates ---------------------------
      step = 'dblclick'
      const tabAgain = tabFor(first.id)
      push('the tab is still there to double-click', !!tabAgain)
      if (!tabAgain) return out
      dbl(tabAgain)
      const grew = await waitFor(
        async () =>
          (await sessions()).length > before && window.__tdDockApi.panels.length > before,
        30000
      )
      const after = await sessions()
      push('double-clicking a tab duplicates the connection', grew,
        'sessions ' + before + ' -> ' + after.length +
          ' panels=' + window.__tdDockApi.panels.length)
      push('every session opened by a duplicate is SSH',
        after.every((s) => s.kind === 'ssh'), 'kinds=' + kinds(after))

      // ---- 6. and each copy has its own pane -----------------------------
      step = 'panes'
      const ids = after.map((s) => s.id)
      push('the duplicates are distinct sessions',
        new Set(ids).size === ids.length, 'ids=' + ids.length)
      const allPanes = await waitFor(
        () => ids.every((id) => !!window.__tdDockApi.getPanel(id)),
        10000
      )
      const panelIds = window.__tdDockApi.panels.map((p) => p.id)
      push('every session has a panel of its own', allPanes,
        'panels=' + panelIds.length + ' sessions=' + ids.length)
      /*
       * dockview attaches only the *active* panel's content, so a session's
       * terminal is in the DOM only while its tab is selected. Selecting each
       * panel in turn is what proves the pane — not just the session — is there.
       */
      const missing = []
      for (const id of ids) {
        window.__tdDockApi.getPanel(id).api.setActive()
        const up = await waitFor(
          () => !!document.querySelector('[data-terminal-id="' + id + '"]'),
          10000
        )
        if (!up) missing.push(String(id).slice(0, 8))
      }
      push('every duplicated session shows its own terminal when selected',
        missing.length === 0, missing.length ? 'missing=' + missing.join(',') : 'all present')

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
    report([{ name: 'duplicate probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('duplicate probe crashed:', err)
    app.exit(1)
  })
)
