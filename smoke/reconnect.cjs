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
      /** Everything a pane's terminal has on screen, scrollback included. */
      const textFor = (id) => {
        const entry = window.__tdTerminals ? window.__tdTerminals[id] : null
        if (!entry || !entry.term) return ''
        const buffer = entry.term.buffer.active
        let text = ''
        for (let i = 0; i < buffer.length; i += 1) {
          const line = buffer.getLine(i)
          if (line) text += line.translateToString(true) + String.fromCharCode(10)
        }
        return text
      }
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
      // The pane adopts the session through dockview params and a re-render, so
      // wait for the adoption rather than for a fixed number of milliseconds.
      await waitFor(() => panes()[0] === second.id, 15000)
      push('and it now holds the new session',
        panes().length === 1 && panes()[0] === second.id,
        state() + ' params=' + JSON.stringify(
          window.__tdDockApi.panels.map((p) => {
            const q = p.api.getParameters() || {}
            return { id: p.id, session: q.session ? q.session.id : null }
          })
        ))
      push('the pane is live again, not a placeholder',
        !document.querySelector('[data-testid="restored-pane"]'), state())

      /*
       * ---- 4. the ended pane reconnects itself ------------------------------
       * Ended by *exiting the shell*, not by closing the session from the page:
       * those are deliberately different. Closing a session releases the record of
       * how it connected; an exit leaves it, which is what the pane's own
       * Reconnect button needs to work without a saved host.
       */
      step = 'ended overlay'
      /*
       * Print something first, so "the history is still there afterwards" is a
       * claim about a line that actually existed rather than about an empty buffer.
       */
      const keepMarker = 'KEEP_' + Date.now()
      window.termdeck.writeSession(second.id, 'echo ' + keepMarker + String.fromCharCode(13))
      const printed = await waitFor(() => textFor(second.id).includes(keepMarker), 10000)
      push('a line printed before the drop is on screen', printed,
        'tail=' + textFor(second.id).trim().slice(-40))

      /*
       * The "exit" line is retried until the pane notices.
       *
       * A write that arrives while the SSH channel is still opening is dropped by
       * the backend, and this suite runs at the end of a long chain where that
       * window is wide — measured not by guessing a delay but by asking the pane.
       */
      let overlayUp = false
      for (let attempt = 0; attempt < 20 && !overlayUp; attempt += 1) {
        window.termdeck.writeSession(second.id, 'exit' + String.fromCharCode(13))
        overlayUp = await waitFor(
          () => !!document.querySelector('[data-testid="session-ended-overlay"]'),
          1500
        )
      }
      push('a session that exits covers its pane with a notice', overlayUp)
      push('the notice says the session ended',
        !!document.querySelector('[data-testid="session-ended-title"]'),
        (document.querySelector('[data-testid="session-ended-title"]') || {}).textContent || 'none')
      const revive = document.querySelector('[data-testid="reconnect-session"]')
      push('and offers a reconnect button', !!revive)
      push('the old drag-or-close hint is gone', !document.querySelector('.td-terminal-banner-hint'))
      /*
       * Typing "exit" is the user ending the session, not a connection dropping:
       * the connection was fine, the shell was done. Auto-retry must leave it alone,
       * or a logged-out pane would keep logging itself back in.
       */
      push('a shell that exited on its own is not retried automatically',
        !(await waitFor(
          () => !!document.querySelector('[data-testid="reconnect-progress"]'),
          2500
        )))

      step = 'reconnect from the overlay'
      if (revive) revive.click()
      const revived = await waitFor(
        () => !document.querySelector('[data-testid="session-ended-overlay"]'),
        30000
      )
      /*
       * Both halves are required: "there was a notice, and it is gone now". Asking
       * only for the absence would pass in the case where no notice ever appeared —
       * which is how this check passed while the one above it failed.
       */
      push('reconnecting clears the notice', overlayUp && revived, state())
      /*
       * This is the point of the whole change: the rebuilt session keeps the id it
       * had, so the pane keeps the terminal it already had — and therefore keeps
       * every line in it. A new id would mean a new terminal and a blank screen.
       */
      const revivedId = await waitFor(() => panes()[0], 20000)
      push('reconnecting keeps the same session id',
        revivedId && panes()[0] === second.id,
        'was=' + second.id + ' now=' + (panes()[0] || 'none'))
      const live = (await sessions()).some((s) => s.id === second.id)
      push('and that session is live again, not just remembered', live,
        'sessions=' + (await sessions()).map((s) => s.id).join(','))
      push('the reconnect reused the tab rather than adding one',
        tabs().length === 1 && panelIds()[0] === first.id,
        'tabs=' + tabs().length + ' panel=' + panelIds()[0] + ' expected=' + first.id)
      const afterText = textFor(second.id)
      push('the output printed before the drop is still on screen',
        afterText.includes(keepMarker),
        'marker=' + afterText.includes(keepMarker) + ' lines=' + afterText.split(String.fromCharCode(10)).length)
      push('and the new connection is writing into the same terminal',
        await waitFor(async () => {
          window.termdeck.writeSession(second.id, 'echo AFTER_' + keepMarker + String.fromCharCode(13))
          return textFor(second.id).includes('AFTER_' + keepMarker)
        }, 12000),
        'tail=' + textFor(second.id).trim().slice(-40))

      /*
       * ---- 5. Ctrl+R, in both directions -----------------------------------
       * On a live pane the key belongs to the shell (reverse-i-search), so the app
       * has to decline it; on an ended pane it is the reconnect shortcut. Checking
       * only one of those would pass whether or not the key was being swallowed.
       */
      step = 'ctrl+r while alive'
      const pressCtrlR = () => {
        for (const type of ['keydown', 'keyup']) {
          window.dispatchEvent(new KeyboardEvent(type, {
            key: 'r', code: 'KeyR', ctrlKey: true, bubbles: true, cancelable: true
          }))
        }
      }
      const aliveBefore = (await sessions()).map((s) => s.id).join(',')
      pressCtrlR()
      await wait(1500)
      push('Ctrl+R on a live pane reconnects nothing',
        !document.querySelector('[data-testid="session-ended-overlay"]') &&
          (await sessions()).map((s) => s.id).join(',') === aliveBefore,
        'sessions=' + (await sessions()).map((s) => s.id).join(','))

      step = 'ctrl+r on a dead pane'
      let endedAgain = false
      for (let attempt = 0; attempt < 20 && !endedAgain; attempt += 1) {
        window.termdeck.writeSession(second.id, 'exit' + String.fromCharCode(13))
        endedAgain = await waitFor(
          () => !!document.querySelector('[data-testid="session-ended-overlay"]'),
          1500
        )
      }
      push('the session is ended again for the shortcut test', endedAgain)
      pressCtrlR()
      const backByKey = await waitFor(
        () => !document.querySelector('[data-testid="session-ended-overlay"]'),
        30000
      )
      push('Ctrl+R reconnects an ended pane', backByKey, state())
      push('and it is still the same session, with its history',
        panes()[0] === second.id && textFor(second.id).includes(keepMarker),
        'pane=' + panes()[0] + ' keep=' + textFor(second.id).includes(keepMarker))

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
