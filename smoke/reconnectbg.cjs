/**
 * A reconnect that happens on its own has to stay out of the way — and come back at
 * the size the pane is, not the size it was born at.
 *
 *   npm run build && electron smoke/reconnectbg.cjs --user-data-dir=...
 *
 * Two complaints, both about the same feature (the automatic retry that keeps a
 * dropped pane, and its scrollback, in place):
 *
 *   1. it was not silent. Pane A dies in the background, the retry succeeds, and the
 *      pane the user was typing in changes under them — `bindSessionToPanel` called
 *      `setActive()` on every bind, reconnect included. A failed retry raised the
 *      global red "Connection failed" bar as well.
 *   2. the pane came back with the wrong screen size. A rebuilt session is created
 *      from the blueprint's cols/rows, and the blueprint never heard about the
 *      resize the pane had sent while it was connected. The PTY therefore came back
 *      at the size the pane was *then* — 80x24 — while the terminal is now much
 *      bigger, which is exactly "vim draws in half the screen". Nothing corrected it
 *      afterwards either: the renderer only pushes a resize when the size *changes*,
 *      and it had not changed.
 *
 * Everything here runs on local shells, so the probe needs no network.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
    all.push(c)
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()

  // A one-second retry delay, so the probe does not sit through the default ten.
  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({
    ...settings,
    onboarded: true,
    reconnect: { enabled: true, attempts: 3, delaySeconds: 1 }
  })

  const win = new BrowserWindow({
    width: 1000,
    height: 640,
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
  await sleep(3000)

  /*
   * Open both shells through the UI rather than by calling the IPC directly.
   *
   * A pane is added by the shell's own handler, not by the main process, so a session
   * created behind its back has no pane at all — which is a fact worth knowing before
   * writing a probe against pane state.
   */
  const setup = `
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const button = document.querySelector('[data-testid="local-shell"]')
      if (!button) return { error: 'no local-shell button' }
      button.click()
      await wait(2500)
      button.click()
      await wait(2500)
      const locals = (await api.listSessions()).filter((s) => s.kind === 'local')
      return {
        ok: locals.length === 2,
        ids: locals.map((s) => s.id),
        panes: [...document.querySelectorAll('[data-terminal-id]')].map((el) =>
          el.getAttribute('data-terminal-id'))
      }
    })()
  `

  let ids = null
  try {
    const opened = await win.webContents.executeJavaScript(setup)
    if (opened && opened.ok) {
      ids = { keep: opened.ids[0], drop: opened.ids[1], panes: opened.panes }
    } else {
      ids = { error: JSON.stringify(opened) }
    }
  } catch (err) {
    report([{ name: 'reconnectbg probe crashed (setup)', ok: false, detail: String(err && err.message) }])
    app.exit(1)
    return
  }
  report([{
    name: 'two local shells can be opened from the drawer',
    ok: !!ids && !ids.error && !!ids.keep && !!ids.drop,
    detail: ids.error ? ids.error : 'panes=' + JSON.stringify(ids.panes)
  }])
  if (!ids || ids.error) {
    console.log(`\n1/${all.length} checks passed`)
    app.exit(1)
    return
  }

  /*
   * Grow the window before anything is measured. Both panes refit and push their new
   * size, so the PTYs — and the blueprints behind them — are told a size the sessions
   * were *not* created with. Without that, the bug this probe is about cannot show up.
   */
  win.setSize(1500, 950)
  await sleep(2500)

  const probe = `
    (async () => {
      const IDS = ${JSON.stringify(ids)}
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck

      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          const v = await fn()
          if (v) return v
          await wait(200)
        }
        return null
      }

      const sessions = () => api.listSessions()
      const live = async (id) => (await sessions()).some((s) => s.id === id)
      const sizeOf = async (id) => {
        const found = (await sessions()).find((s) => s.id === id)
        return found ? { cols: found.cols, rows: found.rows } : null
      }
      const paneEl = (id) => document.querySelector('[data-terminal-id="' + id + '"]')
      /**
       * The whole scrollback of a pane, not just what is on screen.
       *
       * The xterm-rows element holds the viewport only, and a reconnected shell clears
       * the screen as it starts — so the lines from before the drop are *above* the
       * viewport, which is exactly where "history is kept" has to be checked.
       */
      const scrollback = (id) => {
        const hook = window.__tdTerminals
        const entry = hook ? hook[id] : null
        const term = entry ? entry.term : null
        if (!term) return null
        const buf = term.buffer.active
        let text = ''
        for (let i = 0; i < buf.length; i += 1) {
          const line = buf.getLine(i)
          text += (line ? line.translateToString(true) : '') + String.fromCharCode(10)
        }
        return text
      }
      const dock = () => window.__tdDockApi
      /** The pane for a session, however its panel happens to be keyed. */
      const panelFor = (id) => {
        const direct = dock().getPanel(id)
        if (direct) return direct
        return dock().panels.find((p) => {
          let params = null
          try {
            params = p.api.getParameters()
          } catch (err) {
            params = null
          }
          return !!(params && params.session && params.session.id === id)
        })
      }
      const activeId = () => {
        const panel = dock().activePanel
        return panel ? panel.id : ''
      }
      const alertUp = () => !!document.querySelector('[data-testid="connect-alert"]')
      const endedUp = () => !!document.querySelector('[data-testid="session-ended-overlay"]')

      const up = await waitFor(async () => (await sessions()).length === 2, 25000)
      push('both local sessions are up', up, 'sessions=' + (await sessions()).length)
      if (!up) return out
      await waitFor(() => !!paneEl(IDS.drop), 15000)

      // The size the pane had while connected — what a rebuild has to come back at.
      const before = await sizeOf(IDS.drop)
      push('the pane sent a size that is not the 80x24 the session was created with',
        !!before && before.cols > 80 && before.rows > 24,
        'before=' + JSON.stringify(before))

      api.writeSession(IDS.drop, 'echo KEEPME-A1\\r')
      const marked = await waitFor(() => {
        const text = scrollback(IDS.drop)
        return !!text && text.indexOf('KEEPME-A1') >= 0
      }, 20000)
      push('the pane that will drop has printed something worth keeping', marked,
        marked ? 'marker in the scrollback' : 'marker never appeared')

      // ---- the user is working in the other pane ---------------------------
      const keepPanel = panelFor(IDS.keep)
      const dropPanel = panelFor(IDS.drop)
      push('both panes are docked', !!keepPanel && !!dropPanel,
        'panels=' + dock().panels.length + ' ids=' + dock().panels.map((p) => p.id).join(','))
      if (!keepPanel || !dropPanel) return out
      keepPanel.api.setActive()
      await wait(700)
      const activeBefore = activeId()
      push('the user is working in the other pane', activeBefore === IDS.keep,
        'active=' + activeBefore)

      // ---- the background pane drops and retries ---------------------------
      api.writeSession(IDS.drop, 'exit 1\\r')
      const dropped = await waitFor(async () => !(await live(IDS.drop)), 15000)
      push('the background session ends on its own', dropped,
        dropped ? 'session gone' : 'session never ended')

      const back = await waitFor(async () => live(IDS.drop), 25000)
      push('the automatic retry brings it back without being asked', back,
        back ? 'live again' : 'never came back')

      push('and the pane the user was working in is still the active one',
        activeId() === IDS.keep, 'active=' + activeId() + ' expected=' + IDS.keep)
      push('and no connection-failed popup was raised', !alertUp(),
        alertUp() ? 'connect-alert on screen' : 'nothing popped up')
      push('and it is the same pane, not a new one',
        !!panelFor(IDS.drop) && dock().panels.length === 2,
        'panels=' + dock().panels.length)

      /*
       * The size has to be checked while the pane is still in the background: as soon
       * as it is looked at, its fit would correct the PTY and hide the very bug this
       * is about — a pane that reconnects out of sight and is wrong until someone
       * touches it.
       */
      const after = await sizeOf(IDS.drop)
      push('the rebuilt session is sized like the pane, not like its first PTY',
        !!before && !!after && before.cols > 80 && after.cols === before.cols &&
          after.rows === before.rows,
        'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after))

      // ---- the history came back with it -----------------------------------
      /*
       * "History is kept" is checked through the app's own replay: the pane's terminal
       * is *not* what holds it — the main process does, because a hidden tab is
       * unmounted and a restarted shell clears the screen itself (cmd sends an
       * erase-display sequence as it starts). What TermDeck promises is that the
       * output is still there to be replayed into that same pane.
       */
      dropPanel.api.setActive()
      await wait(1500)
      const replay = await api.replaySession(IDS.drop)
      const kept = !!replay && typeof replay.data === 'string' &&
        replay.data.indexOf('KEEPME-A1') >= 0
      push('and the output from before the drop is still there to replay', kept,
        replay ? 'buffer has the marker=' + kept + ' length=' + replay.data.length : 'no replay')

      // ---- a reconnect that cannot be attempted stays in the pane ----------
      api.closeSession(IDS.drop)
      const closed = await waitFor(() => endedUp(), 15000)
      const button = document.querySelector('[data-testid="reconnect-session"]')
      if (!closed || !button) {
        push('a reconnect that cannot be attempted says so in the pane, not in a popup',
          false, closed ? 'no reconnect button' : 'no ended overlay after close')
        return out
      }
      button.click()
      await wait(2500)
      const inPane = !!document.querySelector('[data-testid="reconnect-error"]')
      push('a reconnect that cannot be attempted says so in the pane, not in a popup',
        inPane && !alertUp(),
        'inPane=' + inPane + ' popup=' + alertUp())

      // ---- a finished pane can be closed, and closing ends the retry -------
      /*
       * One more shell, dropped on purpose and then closed from its own overlay while
       * the automatic retry is counting down. Two claims: the pane goes away, and no
       * reconnect lands afterwards. A pane the user closed must not come back — that
       * is the whole point of closing it rather than just stopping the retry.
       */
      const opener = document.querySelector('[data-testid="local-shell"]')
      const beforeOpen = (await api.listSessions()).length
      if (!opener) {
        push('a finished pane offers a way out from its own overlay', false, 'no local-shell button')
        return out
      }
      opener.click()
      const fresh = await waitFor(async () => {
        const now = await api.listSessions()
        return now.length > beforeOpen ? now[now.length - 1] : null
      }, 20000)
      if (!fresh) {
        push('a finished pane offers a way out from its own overlay', false, 'could not open a shell')
        return out
      }
      await wait(2500)
      const panelsBefore = dock().panels.length
      api.writeSession(fresh.id, 'exit 1' + String.fromCharCode(13))
      const retrying = await waitFor(
        () => !!document.querySelector('[data-testid="reconnect-progress"]'),
        20000
      )
      const closeButton = document.querySelector('[data-testid="close-ended-pane"]')
      push('a finished pane offers a way out from its own overlay',
        !!closeButton && !!retrying,
        'button=' + !!closeButton + ' retry counting down=' + !!retrying)
      if (closeButton) {
        closeButton.click()
        await wait(1800)
        const panelsAfter = dock().panels.length
        const alive = (await api.listSessions()).some((entry) => entry.id === fresh.id)
        push('closing it takes the pane and its session away',
          panelsAfter === panelsBefore - 1 && alive === false,
          'panels ' + panelsBefore + ' -> ' + panelsAfter + ' sessionAlive=' + alive)
        /*
         * Longer than every retry the settings allow (three attempts, one second
         * apart): if the loop were still alive, something would have come back.
         */
        await wait(6500)
        const cameBack = (await api.listSessions()).some((entry) => entry.id === fresh.id)
        push('and a closed pane does not reconnect behind the user',
          cameBack === false && dock().panels.length === panelsAfter,
          'cameBack=' + cameBack + ' panels=' + dock().panels.length)
      } else {
        /*
         * Stated, not skipped: an assertion that only runs when the feature exists
         * passes silently on the build that does not have it, which is how a probe
         * ends up green about nothing.
         */
        push('closing it takes the pane and its session away', false,
          'no close button on the overlay, so nothing could be closed')
        push('and a closed pane does not reconnect behind the user', false,
          'no close button on the overlay, so nothing could be closed')
      }
      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{
      name: 'reconnectbg probe crashed',
      ok: false,
      detail: String((err && err.stack) || (err && err.message) || err).slice(0, 600)
    }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('reconnectbg probe crashed:', err)
    app.exit(1)
  })
)
