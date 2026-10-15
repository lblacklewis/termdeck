/**
 * The Hosts page as the host manager, and the tab menu's duplicate connection.
 *
 *   npm run build && electron smoke/hosts.cjs --user-data-dir=...
 *
 * Covers the things that were reported missing: connecting from Hosts must land on
 * Terminal, Hosts must have no drawer of its own, hosts must be editable and
 * groups creatable/deletable, rows and cards must be switchable, and a host must be
 * draggable into another group. Plus the tab menu's "duplicate connection", which
 * has to open a second *live* channel rather than a copy of the tab.
 */
const path = require('node:path')
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

async function main() {
  // Wipe before anything constructs a store: `storeAccess()` caches in memory, so
  // deleting the files afterwards leaves the previous run's hosts in place.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()

  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  /*
   * Seed before the window loads: the renderer reads the tree once on mount, so
   * hosts written afterwards would not appear until something else refreshed it —
   * and the page would be judged empty for the wrong reason.
   */
  mod.storeAccess().sessions.upsertFolder({ name: 'prod' })
  mod.storeAccess().sessions.upsertFolder({ name: 'staging' })
  const treeAfterFolders = mod.storeAccess().sessions.load()
  const prod = treeAfterFolders.folders.find((f) => f.name === 'prod')
  const staging = treeAfterFolders.folders.find((f) => f.name === 'staging')

  mod.storeAccess().sessions.upsertSession({
    name: 'web-1', host: '10.0.0.11', port: 22, username: 'deploy', authMethod: 'password',
    parentId: prod.id, tags: ['web']
  })
  mod.storeAccess().sessions.upsertSession({
    name: 'db-1', host: '10.0.0.12', port: 22, username: 'root', authMethod: 'password',
    parentId: prod.id, tags: []
  })
  mod.storeAccess().sessions.upsertSession({
    name: 'stage-1', host: '10.0.1.11', port: 22, username: 'deploy', authMethod: 'password',
    parentId: staging.id, tags: ['web']
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
      // An occluded renderer is throttled and then serves stale computed styles
      // (and never paints), which reads as a 65px pane in a 100x100 grid. See
      // docs/项目会话总结.md.
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)
  /*
   * A tripwire, not a crutch.
   *
   * Naming a group must go through the app's own centred dialog: the browser's
   * `prompt()` is refused by Electron's renderer, which is how renaming from the
   * drawer used to close its menu and do nothing. Counting calls means a
   * regression to `prompt()` fails here instead of hanging an unattended run.
   * Installed after the reload, whose fresh context would discard it.
   */
  await win.webContents.executeJavaScript(
    `window.__tdPromptCalls = 0; window.prompt = () => { window.__tdPromptCalls++; return null }; true`
  )

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const drag = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
      /** Set a controlled input the way React observes it. */
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      /*
       * Answer the centred naming prompt.
       *
       * Creating or renaming a group asks for its name now, in a dialog in the
       * middle of the window: it used to create a second "New group" silently, and
       * to rename through a field in the page header, at the opposite corner from
       * the row that was right-clicked.
       */
      const answerNamePrompt = async (value) => {
        await wait(400)
        const form = document.querySelector('[data-testid="name-prompt"]')
        if (!form) return false
        setValue(form.querySelector('[aria-label="group-name"]'), value)
        await wait(150)
        form.querySelector('[data-testid="name-prompt-save"]').click()
        await wait(900)
        return true
      }

      // ---- open the Hosts page --------------------------------------------
      document.querySelector('[data-testid="rail-hosts"]').click()
      await wait(900)
      const page = document.querySelector('[data-testid="hosts-page"]')
      push('the hosts page opens', page)
      if (!page) return out

      push('hosts has no drawer of its own', !document.querySelector('.td-sidebar'))
      push('the drawer buttons are gone from hosts',
        !document.querySelector('[data-testid="open-connections"]'))

      // ---- state of the new manager controls -------------------------------
      push('the page offers New group and New host',
        !!document.querySelector('[data-testid="hosts-new-group"]') &&
          !!document.querySelector('[data-testid="hosts-new-host"]'))

      // ---- the two shapes --------------------------------------------------
      const rows = () => [...document.querySelectorAll('[data-host-row]')]
      const rowNames = () => rows().map((r) => r.getAttribute('data-host-row'))
      push('hosts are listed as rows',
        rows().length === 3 && new Set(rowNames()).size === 3,
        rows().length + ' row(s): ' + rowNames().join(','))
      push('rows are the default shape',
        !!document.querySelector('.td-host-list.is-list'), 'is-list present')

      document.querySelector('[data-testid="hosts-view-cards"]').click()
      await wait(400)
      push('switching to cards re-lays the same hosts',
        !!document.querySelector('.td-host-list.is-cards') && rows().length === 3,
        'cards=' + !!document.querySelector('.td-host-list.is-cards') + ' rows=' + rows().length)

      /*
       * The page is unmounted whenever another rail section is showing, so a view
       * kept in the page's own state lasted exactly until the user looked at
       * something else — leave, come back, and it was rows again. The choice is
       * the shell's now, and it is written to the layout.
       */
      document.querySelector('[data-testid="rail-logs"]').click()
      await wait(600)
      document.querySelector('[data-testid="rail-hosts"]').click()
      await wait(700)
      push('the card view survives leaving the page and coming back',
        !!document.querySelector('.td-host-list.is-cards') && rows().length === 3,
        'cards=' + !!document.querySelector('.td-host-list.is-cards') + ' rows=' + rows().length)

      const storedView = await window.termdeck.loadLayout()
      push('and the view is written to the saved layout',
        storedView.hostsView === 'cards', 'hostsView=' + storedView.hostsView)

      document.querySelector('[data-testid="hosts-view-list"]').click()
      await wait(300)
      push('switching back restores rows', !!document.querySelector('.td-host-list.is-list'))
      push('and that is saved too',
        (await window.termdeck.loadLayout()).hostsView === 'list',
        'hostsView=' + (await window.termdeck.loadLayout()).hostsView)

      // ---- groups ----------------------------------------------------------
      const groupNames = () => [...document.querySelectorAll('[data-host-group]')]
        .map((s) => s.getAttribute('data-host-group'))
      /*
       * Every group is listed, including the catch-all.
       *
       * Named groups and "Unfiled" are all drop targets, so an empty one still gets
       * a heading — which is also why a newly created sub-group is visible before
       * anything has been dragged into it.
       */
      push('groups are shown', groupNames().join(',') === 'prod,staging,Unfiled',
        groupNames().join(','))

      document.querySelector('[data-testid="hosts-new-group"]').click()
      const askedForName = await answerNamePrompt('New group')
      push('a new group asks for its name in a centred dialog', askedForName)
      push('a new group can be created', groupNames().includes('New group'),
        groupNames().join(','))

      // Rename and delete through the group header's menu.
      const newGroupHead = [...document.querySelectorAll('.td-host-group-head')]
        .find((h) => (h.textContent || '').includes('New group'))
      if (newGroupHead) {
        const box = newGroupHead.getBoundingClientRect()
        newGroupHead.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(box.x + 40), clientY: Math.round(box.y + 8)
        }))
        await wait(400)
        const menu = document.querySelector('[data-testid="hosts-menu"]')
        push('a group menu offers rename and delete',
          !!menu && !!menu.querySelector('[data-menu-id="rename"]') &&
            !!menu.querySelector('[data-menu-id="delete"]'),
          menu ? [...menu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id')).join(',') : 'no menu')

        /*
         * Rename through the real control.
         *
         * It used to call the browser prompt, which Electron's renderer refuses —
         * the menu item closed and nothing happened. Then it became an inline field
         * in the far corner of the page; now it is the same centred dialog that
         * creating a group uses, so the check drives that: open, type, save, and
         * confirm the new name is actually in the tree.
         */
        if (menu) {
          menu.querySelector('[data-menu-id="rename"]').click()
          await wait(500)
          const prompt = document.querySelector('[data-testid="name-prompt"]')
          push('rename opens a centred dialog rather than a browser prompt', !!prompt,
            'prompt=' + !!prompt)
          if (prompt) {
            const input = prompt.querySelector('[aria-label="group-name"]')
            push('the dialog is prefilled with the current name',
              input && input.value === 'New group', 'value=' + (input ? input.value : 'none'))
            setValue(input, 'Renamed group')
            await wait(200)
            prompt.querySelector('[data-testid="name-prompt-save"]').click()
            await wait(900)
            const tree = await api.loadSessionTree()
            push('the renamed group is saved',
              tree.folders.some((f) => f.name === 'Renamed group') &&
                !tree.folders.some((f) => f.name === 'New group'),
              tree.folders.map((f) => f.name).join(','))
            push('the page shows the new name', groupNames().includes('Renamed group'),
              groupNames().join(','))
          }
        }
      }

      // ---- a sub-group is created and must actually appear ----------------
      // It used to be created in the store and then not rendered, because the page
      // dropped any group that was empty and not top-level — indistinguishable
      // from the menu item doing nothing.
      {
        const prodHead = [...document.querySelectorAll('[data-testid="hosts-group"]')][0]
        const probeFolder = await api.loadSessionTree()
        const prodFolder = probeFolder.folders.find((f) => f.name === 'prod')
        const box = prodHead.getBoundingClientRect()
        prodHead.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(box.x + 30), clientY: Math.round(box.y + 10)
        }))
        await wait(400)
        const subMenu = document.querySelector('[data-testid="hosts-menu"]')
        push('the group menu offers a sub-group',
          !!subMenu && !!subMenu.querySelector('[data-menu-id="newSub"]'),
          subMenu
            ? [...subMenu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id')).join(',')
            : 'no menu')

        if (subMenu && subMenu.querySelector('[data-menu-id="newSub"]')) {
          subMenu.querySelector('[data-menu-id="newSub"]').click()
          const namedSub = await answerNamePrompt('Nested')
          push('a sub-group asks for its name too', namedSub)

          const tree = await api.loadSessionTree()
          const child = tree.folders.find((f) => f.parentId === prodFolder.id)
          push('the sub-group is created under its parent',
            !!child, 'parent=' + prodFolder.id.slice(0, 8) +
              ' children=' + tree.folders.filter((f) => f.parentId === prodFolder.id).map((f) => f.name).join(','))

          push('the sub-group is rendered immediately, while still empty',
            groupNames().includes('prod / Nested') &&
              !!document.querySelector('.td-host-subgroups'),
            'groups=' + groupNames().join(' | ') + ' subgroups=' +
              document.querySelectorAll('.td-host-subgroups').length)

          const nestDepth = [...document.querySelectorAll('[data-host-group]')]
            .map((g) => g.getAttribute('data-group-depth')).join(',')
          push('the sub-group is indented below its parent',
            nestDepth.startsWith('0,1'), 'depths=' + nestDepth)
        }
      }

      // ---- the page background has its own menu ---------------------------
      // Somewhere to click that is neither a host nor a group was previously dead,
      // which is where "add a host" is most naturally reached from.
      {
        const body = document.querySelector('[data-testid="hosts-body"]')
        const box = body.getBoundingClientRect()
        body.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(box.x + box.width / 2),
          clientY: Math.round(box.y + box.height - 30)
        }))
        await wait(400)
        const pageMenu = document.querySelector('[data-testid="hosts-menu"]')
        const ids = pageMenu
          ? [...pageMenu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id'))
          : []
        push('right-clicking the page background opens a menu',
          ids.includes('newHost') && ids.includes('newGroup'), ids.join(','))

        // The menu must be fully on screen and wide enough for its labels: it was
        // reported as showing only part of each item.
        if (pageMenu) {
          const mb = pageMenu.getBoundingClientRect()
          const items = [...pageMenu.querySelectorAll('.td-menu-item')]
          const clipped = items.filter((item) => {
            const label = item.querySelector('span')
            return label ? label.scrollWidth > label.clientWidth + 1 : false
          })
          push('the menu fits inside the viewport',
            mb.left >= 0 && mb.top >= 0 &&
              mb.right <= window.innerWidth + 1 && mb.bottom <= window.innerHeight + 1,
            JSON.stringify({ w: Math.round(mb.width), h: Math.round(mb.height) }))
          push('no menu label is cut off', clipped.length === 0,
            'clipped=' + clipped.length + '/' + items.length +
              ' widths=' + items.map((i) => Math.round(i.getBoundingClientRect().width)).join(','))
          push('every menu item shows its own text',
            items.length > 0 && items.every((i) => (i.textContent || '').trim().length > 0),
            items.map((i) => (i.querySelector('span') || {}).textContent).join(' | '))
        }

        // Choosing New group from the page menu must actually create one.
        const before = groupNames().length
        if (pageMenu && pageMenu.querySelector('[data-menu-id="newGroup"]')) {
          pageMenu.querySelector('[data-menu-id="newGroup"]').click()
          await answerNamePrompt('From the menu')
          push('the page menu can create a group', groupNames().length === before + 1,
            before + ' -> ' + groupNames().length + ': ' + groupNames().join(','))
        }
      }

      // ---- drag a host into another group ---------------------------------
      const beforeGroups = groupNames()
      const host = document.querySelector('[data-host-row]')
      const hostName = host ? host.querySelector('.td-host-name').textContent : null
      const stageSection = [...document.querySelectorAll('[data-host-group]')]
        .find((s) => s.getAttribute('data-host-group') === 'staging')
      push('a host and a target group exist for the drag', !!host && !!stageSection,
        'host=' + hostName + ' target=' + !!stageSection)
      if (host && stageSection) {
        drag(host, 'dragstart')
        await wait(120)
        drag(stageSection, 'dragover')
        drag(stageSection, 'drop')
        await wait(900)
        const tree = await api.loadSessionTree()
        const moved = tree.sessions.find((s) => s.name === hostName)
        const stagingFolder = tree.folders.find((f) => f.name === 'staging')
        push('dragging a host onto a group files it there',
          !!moved && moved.parentId === stagingFolder.id,
          'host=' + hostName + ' parent=' + (moved ? moved.parentId : null) +
            ' staging=' + stagingFolder.id)
        void beforeGroups
      }

      // ---- edit and create from the page ----------------------------------
      const anyHost = document.querySelector('[data-host-row]')
      anyHost.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2
      }))
      await wait(400)
      const hostMenu = document.querySelector('[data-testid="hosts-menu"]')
      push('a host menu offers edit, duplicate and delete',
        !!hostMenu &&
          ['edit', 'duplicate', 'delete'].every((id) =>
            !!hostMenu.querySelector('[data-menu-id="' + id + '"]')),
        hostMenu ? [...hostMenu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id')).join(',') : 'no menu')

      if (hostMenu && hostMenu.querySelector('[data-menu-id="edit"]')) {
        hostMenu.querySelector('[data-menu-id="edit"]').click()
        await wait(800)
        const editor = document.querySelector('.td-drawer-form[data-testid="session-form"]')
        push('edit opens the session editor', editor,
          'form=' + !!editor +
            ' name=' + (editor ? (editor.querySelector('[aria-label="session-name"]') || {}).value : null))
        const close = editor
          ? [...editor.querySelectorAll('.td-drawer-actions button')]
              .find((b) => /cancel|close/i.test(b.textContent || ''))
          : null
        if (close) {
          close.click()
          await wait(500)
        }
        push('the editor can be dismissed', !document.querySelector('.td-drawer-form'))
      }

      // ---- connecting switches to Terminal ---------------------------------
      const connectBtn = document.querySelector('[data-host-row] [data-action="connect"]')
      push('a host row offers connect', !!connectBtn)
      if (connectBtn) {
        connectBtn.click()
        await wait(1500)
        const stillHosts = !!document.querySelector('[data-testid="hosts-page"]')
        push('connecting from hosts leaves the hosts page', !stillHosts,
          'hosts page still mounted=' + stillHosts)
        push('the terminal page is showing',
          !!document.querySelector('.td-dockview') &&
            !document.querySelector('.td-content.is-hidden'))
      }

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'hosts probe', ok: false, detail: String((err && err.message) || err) }])
  }

  report([
    {
      name: 'no naming flow falls back to the browser prompt',
      ok: (await win.webContents.executeJavaScript('window.__tdPromptCalls')) === 0,
      detail: 'prompt() calls=' + (await win.webContents.executeJavaScript('window.__tdPromptCalls'))
    }
  ])

  // ---- duplicate connection from the tab menu -----------------------------
  // Needs a real pane: the menu describes a *connection*, and the welcome pane has
  // none, so duplicating it would prove nothing.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    if (!document.querySelector('.td-sidebar')) {
      document.querySelector('[data-testid="rail-toggle"]').click()
      await wait(600)
    }
    const btn = document.querySelector('[data-testid="local-shell"]')
    if (btn) btn.click()
    for (let i = 0; i < 40; i++) {
      await wait(250)
      const e = Object.values(window.__tdTerminals || {})[0]
      if (e && e.term && e.term.rows > 24) break
    }
    return true
  })()`)

  const dup = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const panelsBefore = window.__tdDockApi.panels.length
    const tab = document.querySelector('.dv-tab')
    if (!tab) return [{ name: 'a pane exists to duplicate', ok: false, detail: 'no tab' }]
    const r = tab.getBoundingClientRect()
    tab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2)
    }))
    await wait(500)
    const out = []
    const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
    const menu = document.querySelector('[data-testid="tab-menu"]')
    const item = menu && menu.querySelector('[data-menu-id="duplicateConnection"]')
    push('the tab menu offers a duplicate connection', item,
      item ? JSON.stringify(item.textContent) : 'missing')
    if (!item) return out

    item.click()
    let grew = false
    for (let i = 0; i < 60; i++) {
      await wait(300)
      if (window.__tdDockApi.panels.length > panelsBefore) { grew = true; break }
    }
    push('duplicating opens another pane', grew,
      'panels ' + panelsBefore + ' -> ' + window.__tdDockApi.panels.length)
    push('the original pane is still there',
      window.__tdDockApi.panels.length >= panelsBefore + 1)
    return out
  })()`)
  report(dup)

  /*
   * ---- the view outlives a reload -----------------------------------------
   *
   * "Saved" has to mean the next launch too, and a reload rebuilds the page from
   * nothing, so only the layout file can bring the card view back. Done from here
   * rather than in the page script because a reload destroys the script's context.
   */
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="rail-hosts"]').click()
    await wait(600)
    document.querySelector('[data-testid="hosts-view-cards"]').click()
    await wait(600)
    return true
  })()`)
  win.webContents.reload()
  await sleep(2800)

  const afterReload = await win.webContents.executeJavaScript(`(() => ({
    cards: !!document.querySelector('.td-host-list.is-cards'),
    onHosts: !!document.querySelector('[data-testid="hosts-new-host"]')
  }))()`)
  report([
    {
      name: 'the card view comes back after a reload',
      ok: afterReload.onHosts && afterReload.cards === true,
      detail: JSON.stringify(afterReload)
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('hosts probe crashed:', err)
    app.exit(1)
  })
)
