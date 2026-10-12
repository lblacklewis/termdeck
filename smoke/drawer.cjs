/**
 * The Terminal drawer: its sections, command history, SFTP and focus mode.
 *
 *   npm run build && electron smoke/drawer.cjs --user-data-dir=...
 *
 * Four things that all live in the same corner of the app, checked against the
 * real window: the sections can be reordered by dragging and hidden/restored from
 * their own menu (and the order survives in settings), commands typed into a
 * session show up under History and can be replayed from there, the SFTP panel
 * lists the home directory of a real SSH login, and F11 gives the panes the whole
 * window.
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
  // Host keys for the SFTP login go to a scratch file, so trusting the host here
  // cannot touch the developer's real known_hosts. Before the IPC module loads.
  const knownHostsPath = path.join(os.tmpdir(), 'termdeck-drawer-known-hosts')
  try {
    fs.rmSync(knownHostsPath, { force: true })
  } catch {
    /* a missing file is the point */
  }
  process.env['TERMDECK_KNOWN_HOSTS'] = knownHostsPath

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
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
  // Focus mode is wired in the app entry, which the probes do not boot.
  mod.attachFocusMode(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  // Renderer-side errors are otherwise invisible: `executeJavaScript` only says
  // "script failed to execute".
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.log(`[renderer] ${message} @${line} ${String(source).slice(-40)}`)
  })
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
      let step = 'start'
      try {

      const sections = () =>
        [...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'))
      const headOf = (id) => document.querySelector('[data-section="' + id + '"] .td-section-head')
      const storedOrder = async () => {
        const s = await window.termdeck.loadSettings()
        return s.sidebar.sections.map((x) => x.id + ':' + (x.visible ? 'on' : 'off'))
      }

      // ---- 1. the sections that are there ---------------------------------
      step = 'sections'
      push('the drawer shows its sections', sections().length >= 3, 'order=' + sections().join(','))
      push('the four sections are all present by default',
        ['sessions', 'openSessions', 'history', 'sftp'].every((id) => sections().includes(id)),
        'order=' + sections().join(','))
      push('the section headings are drag handles',
        [...document.querySelectorAll('.td-section-head')].every(
          (h) => h.getAttribute('draggable') === 'true'
        ))

      // ---- 2. dragging a heading reorders the drawer ----------------------
      step = 'reorder'
      const before = sections()
      const drag = (from, to) => {
        const dt = new DataTransfer()
        const fire = (el, type) => {
          const ev = new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, dataTransfer: dt
          })
          el.dispatchEvent(ev)
          return ev.defaultPrevented
        }
        fire(from, 'dragstart')
        fire(to, 'dragenter')
        fire(to, 'dragover')
        fire(to, 'drop')
        fire(from, 'dragend')
      }
      // Move the last section onto the first one's slot.
      const last = before[before.length - 1]
      const first = before[0]
      drag(headOf(last), headOf(first))
      await wait(700)
      const after = sections()
      push('dragging a heading moves that section', after[0] === last && after.length === before.length,
        before.join(',') + ' -> ' + after.join(','))
      push('the new order is saved to settings',
        (await storedOrder())[0].startsWith(last), JSON.stringify(await storedOrder()))

      // ---- 3. hiding and restoring from the section menu ------------------
      step = 'hide'
      const box = headOf('history').getBoundingClientRect()
      headOf('history').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(box.x + 20), clientY: Math.round(box.y + 8)
      }))
      await wait(400)
      const menu = document.querySelector('[data-testid="section-menu"]')
      push('right-clicking a heading opens the section menu', !!menu,
        menu ? menu.innerText.split(String.fromCharCode(10)).join(' | ') : 'none')
      const hideItem = menu && menu.querySelector('[data-menu-id="hide"]')
      push('the menu offers to hide that section', !!hideItem,
        hideItem ? hideItem.innerText : 'none')
      if (hideItem) hideItem.click()
      await wait(700)
      push('hiding removes the section from the drawer', !sections().includes('history'),
        'order=' + sections().join(','))
      push('hiding is saved', (await storedOrder()).some((s) => s === 'history:off'),
        JSON.stringify(await storedOrder()))

      // Bring it back from any other heading's menu.
      const other = headOf('sessions') || headOf('openSessions') || headOf('sftp')
      const otherBox = other.getBoundingClientRect()
      other.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(otherBox.x + 20), clientY: Math.round(otherBox.y + 8)
      }))
      await wait(400)
      const menu2 = document.querySelector('[data-testid="section-menu"]')
      const showItem = menu2 && menu2.querySelector('[data-menu-id="show:history"]')
      push('a hidden section can be restored from the menu', !!showItem,
        menu2 ? menu2.innerText.split(String.fromCharCode(10)).join(' | ') : 'none')
      if (showItem) showItem.click()
      await wait(700)
      push('restoring brings it back', sections().includes('history'),
        'order=' + sections().join(','))

      // ---- 4. folding a section -------------------------------------------
      step = 'collapse'
      const historySection = () => document.querySelector('[data-section="history"]')
      const toggle = document.querySelector('[data-testid="toggle-history"]')
      push('each heading has a fold control', !!toggle)
      if (toggle) {
        toggle.click()
        await wait(500)
        push('folding hides the body but keeps the heading',
          historySection()?.getAttribute('data-collapsed') === 'true' &&
            !!historySection()?.querySelector('.td-section-head') &&
            !historySection()?.querySelector('.td-section-body'),
          'collapsed=' + historySection()?.getAttribute('data-collapsed'))
        push('folding is not hiding',
          !(await storedOrder()).some((s) => s === 'history:off'),
          JSON.stringify(await storedOrder()))
        toggle.click()
        await wait(500)
        push('unfolding brings the body back',
          !!historySection()?.querySelector('.td-section-body'),
          'collapsed=' + historySection()?.getAttribute('data-collapsed'))
      }

      // ---- 5. resizing a section ------------------------------------------
      step = 'resize'
      const bodyOf = (id) => document.querySelector('[data-section="' + id + '"] .td-section-body')
      const handle = document.querySelector('[data-testid="resize-openSessions"]')
      push('each section has a resize handle', !!handle)
      if (handle) {
        const beforeHeight = Math.round(bodyOf('openSessions').getBoundingClientRect().height)
        const box = handle.getBoundingClientRect()
        const opts = { bubbles: true, cancelable: true, clientX: Math.round(box.x + 2) }
        handle.dispatchEvent(
          new PointerEvent('pointerdown', Object.assign({}, opts, { clientY: Math.round(box.y + 2) }))
        )
        window.dispatchEvent(
          new PointerEvent('pointermove', Object.assign({}, opts, { clientY: Math.round(box.y + 62) }))
        )
        window.dispatchEvent(new PointerEvent('pointerup', opts))
        await wait(900)
        const afterHeight = Math.round(bodyOf('openSessions').getBoundingClientRect().height)
        push('dragging the handle resizes the section', afterHeight > beforeHeight + 20,
          beforeHeight + 'px -> ' + afterHeight + 'px')
        const savedResize = await window.termdeck.loadSettings()
        const storedHeight = savedResize.sidebar.sections.find((s) => s.id === 'openSessions')?.height
        push('the size is saved', typeof storedHeight === 'number' && storedHeight > beforeHeight,
          'height=' + storedHeight)
      }

      // ---- 6. the drawer's own width --------------------------------------
      step = 'drawer width'
      const drawerEl = () => document.querySelector('.td-sidebar')
      const widthHandle = document.querySelector('[data-testid="drawer-resize"]')
      push('the drawer has a width handle', !!widthHandle)
      if (widthHandle) {
        const beforeWidth = Math.round(drawerEl().getBoundingClientRect().width)
        const box = widthHandle.getBoundingClientRect()
        const opts = { bubbles: true, cancelable: true, clientY: Math.round(box.y + 40) }
        widthHandle.dispatchEvent(
          new PointerEvent('pointerdown', Object.assign({}, opts, { clientX: Math.round(box.x + 2) }))
        )
        window.dispatchEvent(
          new PointerEvent('pointermove', Object.assign({}, opts, { clientX: Math.round(box.x + 52) }))
        )
        window.dispatchEvent(new PointerEvent('pointerup', opts))
        await wait(900)
        const afterWidth = Math.round(drawerEl().getBoundingClientRect().width)
        push('dragging the edge widens the drawer', afterWidth > beforeWidth + 20,
          beforeWidth + 'px -> ' + afterWidth + 'px')
        const savedWidth = await window.termdeck.loadSettings()
        push('the width is saved', savedWidth.sidebar.width > beforeWidth,
          'width=' + savedWidth.sidebar.width)
      }

      // ---- 7. command history, one file per session ------------------------
      step = 'history'
      const shellBtn = document.querySelector('[data-testid="local-shell"]')
      push('the drawer offers a local shell', !!shellBtn)
      if (shellBtn) shellBtn.click()
      const live = await waitFor(async () => (await window.termdeck.listSessions()).length > 0, 15000)
      push('a session is open for history', live)
      const sessionId = (await window.termdeck.listSessions())[0].id
      const marker = 'echo TD_HISTORY_' + Date.now()
      window.termdeck.writeSession(sessionId, marker + String.fromCharCode(13))
      const listed = await waitFor(
        () => /TD_HISTORY_/.test(document.querySelector('[data-testid="history-list"]')?.textContent || ''),
        8000
      )
      const listText = document.querySelector('[data-testid="history-list"]')?.textContent || ''
      push('a command typed into a session appears in history', listed, listText.slice(0, 80))
      push('history records exactly what was run',
        listText.includes(marker), JSON.stringify(listText.slice(0, 120)))

      // Replaying it writes it to the active pane again.
      const row = document.querySelector('[data-testid="history-list"] .td-history-run')
      const pane = document.querySelector('[data-terminal-id="' + sessionId + '"] .xterm-rows')
      const beforeText = (pane && pane.textContent) || ''
      if (row) row.click()
      await wait(1200)
      const afterText =
        (document.querySelector('[data-terminal-id="' + sessionId + '"] .xterm-rows')?.textContent) || ''
      push('clicking a history entry runs it in the active pane',
        afterText.length > beforeText.length && afterText.includes('TD_HISTORY_'),
        'rows ' + beforeText.length + ' -> ' + afterText.length)

      /*
       * History is a file per session, addressed by the live session id — not one
       * shared list with a session name in it. A session that never ran anything
       * therefore has an empty history rather than everyone else's.
       */
      const ownFile = await window.termdeck.listHistory(sessionId)
      push('this session has its own history file',
        ownFile.length >= 1 && ownFile.some((e) => e.command.includes('TD_HISTORY_')),
        'entries=' + ownFile.length)
      const strangerFile = await window.termdeck.listHistory(
        '00000000-0000-0000-0000-000000000000'
      )
      push('a session that ran nothing has an empty history', strangerFile.length === 0,
        'entries=' + strangerFile.length)
      const summaries = await window.termdeck.historySessions()
      push('the picker lists the sessions that have history',
        summaries.some((s) => s.sessionId === sessionId),
        JSON.stringify(summaries.map((s) => s.sessionId.slice(0, 8) + ':' + s.count)))

      // ---- 5. sftp over a real SSH login ---------------------------------
      step = 'sftp'
      const sshRow = [...document.querySelectorAll('.td-node[data-node-kind="session"]')]
        .find((n) => (n.textContent || '').includes('cloud'))
      push('the saved SSH host is in the tree', !!sshRow)
      if (sshRow) {
        sshRow.querySelector('.td-node-main').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })
        )
      }
      const sshUp = await waitFor(async () =>
        (await window.termdeck.listSessions()).some((s) => s.kind === 'ssh'), 25000)
      push('an SSH login is open', sshUp)

      const sshId = (await window.termdeck.listSessions()).find((s) => s.kind === 'ssh')?.id

      // The two sessions keep separate histories: what is typed into one is not
      // in the other's file.
      window.termdeck.writeSession(sshId, 'echo TD_SSH_HISTORY' + String.fromCharCode(13))
      const sshRecorded = await waitFor(
        async () => (await window.termdeck.listHistory(sshId)).length > 0,
        10000
      )
      const sshEntries = await window.termdeck.listHistory(sshId)
      const localEntries = await window.termdeck.listHistory(sessionId)
      push('each session records its own commands', sshRecorded,
        'ssh=' + sshEntries.length + ' local=' + localEntries.length)
      push('one session never sees the other commands',
        sshEntries.some((e) => e.command.includes('TD_SSH_HISTORY')) &&
          !localEntries.some((e) => e.command.includes('TD_SSH_HISTORY')),
        'ssh=' + JSON.stringify(sshEntries.map((e) => e.command.slice(0, 24))))

      const listed2 = await waitFor(
        () => (document.querySelectorAll('[data-sftp-entry]').length > 0),
        20000
      )
      const rows = [...document.querySelectorAll('[data-sftp-entry]')]
      const pathText = document.querySelector('.td-sftp-path')?.textContent || ''
      push('the SFTP panel lists the remote home directory', listed2,
        'path=' + pathText + ' entries=' + rows.length)
      push('the listing uses absolute remote paths', pathText.startsWith('/'), pathText)

      const dir = rows.find((r) => r.getAttribute('data-sftp-type') === 'directory')
      push('the listing distinguishes directories', !!dir,
        'types=' + rows.slice(0, 6).map((r) => r.getAttribute('data-sftp-type')).join(','))
      if (dir) {
        const name = dir.getAttribute('data-sftp-entry')
        dir.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
        const moved = await waitFor(
          () => (document.querySelector('.td-sftp-path')?.textContent || '').includes(String(name)),
          15000
        )
        push('double-clicking a directory opens it', moved,
          'path=' + (document.querySelector('.td-sftp-path')?.textContent || ''))
        const up = document.querySelector('[data-testid="sftp-up"]')
        if (up) up.click()
        const back = await waitFor(
          () => (document.querySelector('.td-sftp-path')?.textContent || '') === pathText,
          15000
        )
        push('the up button returns', back,
          'path=' + (document.querySelector('.td-sftp-path')?.textContent || ''))
      }

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
    report([{ name: 'drawer probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // ---- 6. focus mode (driven from the main process, as the app does) -------
  const focusState = async () =>
    win.webContents.executeJavaScript(`({
      isFocus: !!document.querySelector('.td-root.is-focus'),
      rail: !!document.querySelector('.td-rail'),
      drawer: !!document.querySelector('.td-sidebar'),
      tools: !!document.querySelector('[data-testid="terminal-tools"]')
    })`)

  const beforeFocus = await focusState()
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
  await sleep(1200)
  const focused = await focusState()
  report([
    {
      name: 'F11 puts the window full screen',
      ok: win.isFullScreen(),
      detail: 'isFullScreen=' + win.isFullScreen()
    },
    {
      /*
       * The rail and the snippet bar go; the drawer stays. Focus mode is about
       * the panes getting the window, not about taking away the list you switch
       * sessions with — that was the first version, and it was the wrong call.
       */
      name: 'focus mode drops the rail but keeps the drawer',
      ok: focused.isFocus && !focused.rail && focused.drawer,
      detail: JSON.stringify({ before: beforeFocus, after: focused })
    }
  ])

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' })
  await sleep(1200)
  const restored = await focusState()
  report([
    {
      name: 'F11 again leaves full screen',
      ok: !win.isFullScreen(),
      detail: 'isFullScreen=' + win.isFullScreen()
    },
    {
      name: 'and the chrome comes back',
      ok: !restored.isFocus && restored.rail && restored.drawer,
      detail: JSON.stringify(restored)
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('drawer probe crashed:', err)
    app.exit(1)
  })
)
