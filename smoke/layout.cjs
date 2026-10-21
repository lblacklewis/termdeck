/**
 * Layout persistence, verified across a real restart.
 *
 *   npm run build && electron smoke/layout.cjs --user-data-dir=...
 *
 * Runs the app three times against the same user-data-dir: the first arranges the
 * workspace through real clicks and quits; the second starts fresh and must come
 * back to the same arrangement; the third proves a pane reconnected in the second
 * run can be reconnected again. Restored panes must be placeholders, and nothing
 * may be reconnected automatically.
 *
 * The saved-session half of this matters as much as the geometry: a pane opened
 * from the saved list has to remember *which* session it came from across a
 * restart, because a live session id is not something the next launch knows.
 */
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const SSH_USER = process.env.TD_SSH_USER || 'root'
const SSH_KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')
/** The same path with forward slashes, for a value that crosses into the page. */
const SSH_KEY_FWD = SSH_KEY.split(path.sep).join('/')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

/*
 * Host keys for this suite's logins go to a scratch file, so trusting a host here
 * cannot touch the developer's real known_hosts. Set before the IPC module loads.
 */
const knownHostsPath = path.join(os.tmpdir(), 'termdeck-layout-known-hosts')
fs.rmSync(knownHostsPath, { force: true })
process.env['TERMDECK_KNOWN_HOSTS'] = knownHostsPath

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    all.push(c)
  }
}

