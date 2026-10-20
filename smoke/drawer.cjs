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
  /*
   * A second host, so the drawer's search has something to discriminate between:
   * one row cannot show that a query narrowed anything.
   */
  mod.storeAccess().sessions.upsertSession({
    name: 'web-1',
    host: '10.9.8.7',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    parentId: null,
    tags: ['staging']
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

      /*
       * ---- 1a. the footer stays a row --------------------------------------
       * Measured, not eyeballed. It may wrap on a narrow drawer — there are eight
       * icon buttons — so what is asserted is that the first line holds several of
       * them, which is what tells a wrapping row from a column. That distinction is
       * not hypothetical: a stylesheet edit once cut a selector in half and turned
       * "the collapsed rail stacks its icons" into an unconditional column, and the
       * whole bottom bar went vertical.
       */
      step = 'footer row'
      const footerIcons = [...document.querySelectorAll('.td-sidebar-footer .td-icon-btn')].map(
        (el) => el.getBoundingClientRect()
      )
      push('the footer has its icon buttons', footerIcons.length >= 5,
        'icons=' + footerIcons.length)
      const firstLine = footerIcons.filter(
        (rect) => Math.abs(rect.top - footerIcons[0].top) < 4
      ).length
      const runsRight = footerIcons
        .filter((rect) => Math.abs(rect.top - footerIcons[0].top) < 4)
        .every((rect, i, line) => i === 0 || rect.left > line[i - 1].left)
      push('and a row of them, not one per line',
        footerIcons.length > 1 && firstLine >= 3 && runsRight,
        'first line=' + firstLine + ' of ' + footerIcons.length +
          ' lefts=' + footerIcons.map((r) => Math.round(r.left)).join(','))

      /*
       * ---- 1b. searching the session list ----------------------------------
       * Name, address and tag are the three things people look a host up by, and
       * the tags are already chips below this box — so the check is that the box
       * finds a host by any of the three, not just by its name.
       */
      step = 'tree search'
      const sessionRows = () =>
        [...document.querySelectorAll('.td-node[data-node-kind="session"]')].map((node) =>
          (node.textContent || '').trim()
        )
      const searchBox = document.querySelector('[data-testid="tree-search"]')
      push('the session list has a search box', !!searchBox)
      if (searchBox) {
        const setQuery = async (text) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value'
          ).set
          setter.call(searchBox, text)
          searchBox.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(350)
        }
        const everyone = sessionRows().length
        push('there is more than one saved host to search through', everyone > 1,
          'rows=' + everyone)

        await setQuery('web-1')
        const byName = sessionRows()
        push('a name narrows the list',
          byName.length > 0 && byName.length < everyone && byName.every((r) => r.includes('web-1')),
          'rows=' + byName.length + ' of ' + everyone)

        await setQuery('10.9.8.7')
        const byHost = sessionRows()
        push('so does an address',
          byHost.length > 0 && byHost.every((r) => r.includes('web-1')),
          'rows=' + byHost.length)

        await setQuery('staging')
        const byTag = sessionRows()
        push('and so does a tag', byTag.length > 0 && byTag.every((r) => r.includes('web-1')),
          'rows=' + byTag.length)

        await setQuery('nothing-matches-this')
        push('a search with no match says so rather than showing an empty list',
          sessionRows().length === 0 && !!document.querySelector('[data-testid="tree-no-matches"]'),
          'rows=' + sessionRows().length)

        const clear = document.querySelector('[data-testid="tree-search-clear"]')
        push('there is a way to clear the search', !!clear)
        if (clear) {
          clear.click()
          await wait(350)
        }
        push('clearing brings every host back', sessionRows().length === everyone,
          'rows=' + sessionRows().length + ' of ' + everyone)

        // Escape does the same without reaching for the button.
        await setQuery('web-1')
        searchBox.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
        await wait(350)
        push('and Escape clears it too', sessionRows().length === everyone,
          'rows=' + sessionRows().length + ' of ' + everyone)
      }

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

      // ---- 7. the footer stays put ----------------------------------------
      step = 'pinned footer'
      const scroller = document.querySelector('.td-sidebar-sections')
      const footer = document.querySelector('.td-sidebar-footer')
      push('the sections scroll in their own container, above the footer',
        !!scroller && !!footer,
        'scroller=' + !!scroller + ' footer=' + !!footer)
      // Make the sections overflow on purpose: four of them at 400px cannot fit.
      const bulge = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...bulge,
        sidebar: {
          ...bulge.sidebar,
          sections: bulge.sidebar.sections.map((s) => ({ ...s, height: 400 }))
        }
      })
      await wait(900)
      const overflow = scroller ? scroller.scrollHeight - scroller.clientHeight : 0
      const footerBox = footer?.getBoundingClientRect()
      const drawerBox = drawerEl()?.getBoundingClientRect()
      const bodyHeights = [...document.querySelectorAll('.td-section-body')]
        .map((b) => Math.round(b.getBoundingClientRect().height)).join(',')
      push('the sections really do overflow', overflow > 100,
        'overflow=' + overflow + 'px scroller=' +
          (scroller ? scroller.clientHeight + '/' + scroller.scrollHeight : 'none') +
          ' bodies=[' + bodyHeights + ']')
      push('the footer is still inside the drawer, at its bottom',
        !!footerBox && !!drawerBox && footerBox.bottom <= drawerBox.bottom + 1 &&
          footerBox.top >= drawerBox.top + drawerBox.height / 2,
        footerBox && drawerBox
          ? 'footer=' + Math.round(footerBox.top) + '-' + Math.round(footerBox.bottom) +
            ' drawer=' + Math.round(drawerBox.top) + '-' + Math.round(drawerBox.bottom)
          : 'missing')

      // Put the heights back to auto so the rest of the suite sees a normal drawer.
      await window.termdeck.saveSettings({
        ...bulge,
        sidebar: {
          ...bulge.sidebar,
          sections: bulge.sidebar.sections.map((s) => ({ ...s, height: undefined }))
        }
      })
      await wait(700)

      // ---- 8. docking the drawer on the other edge ------------------------
      step = 'dock right'
      // The drawer element itself is already defined above; this is the rest of
      // the geometry the docking checks need.
      const contentEl = () => document.querySelector('.td-content')
      const boxOf = (el) => (el ? el.getBoundingClientRect() : null)
      const savedSide = async () => (await window.termdeck.loadSettings()).sidebar.side

      /*
       * A drag is a path through coordinates, so every event goes to whatever is
       * under the pointer — never to the element the probe privately hopes will
       * receive it.
       *
       * Dispatching the drop straight at the drawer is what made the first version
       * of this check pass while the real gesture could never work: the pointer
       * during a real drag is out over the workspace, which is not inside the
       * 268px drawer, so the drawer's own drop listener never fired at all.
       */
      const dragTo = async (handle, x, y) => {
        const dt = new DataTransfer()
        const at = (type) => {
          const el = document.elementFromPoint(x, y) || document.body
          const ev = new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
            clientX: x, clientY: y
          })
          el.dispatchEvent(ev)
          return { el, accepted: ev.defaultPrevented }
        }
        const from = handle.getBoundingClientRect()
        handle.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true, cancelable: true, composed: true, dataTransfer: dt,
          clientX: Math.round(from.x + from.width / 2),
          clientY: Math.round(from.y + from.height / 2)
        }))
        await wait(250)
        const over = at('dragover')
        await wait(150)
        const dropped = at('drop')
        handle.dispatchEvent(new DragEvent('dragend', {
          bubbles: true, cancelable: true, composed: true, dataTransfer: dt
        }))
        await wait(1100)
        return {
          over,
          accepted: over.accepted && dropped.accepted,
          landedOn: over.el.className || over.el.tagName,
          // The gesture only proves anything if the pointer was outside the
          // drawer: that is the part the old check silently skipped.
          outsideDrawer: !over.el.closest('.td-sidebar')
        }
      }
      const halfX = (side) =>
        Math.round(window.innerWidth * (side === 'right' ? 0.75 : 0.25))
      const halfY = Math.round(window.innerHeight / 2)

      const grip = document.querySelector('[data-testid="drawer-grip"]')
      push('the drawer has a grip to move it', !!grip)
      const contentBefore = boxOf(contentEl())
      const drawerBefore = boxOf(drawerEl())
      push('it starts on the left of the workspace',
        !!contentBefore && !!drawerBefore && drawerBefore.left < contentBefore.left,
        drawerBefore && contentBefore
          ? 'drawer.left=' + Math.round(drawerBefore.left) +
            ' content.left=' + Math.round(contentBefore.left)
          : 'missing')

      if (grip) {
        const dragRight = await dragTo(grip, halfX('right'), halfY)
        push('the drop really lands outside the drawer, over the workspace',
          dragRight.outsideDrawer, 'landed on ' + dragRight.landedOn)
        push('dropping the grip on the workspace docks the drawer right',
          (await savedSide()) === 'right',
          'side=' + (await savedSide()) + ' accepted=' + dragRight.accepted +
            ' landedOn=' + dragRight.landedOn)
        const drawerBoxAfter = boxOf(drawerEl())
        const contentAfter = boxOf(contentEl())
        push('the drawer really is on the right of the workspace',
          !!drawerEl()?.classList.contains('is-right') && !!contentAfter && !!drawerBoxAfter &&
            drawerBoxAfter.left >= contentAfter.right - 1,
          drawerBoxAfter && contentAfter
            ? 'drawer.left=' + Math.round(drawerBoxAfter.left) +
              ' content.right=' + Math.round(contentAfter.right)
            : 'missing')
      }

      // ---- 8b. a section heading docks it too -----------------------------
      /*
       * This is the gesture the report was about: dragging a section such as Open
       * sessions to the far side of the window. It has to move the *drawer* —
       * sections cannot live on their own over there — and it must not be
       * mistaken for a reorder.
       */
      step = 'dock by section'
      const heading = headOf('openSessions')
      push('the section heading is still a drag handle', !!heading)
      if (heading) {
        const orderBefore = sections().join(',')
        const dragLeft = await dragTo(heading, halfX('left'), halfY)
        push('dragging a section to the other half lands outside the drawer',
          dragLeft.outsideDrawer, 'landed on ' + dragLeft.landedOn)
        push('dragging a section to the other half docks the drawer there',
          (await savedSide()) === 'left',
          'side=' + (await savedSide()) + ' accepted=' + dragLeft.accepted)
        push('and it is not read as a reorder', sections().join(',') === orderBefore,
          orderBefore + ' -> ' + sections().join(','))
      }

      // ---- 8c. the menu is the deterministic route -------------------------
      /*
       * The drag above is a real gesture with a real destination, but not everyone
       * reaches for a drag. The menu says what it does in words, so it is the path
       * that has to work when the pointer never leaves the drawer.
       */
      step = 'dock by menu'
      const dockByMenu = async (target) => {
        const head = headOf('sessions') || headOf('openSessions') || headOf('history')
        if (!head) return null
        const box = head.getBoundingClientRect()
        head.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(box.x + 20), clientY: Math.round(box.y + 8)
        }))
        await wait(400)
        const menu = document.querySelector('[data-testid="section-menu"]')
        const item = menu && menu.querySelector('[data-menu-id="dock"]')
        const label = item ? item.innerText : null
        if (item) item.click()
        await wait(900)
        return { label, side: await savedSide(), target }
      }

      const toRight = await dockByMenu('right')
      push('the section menu offers to move the drawer',
        !!toRight && /right side/.test(toRight.label || ''),
        toRight ? JSON.stringify(toRight.label) : 'no menu item')
      push('the menu entry docks the drawer on the right',
        !!toRight && toRight.side === 'right', 'side=' + (toRight && toRight.side))
      const dockedBox = boxOf(drawerEl())
      const dockedContent = boxOf(contentEl())
      push('the geometry agrees: drawer right of the workspace',
        !!dockedBox && !!dockedContent && dockedBox.left >= dockedContent.right - 1,
        dockedBox && dockedContent
          ? 'drawer.left=' + Math.round(dockedBox.left) +
            ' content.right=' + Math.round(dockedContent.right)
          : 'missing')

      // Back to the left, from the menu, so the rest of the suite finds the drawer
      // where it expects and the return trip is covered by the same assertions.
      const toLeft = await dockByMenu('left')
      push('the menu docks it back on the left', !!toLeft && toLeft.side === 'left',
        'side=' + (toLeft && toLeft.side))
      const backBox = boxOf(drawerEl())
      const backContent = boxOf(contentEl())
      push('and the geometry agrees again: drawer left of the workspace',
        !!backBox && !!backContent && backBox.left < backContent.left,
        backBox && backContent
          ? 'drawer.left=' + Math.round(backBox.left) +
            ' content.left=' + Math.round(backContent.left)
          : 'missing')

      // ---- 9. command history, one file per session ------------------------
      step = 'history'
      /*
       * Run a command and record it the way the renderer does on Enter.
       *
       * Recording is renderer-side now: at the moment Enter is pressed it reads the
       * executed line back off the terminal screen and calls history:record (see
       * useTerminal's report). The main process no longer assembles lines from the
       * input stream, so writeSession — which pushes bytes straight at the pty —
       * leaves the history empty while the shell still runs the command. That is why
       * this section reported entries=0.
       *
       * A synthetic Enter does not reach xterm from an injected script (the same
       * reason smoke:suggest only ever accepts a candidate and never runs a line), so
       * the recording half goes through the very IPC the renderer calls. What the
       * recorded line contains is asserted in smoke:suggest; this section is about
       * the drawer panel, the per-session files and the picker.
       */
      const runAndRecord = async (id, command) => {
        window.termdeck.writeSession(id, command + String.fromCharCode(13))
        await window.termdeck.recordCommand(id, command)
      }

      const shellBtn = document.querySelector('[data-testid="local-shell"]')
      push('the drawer offers a local shell', !!shellBtn)
      if (shellBtn) shellBtn.click()
      const live = await waitFor(async () => (await window.termdeck.listSessions()).length > 0, 15000)
      push('a session is open for history', live)
      const sessionId = (await window.termdeck.listSessions())[0].id
      const marker = 'echo TD_HISTORY_' + Date.now()
      await runAndRecord(sessionId, marker)
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
      await runAndRecord(sshId, 'echo TD_SSH_HISTORY')
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

      /*
       * Folded by default, and folded means *not connected*: the panel is not
       * mounted at all, so no second channel to the host is opened until someone
       * asks to see a directory listing.
       */
      const sftpSection = document.querySelector('[data-section="sftp"]')
      push('the sftp panel starts folded',
        !!sftpSection && sftpSection.getAttribute('data-collapsed') === 'true',
        sftpSection ? 'collapsed=' + sftpSection.getAttribute('data-collapsed') : 'no section')
      push('and nothing is listed before it is opened',
        document.querySelectorAll('[data-sftp-entry]').length === 0,
        'rows=' + document.querySelectorAll('[data-sftp-entry]').length)
      const sftpToggle = document.querySelector('[data-testid="toggle-sftp"]')
      if (sftpToggle) sftpToggle.click()
      push('opening it expands the section', await waitFor(
        () => (document.querySelector('[data-section="sftp"]') || {}).getAttribute?.('data-collapsed') === 'false',
        8000
      ))

      const listed2 = await waitFor(
        () => (document.querySelectorAll('[data-sftp-entry]').length > 0),
        20000
      )
      const rows = [...document.querySelectorAll('[data-sftp-entry]')]
      /*
       * The path box is an input now, so its text is el.value and not textContent.
       * One reader for everything that wants to know where the panel is looking.
       */
      const pathShown = () => {
        const el = document.querySelector('.td-sftp-path')
        if (!el) return ''
        return typeof el.value === 'string' ? el.value : (el.textContent || '')
      }
      // React tracks its own copy of an input's value, so setting el.value alone
      // is ignored; the native setter plus an input event is what reaches onChange.
      const typeInto = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const pressKey = (el, key) =>
        el.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }))
      const pathText = pathShown()
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
          () => pathShown().includes(String(name)),
          15000
        )
        push('double-clicking a directory opens it', moved,
          'path=' + pathShown())
        const up = document.querySelector('[data-testid="sftp-up"]')
        if (up) up.click()
        const back = await waitFor(
          () => pathShown() === pathText,
          15000
        )
        push('the up button returns', back,
          'path=' + pathShown())
      }

      // ---- typing a path --------------------------------------------------
      // The reason the box exists: jumping straight to a path instead of
      // double-clicking through four directories to get there.
      step = 'type a path'
      const pathBox = document.querySelector('[data-testid="sftp-path"]')
      push('the path is an editable field', !!pathBox && pathBox.tagName === 'INPUT',
        pathBox ? pathBox.tagName : 'missing')
      if (pathBox) {
        typeInto(pathBox, '/etc')
        pressKey(pathBox, 'Enter')
        /*
         * Assert on the *listing*, not on the box: the box holds the draft the
         * user typed until the read comes back, so reading it straight after
         * Enter matches the draft and proves nothing. /etc/passwd is on every
         * Linux host this suite can reach.
         */
        const jumped = await waitFor(
          () => !!document.querySelector('[data-sftp-entry="passwd"]'),
          20000
        )
        push('typing a path and pressing Enter lists it', jumped, 'path=' + pathShown())
        push('the box then shows the directory it listed', pathShown() === '/etc',
          'path=' + pathShown())
        const etcRows = document.querySelectorAll('[data-sftp-entry]').length
        push('the new directory has entries', etcRows > 0, 'entries=' + etcRows)

        // Escape abandons the edit: the box goes back to what is listed, rather
        // than keeping the text of a path nobody loaded.
        typeInto(pathBox, '/nowhere/at/all')
        pressKey(pathBox, 'Escape')
        await wait(200)
        push('Escape puts the box back to the listing', pathShown() === '/etc',
          'path=' + pathShown())

        // A path that does not exist must say so and stay where it was.
        typeInto(pathBox, '/no/such/directory')
        pressKey(pathBox, 'Enter')
        await wait(1200)
        push('a path that does not exist leaves the listing alone',
          pathShown() === '/etc' && !!document.querySelector('[data-sftp-entry="passwd"]'),
          'path=' + pathShown())
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

  // ---- 5b. the history timestamp is a hover detail ------------------------
  /*
   * Hovered with real input rather than a dispatched MouseEvent: CSS `:hover`
   * does not react to synthetic events, so the pointer has to actually be there.
   * The row is measured before and after, which is what makes "hidden until you
   * look at it" a claim that can fail.
   */
  await win.webContents.executeJavaScript(`
    (() => {
      const head = document.querySelector('[data-section="history"] .td-section-head')
      if (head && !document.querySelector('[data-testid="history-list"]')) head.click()
      return true
    })()
  `)
  await sleep(500)
  const historyRow = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-testid="history-list"] .td-history-item')
      if (!row) return null
      const box = row.getBoundingClientRect()
      const meta = row.querySelector('.td-history-meta')
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        opacity: meta ? getComputedStyle(meta).opacity : 'no-meta'
      }
    })()
  `)

  report([
    {
      name: 'the history timestamp is hidden until the row is hovered',
      ok: !!historyRow && historyRow.opacity === '0',
      detail: historyRow ? 'opacity=' + historyRow.opacity : 'no history row on screen'
    }
  ])

  if (historyRow) {
    /*
     * The hover is forced through the debugger rather than produced by moving the
     * pointer there.
     *
     * CSS `:hover` is the compositor's answer to where the pointer is, and that
     * position only updates while this window owns the foreground — which it may
     * well not, two suites and a dozen windows later in the chain. Both
     * `sendInputEvent` and `Input.dispatchMouseEvent` were tried: the first silently
     * does nothing when the window is in the background, the second moves the
     * compositor's idea of the pointer but Chromium still skips the hit test. So
     * this asks devtools to force the pseudo-class, which is the same switch the
     * inspector's ":hov" toggle flips — what is measured is then the rule itself,
     * not the window manager.
     */
    const opacityOfMeta = () =>
      win.webContents.executeJavaScript(
        `(() => {
          const meta = document.querySelector('[data-testid="history-list"] .td-history-item .td-history-meta')
          return meta ? getComputedStyle(meta).opacity : 'no-meta'
        })()`
      )

    let hoveredOpacity = 'debugger-unavailable'
    try {
      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('DOM.enable')
      await win.webContents.debugger.sendCommand('CSS.enable')
      const root = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: 1 })
      const found = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: root.root.nodeId,
        selector: '[data-testid="history-list"] .td-history-item'
      })
      if (found.nodeId) {
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {
          nodeId: found.nodeId,
          forcedPseudoClasses: ['hover']
        })
        await sleep(400)
        hoveredOpacity = await opacityOfMeta()
      }
    } catch (err) {
      hoveredOpacity = 'error: ' + String((err && err.message) || err)
    }

    report([
      {
        name: 'and hovering the row reveals its timestamp',
        ok: hoveredOpacity === '1',
        detail: 'opacity=' + hoveredOpacity
      }
    ])

    /*
     * With the pseudo-class released the timestamp goes back to being a detail
     * rather than a column — the pair of readings is what makes "hidden until you
     * look at it" a claim that can fail in either direction.
     */
    try {
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {
        nodeId: 0,
        forcedPseudoClasses: []
      })
    } catch {
      // Clearing by node 0 is not supported everywhere; detaching does the same.
    }
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    await sleep(400)
    const released = await opacityOfMeta()
    report([
      {
        name: 'and hides again when the pointer leaves',
        ok: released === '0',
        detail: 'opacity=' + released
      }
    ])
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
