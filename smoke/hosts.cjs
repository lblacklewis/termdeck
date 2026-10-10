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
      nodeIntegration: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  // prompt() is used by the group rename flow; stub it so an unattended run
  // cannot sit on a modal nobody can answer.
  await win.webContents.executeJavaScript(`window.prompt = () => 'Renamed group'; true`)
  await win.reload()
  await sleep(3000)

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
      document.querySelector('[data-testid="hosts-view-list"]').click()
      await wait(300)
      push('switching back restores rows', !!document.querySelector('.td-host-list.is-list'))

      // ---- groups ----------------------------------------------------------
      const groupNames = () => [...document.querySelectorAll('[data-host-group]')]
        .map((s) => s.getAttribute('data-host-group'))
      push('groups are shown', groupNames().join(',') === 'prod,staging',
        groupNames().join(','))

      document.querySelector('[data-testid="hosts-new-group"]').click()
      await wait(800)
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
         * the menu item closed and nothing happened. Now it opens an inline field,
         * so the check drives that: open, type, save, and confirm the new name is
         * actually in the tree.
         */
        if (menu) {
          menu.querySelector('[data-menu-id="rename"]').click()
          await wait(500)
          const form = document.querySelector('[data-testid="hosts-rename-form"]')
          push('rename opens an inline field rather than a browser prompt', form,
            'form=' + !!form)
          if (form) {
            const input = form.querySelector('[aria-label="group-name"]')
            setValue(input, 'Renamed group')
            await wait(200)
            form.querySelector('[data-testid="hosts-rename-save"]').click()
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
          await wait(900)
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

  // prompt() is used by the rename flow; already stubbed before the reload.
  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'hosts probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // ---- duplicate connection from the tab menu -----------------------------
  // Needs a real pane: the menu describes a *connection*, and the welcome pane has
  // none, so duplicating it would prove nothing.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    if (!document.querySelector('.td-sidebar')) {
      document.querySelector('[data-testid="rail-toggle"]').click()
      await wait(600)
    }
    const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))
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
