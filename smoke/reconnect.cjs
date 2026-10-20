/**
 * Reconnecting goes back into the pane that already stands for that session.
 *
 *   npm run build && electron smoke/reconnect.cjs --user-data-dir=...
 *
 * The reported symptom: a session dies, the user connects the same saved host
 * again, and instead of that pane coming back to life a second tab opens beside
 * the dead one. The pane is still there (nothing closes it when the backend
 * exits), and it still carries the saved session it belongs to in its params, so
 * the connect path *can* see it — it just only looked for a restored placeholder
 * (`disconnected: true`) and never for a pane whose session had ended.
 *
 * This probe drives the real path end to end: double-click a saved host, close
 * that session from under the pane, double-click the same host again, and assert
 * there is still one tab and that the tab now holds the new session.
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
  const knownHostsPath = path.join(os.tmpdir(), 'termdeck-reconnect-known-hosts')
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
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)
  win.focus()
  await sleep(300)

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
      const sessions = () => window.termdeck.listSessions()
      const tabs = () => [...document.querySelectorAll('.dv-tab[data-tab-panel-id]')]
      const panelIds = () => tabs().map((t) => t.getAttribute('data-tab-panel-id'))
      const panes = () =>
        [...document.querySelectorAll('[data-terminal-id]')]
          .map((el) => el.getAttribute('data-terminal-id'))
      const state = () => 'tabs=[' + panelIds().join(',') + '] panes=[' + panes().join(',') + ']'
      const dbl = (el) =>
        el.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, composed: true, detail: 2
        }))

      let step = 'start'
      try {

      const row = [...document.querySelectorAll('.td-node[data-node-kind="session"]')]
        .find((n) => (n.textContent || '').includes('cloud'))
      push('the saved host is in the sidebar', !!row)
      if (!row) return out
      const open = row.querySelector('.td-node-main')
      if (!open) {
        push('the session row has a clickable body', false)
        return out
      }

      // ---- 1. the first connection ----------------------------------------
      step = 'first connect'
      dbl(open)
      const up = await waitFor(async () => (await sessions()).length > 0, 20000)
      push('double-clicking the saved host opens a session', up)
      if (!up) return out
      const first = (await sessions())[0]
      const drawn = await waitFor(
        () => !!document.querySelector('[data-terminal-id="' + first.id + '"]'),
        20000
      )
      push('the first pane is on screen', drawn, state())
      push('there is exactly one tab', tabs().length === 1, state())

      // ---- 2. the session dies; what is left behind? ----------------------
      step = 'kill session'
      window.termdeck.closeSession(first.id)
      const gone = await waitFor(async () => (await sessions()).length === 0, 8000)
      push('the session is gone', gone)
      await wait(2000)
      push('after the session ends the tab is still there', tabs().length === 1, state())
      push('and the pane is still on screen', panes().length === 1, state())
      push('it is not a restored placeholder',
        !document.querySelector('[data-testid="restored-pane"]'), state())

      // ---- 3. connecting again must revive that pane -----------------------
      step = 'reconnect'
      dbl(open)
      const back = await waitFor(async () => (await sessions()).length > 0, 20000)
      push('connecting the same host again opens a session', back)
      if (!back) return out
      await wait(2000)
      const second = (await sessions())[0]
      push('it is a new session, not the dead one', second.id !== first.id,
        'old=' + first.id + ' new=' + second.id)

      push('no second tab was opened', tabs().length === 1, state())
      push('the original tab is the one that is still there',
        tabs().length === 1 && panelIds()[0] === first.id,
        'expected=' + first.id + ' got=' + state())
      push('and it now holds the new session',
        panes().length === 1 && panes()[0] === second.id, state())
      push('the pane is live again, not a placeholder',
        !document.querySelector('[data-testid="restored-pane"]'), state())

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
    report([{ name: 'reconnect probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('reconnect probe crashed:', err)
    app.exit(1)
  })
)