const DOCK = `(() => {
  const api = window.__tdDockApi
  const panels = api ? api.panels : []
  const paramsOf = (p) => p.api.getParameters() || {}
  return {
    panels: panels.map((p) => p.id),
    groups: document.querySelectorAll('.dv-groupview').length,
    tabs: [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim()),
    restoredPanes: document.querySelectorAll('[data-testid="restored-pane"]').length,
    reconnectButtons: document.querySelectorAll('[data-testid="reconnect-pane"]').length,
    /*
     * Counted from the panels rather than the DOM: a pane stacked behind another
     * tab is not rendered at all, so a placeholder that is merely inactive has no
     * element to count.
     */
    disconnected: panels.filter((p) => paramsOf(p).disconnected === true).length,
    withoutSession: panels.filter((p) => !paramsOf(p).session).length,
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
      nodeIntegration: false,
      // An occluded renderer is throttled and then serves stale computed styles
      // (and never paints), which reads as a 65px pane in a 100x100 grid. See
      // docs/项目会话总结.md.
      backgroundThrottling: false
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
  // Start from a profile with nothing in it: this suite saves a session per run,
  // and a leftover copy from an earlier run would make the "which session is this"
  // lookups ambiguous.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  const layoutFile = path.join(mod.storeAccess().configDir, 'layout.json')

  // Start from a clean arrangement so the second run proves a real restore.
  mod.storeAccess().layout.clear()

  // Trust the test host rather than stopping at a host-key dialog in a suite that
  // is about the layout.
  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({ ...settings, hostKeys: { policy: 'trust' } })

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
    const waitForAsync = async (fn, timeout) => {
      const end = Date.now() + (timeout || 20000)
      while (Date.now() < end) {
        if (await fn()) return true
        await wait(250)
      }
      return false
    }

    const shellBtn = () => document.querySelector('[data-testid="local-shell"]')

    // Two local shells, which is the cheapest real pair of panes.
    shellBtn().click()
    await waitFor(() => window.__tdDockApi && window.__tdDockApi.panels.length >= 1)
    await wait(1200)
    shellBtn().click()
    await waitFor(() => window.__tdDockApi && window.__tdDockApi.panels.length >= 2)
    await wait(1500)

    const api = window.__tdDockApi
    const shellIds = api.panels.map((p) => p.id)

    /*
     * A third pane, this one opened from the saved list: the saved session it came
     * from is what its Reconnect button has to find after a restart.
     */
    const tree = await window.termdeck.saveSession({
      name: 'layout-ssh-target',
      host: '${SSH_HOST}',
      port: 22,
      username: '${SSH_USER}',
      authMethod: 'key',
      privateKeyPath: '${SSH_KEY_FWD}',
      tags: []
    })
    const target = tree.sessions.filter((s) => s.name === 'layout-ssh-target')[0]
    // The tree the page draws comes from a broadcast, so give the new row a moment
    // to appear before deciding it is not there.
    const nodeAppeared = await waitFor(
      () => !!document.querySelector('.td-node[data-node-id="' + target.id + '"]'), 6000
    )
    const node = document.querySelector('.td-node[data-node-id="' + target.id + '"]')
    if (node && node.querySelector('.td-node-main')) {
      node.querySelector('.td-node-main').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
    }
    const sshUp = await waitForAsync(
      () => window.__tdDockApi.panels.length >= 3, 30000
    )
    await wait(1500)
    const ids = api.panels.map((p) => p.id)
    const connectAlert = [].slice.call(document.querySelectorAll('.td-alert'))
      .map((e) => (e.textContent || '').trim()).join(' | ')
    if (api.panels.length >= 2) {
      // Split: move the second shell beside the first, which is the state a user
      // creates by dragging a tab to a pane edge.
      const shell = api.getPanel(shellIds[1]) || api.panels[1]
      shell.api.moveTo({ group: api.getPanel(shellIds[0]).group, position: 'right' })
      await wait(1000)
    }

    /*
     * ---- tab names are readable -----------------------------------------
     *
     * Measured after the split, because that is the state the problem showed up in:
     * dockview's abyss theme paints inactive tab labels white at 50%, and at 25% in a
     * group that is not focused. The second is 2.3:1 on this background — the name is
     * there and unreadable. Everything here has to clear 4.5:1 (WCAG AA for normal
     * text), and the active tab has to be the brightest of them.
     */
    const tabInk = (() => {
      const parseColor = (value) => {
        if (!value || value.indexOf('rgb') !== 0) return null
        const open = value.indexOf('(')
        const close = value.lastIndexOf(')')
        if (open < 0 || close < 0) return null
        const parts = value.slice(open + 1, close).split(',').map((x) => parseFloat(x.trim()))
        if (parts.length < 3) return null
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
      }
      const channel = (v) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
      }
      const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
      const backdropOf = (el) => {
        let node = el
        while (node) {
          const bg = parseColor(getComputedStyle(node).backgroundColor)
          if (bg && bg.a === 1) return bg
          node = node.parentElement
        }
        return parseColor(getComputedStyle(document.body).backgroundColor) || { r: 18, g: 21, b: 27 }
      }
      // A translucent label is composited onto what is behind it before measuring,
      // which is the only way a 25%-white token can be compared with a solid ink.
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a)
      })
      return [...document.querySelectorAll('.dv-tab')].map((tab) => {
        const label = tab.querySelector('.dv-default-tab-content') || tab
        const style = getComputedStyle(label)
        const bg = backdropOf(tab)
        const fg = parseColor(style.color) || { r: 255, g: 255, b: 255, a: 1 }
        const ink = over(fg, bg)
        const high = Math.max(luminance(ink), luminance(bg))
        const low = Math.min(luminance(ink), luminance(bg))
        return {
          name: (tab.textContent || '').trim(),
          active: tab.classList.contains('dv-active-tab'),
          // Every group has an "active" tab; only the focused group's one is *the*
          // active tab. Without this the comparison below mixed the two.
          inActiveGroup: !!tab.closest('.dv-groupview.dv-active-group'),
          ratio: Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100,
          color: style.color
        }
      })
    })()

    // Leave the app on another rail section, so the page persists too.
    document.querySelector('[data-testid="rail-logs"]').click()
    await wait(500)

    return {
      ids,
      targetId: target.id,
      sshUp,
      nodeAppeared,
      connectAlert,
      groups: document.querySelectorAll('.dv-groupview').length,
      tabs: [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()),
      tabInk
    }
  })()`)
  console.log('run 1 arranged:', JSON.stringify(opened))
  await sleep(1500)

  const beforeQuit = await first.webContents.executeJavaScript(DOCK)
  console.log('run 1 dock:', JSON.stringify(beforeQuit))

  const inks = opened.tabInk || []
  const worstInk = inks.reduce((a, b) => (a && a.ratio <= b.ratio ? a : b), null)
  /*
   * "The active tab" is the one in the focused group. Every group has its own active
   * tab, and comparing those against each other compares two dim labels — the first
   * version of this check did exactly that and reported a tie.
   */
  const activeInk = inks.filter((t) => t.active && t.inActiveGroup)[0]
  const dimInactive = inks.filter((t) => !(t.active && t.inActiveGroup))

  report([
    {
      name: 'every tab name is readable against its own strip (4.5:1)',
      ok: !!worstInk && worstInk.ratio >= 4.5,
      detail: worstInk
        ? 'worst is ' + JSON.stringify(worstInk.name) + ' at ' + worstInk.ratio + ':1 (' +
          worstInk.color + ') across ' + inks.length + ' tabs'
        : 'no tabs to measure'
    },
    {
      name: 'and the active tab is the brightest of them',
      ok:
        !!activeInk &&
        dimInactive.length > 0 &&
        activeInk.ratio > Math.min.apply(null, dimInactive.map((t) => t.ratio)),
      detail: activeInk
        ? 'active=' + activeInk.ratio + ':1 inactive=' +
          dimInactive.map((t) => t.name + ':' + t.ratio).join(' ')
        : 'no active tab'
    },
    {
      name: 'the first run arranged its panes',
      ok: beforeQuit.tabs.length >= 3 && opened.sshUp === true,
      detail:
        'tabs=' + JSON.stringify(beforeQuit.tabs) + ' groups=' + beforeQuit.groups +
        ' sshUp=' + opened.sshUp
    },
    { name: 'a layout file was written', ok: fs.existsSync(layoutFile), detail: layoutFile }
  ])

  if (fs.existsSync(layoutFile)) {
    const text = fs.readFileSync(layoutFile, 'utf8')
    /*
     * The dockview state is stored as a string inside the layout file, so its quotes
     * are escaped: the panel list has to be read out of the outer JSON first.
     */
    let dockText = ''
    try {
      dockText = JSON.parse(text).dockview || ''
    } catch {
      dockText = ''
    }
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
      },
      {
        /*
         * The link that makes Reconnect possible at all. A pane's own id is the
         * live session it is showing, which means nothing after a restart; the
         * saved session it came from has to be recorded next to it.
         */
        name: 'a pane opened from the saved list records which session it came from',
        ok: dockText.indexOf('"savedSessionId":"' + opened.targetId + '"') >= 0,
        detail: 'saved=' + opened.targetId + ' in layout=' +
          (dockText.indexOf('"savedSessionId"' ) >= 0)
      },
      {
        name: 'and that is not just its own panel id',
        ok: opened.ids.indexOf(opened.targetId) < 0,
        detail: 'panels=' + JSON.stringify(opened.ids)
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
      name: 'every pane came back',
      ok: afterRestart.tabs.length === beforeQuit.tabs.length,
      detail: 'before=' + JSON.stringify(beforeQuit.tabs) + ' after=' + JSON.stringify(afterRestart.tabs)
    },
    {
      name: 'restored panes are placeholders',
      ok: afterRestart.disconnected === afterRestart.tabs.length &&
        afterRestart.withoutSession === afterRestart.tabs.length,
      detail:
        'panes=' + afterRestart.panels.length + ' disconnected=' + afterRestart.disconnected +
        ' withoutSession=' + afterRestart.withoutSession +
        ' rendered=' + afterRestart.restoredPanes
    },
    {
      name: 'nothing was reconnected automatically',
      ok: afterRestart.restoredPanes > 0 && afterRestart.withoutSession === afterRestart.tabs.length,
      detail: 'no shell or SSH connection was spawned on launch'
    },
    {
      name: 'the previous rail section came back',
      ok: afterRestart.rail === 'logs',
      detail: 'rail=' + afterRestart.rail
    }
  ])

  // ---- a restored pane whose saved session still exists reconnects ---------
  /*
   * The case users actually hit: connect a saved host, quit, launch again, press
   * Reconnect. This used to answer "no longer saved" every time, because the pane
   * had recorded the *live* session id and that id is gone by the next launch.
   * Only the stale-pane case below was ever asserted, which is how it survived.
   */
  const reconnected = await second.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const waitFor = async (fn, timeout) => {
      const end = Date.now() + (timeout || 30000)
      while (Date.now() < end) {
        if (await fn()) return true
        await wait(200)
      }
      return false
    }
    const title = 'layout-ssh-target'
    const tabFor = (t) =>
      [].slice.call(document.querySelectorAll('.dv-tab'))
        .filter((tab) => ((tab.textContent || '').trim()) === t)[0]
    const paneFor = (t) =>
      [].slice.call(document.querySelectorAll('[data-testid="restored-pane"]'))
        .filter((p) => {
          const name = p.querySelector('.td-watermark-title')
          return ((name && name.textContent) || '') === t
        })[0]
    const snap = () => ({
      panels: window.__tdDockApi.panels.length,
      placeholders: document.querySelectorAll('[data-testid="restored-pane"]').length,
      live: document.querySelectorAll('.td-terminal:not(.td-terminal-restored)').length,
      disconnected: window.__tdDockApi.panels
        .filter((p) => (p.api.getParameters() || {}).disconnected === true).length
    })

    /*
     * A pane stacked behind another tab is not rendered, so bring it to the front
     * first: this is what a user does before pressing a button that is not on
     * screen.
     */
    const tab = tabFor(title)
    if (tab) {
      tab.click()
      await wait(700)
    }
    const before = snap()
    const paneParams = window.__tdDockApi.panels.map((p) => {
      const q = p.api.getParameters() || {}
      return {
        id: p.id,
        saved: String(q.savedSessionId || ''),
        title: String(q.title || ''),
        disconnected: q.disconnected === true
      }
    })
    const tree = await window.termdeck.loadSessionTree()
    const sessionNames = tree.sessions.map((s) => s.name)
    const pane = paneFor(title)
    if (!pane) {
      return {
        error: 'no restored pane titled ' + title,
        tabFound: !!tab,
        before,
        paneParams,
        sessionNames,
        tabs: [].slice.call(document.querySelectorAll('.dv-tab'))
          .map((t) => (t.textContent || '').trim())
      }
    }
    const button = pane.querySelector('[data-testid="reconnect-pane"]')
    if (!button) {
      return { error: 'no reconnect button on that pane', before, paneParams, sessionNames }
    }
    button.click()
    const gone = await waitFor(async () => !paneFor(title))
    await wait(600)
    const alert = [].slice.call(document.querySelectorAll('.td-alert'))
      .map((e) => (e.textContent || '').trim()).join(' | ')
    return { before, gone, after: snap(), alert, paneParams, sessionNames }
  })()`)
  console.log('reconnect result:', JSON.stringify(reconnected))

  report([
    {
      name: 'a restored pane whose saved session exists reconnects',
      ok: !reconnected.error && reconnected.gone === true,
      detail:
        reconnected.error ||
        'placeholder gone=' + reconnected.gone + ' before=' + JSON.stringify(reconnected.before)
    },
    {
      name: 'it reconnects into its own pane rather than beside it',
      ok:
        !reconnected.error &&
        reconnected.after.panels === reconnected.before.panels &&
        reconnected.after.placeholders === reconnected.before.placeholders - 1 &&
        reconnected.after.live === reconnected.before.live + 1,
      detail:
        'panels ' + (reconnected.before || {}).panels + ' -> ' + (reconnected.after || {}).panels +
        ', live ' + (reconnected.before || {}).live + ' -> ' + (reconnected.after || {}).live
    },
    {
      name: 'and it does not claim the session is gone',
      ok: !/no longer saved/i.test(reconnected.alert || ''),
      detail: (reconnected.alert || 'no alert').slice(0, 120)
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

    // A session saved *after* the layout was written: no pane came from it, which
    // is the stale case — the pane in front of us is one of the local shells.
    const saved = await api.saveSession({
      name: 'layout-target', host: '127.0.0.1', port: 22,
      username: 'nobody', authMethod: 'password', tags: []
    })
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

  /*
   * ---- run 3: the pane reconnected in run 2 must reconnect again -----------
   *
   * The user's loop is "every time I start the app", not "once after upgrading".
   * A pane that reconnected has to leave the link behind for the *next* launch as
   * well — which it only does if adopting a placeholder keeps the link rather than
   * clearing it.
   */
  second.destroy()
  await sleep(1800)

  const third = await boot()
  const thirdDock = await third.webContents.executeJavaScript(DOCK)
  console.log('run 3 dock:', JSON.stringify(thirdDock))

  const again = await third.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const waitFor = async (fn, timeout) => {
      const end = Date.now() + (timeout || 30000)
      while (Date.now() < end) {
        if (await fn()) return true
        await wait(200)
      }
      return false
    }
    const title = 'layout-ssh-target'
    const paneFor = (t) =>
      [].slice.call(document.querySelectorAll('[data-testid="restored-pane"]'))
        .filter((p) => {
          const name = p.querySelector('.td-watermark-title')
          return ((name && name.textContent) || '') === t
        })[0]
    const tab = [].slice.call(document.querySelectorAll('.dv-tab'))
      .filter((t) => ((t.textContent || '').trim()) === title)[0]
    if (tab) {
      tab.click()
      await wait(700)
    }
    const before = {
      panels: window.__tdDockApi.panels.length,
      live: document.querySelectorAll('.td-terminal:not(.td-terminal-restored)').length
    }
    const pane = paneFor(title)
    if (!pane) return { error: 'no restored pane titled ' + title, before }
    pane.querySelector('[data-testid="reconnect-pane"]').click()
    const gone = await waitFor(async () => !paneFor(title))
    await wait(600)
    const alert = [].slice.call(document.querySelectorAll('.td-alert'))
      .map((e) => (e.textContent || '').trim()).join(' | ')
    return {
      before,
      gone,
      after: {
        panels: window.__tdDockApi.panels.length,
        live: document.querySelectorAll('.td-terminal:not(.td-terminal-restored)').length
      },
      alert
    }
  })()`)
  console.log('second reconnect result:', JSON.stringify(again))

  report([
    {
      name: 'the pane was a placeholder again on the third launch',
      ok:
        thirdDock.disconnected === thirdDock.tabs.length &&
        thirdDock.withoutSession === thirdDock.tabs.length &&
        thirdDock.tabs.indexOf('layout-ssh-target') >= 0,
      detail:
        'panes=' + thirdDock.panels.length + ' disconnected=' + thirdDock.disconnected +
        ' tabs=' + JSON.stringify(thirdDock.tabs)
    },
    {
      name: 'and it reconnects again, in its own pane',
      ok:
        !again.error &&
        again.gone === true &&
        again.after.panels === again.before.panels &&
        again.after.live === again.before.live + 1,
      detail:
        again.error ||
        'panels ' + again.before.panels + ' -> ' + again.after.panels +
        ', live ' + again.before.live + ' -> ' + again.after.live
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
