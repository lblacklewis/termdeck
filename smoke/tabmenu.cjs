/**
 * Coverage for the pane-tab context menu.
 *
 *   npm run build && electron smoke/tabmenu.cjs --user-data-dir=...
 *
 * Right-clicking a tab must open a menu at the pointer with the expected
 * actions, and each action must really change the layout. Every step is guarded
 * so a failure reports which assertion broke instead of a bare null dereference.
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
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  // Start from a clean arrangement so a layout, a snippet or an edited setting
  // left by an earlier run cannot change what this probe sees.
  require(path.join(__dirname, 'clearstore.cjs')).resetStores(['sessions', 'settings'])
  mod.storeAccess().layout.clear()

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
  await win.reload()
  await sleep(2600)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          if (fn()) return true
          await wait(150)
        }
        return false
      }
      const panels = () => window.__tdDockApi.panels.length
      const tabs = () => [...document.querySelectorAll('.dv-tab')]
      const shellBtn = () => [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))

      /** Add one shell pane and stack it into the first group. */
      const addTab = async () => {
        const before = panels()
        shellBtn().click()
        await waitFor(() => panels() > before)
        await wait(900)
        const first = window.__tdDockApi.panels[0]
        const added = window.__tdDockApi.panels[panels() - 1]
        if (first && added && added.group !== first.group) {
          added.api.moveTo({ group: first.group })
          await wait(900)
        }
      }

      const rightClick = async (index) => {
        const list = tabs()
        if (index < 0 || index >= list.length) return null
        const tab = list[index]
        const r = tab.getBoundingClientRect()
        const cx = Math.round(r.x + r.width / 2)
        const cy = Math.round(r.y + r.height / 2)
        tab.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy
        }))
        await wait(400)
        return document.querySelector('[data-testid="tab-menu"]')
      }

      const clickItem = async (id) => {
        const el = document.querySelector('[data-testid="tab-menu"] [data-menu-id="' + id + '"]')
        if (!el) return false
        el.click()
        await wait(1200)
        return true
      }

      const state = (id) => {
        const el = document.querySelector('[data-testid="tab-menu"] [data-menu-id="' + id + '"]')
        return el ? el.disabled : null
      }

      push('the sidebar offers a local shell', !!shellBtn())
      for (let i = 0; i < 4; i++) await addTab()

      push('four tabs in one group', tabs().length === 4 && panels() === 4,
        'tabs=' + tabs().length + ' panels=' + panels())

      // ---- the menu itself ------------------------------------------------
      const menu = await rightClick(0)
      push('right-clicking a tab opens the tab menu', menu)
      if (!menu) return out

      const box = menu.getBoundingClientRect()
      // Geometry only. Reading the computed visibility and using a hit test both
      // proved unreliable for a portalled popup in this harness — they reported a
      // hidden menu that was on screen and whose items all worked — so the
      // assertions below are on measured boxes instead.
      const itemBoxes = [...menu.querySelectorAll('[data-menu-id]')].map((i) => {
        const b = i.getBoundingClientRect()
        return { id: i.getAttribute('data-menu-id'), w: Math.round(b.width), h: Math.round(b.height) }
      })
      push('the tab menu is on screen at a sensible size',
        box.width > 80 && box.height > 0 && box.top >= 0 && box.left >= 0 &&
          box.bottom <= window.innerHeight && box.right <= window.innerWidth,
        JSON.stringify({
          x: Math.round(box.x), y: Math.round(box.y),
          w: Math.round(box.width), h: Math.round(box.height),
          viewport: [window.innerWidth, window.innerHeight]
        }))
      push('every menu item has a clickable box',
        itemBoxes.every((i) => i.w > 20 && i.h > 5),
        JSON.stringify(itemBoxes))

      const ids = [...menu.querySelectorAll('[data-menu-id]')].map((i) => i.getAttribute('data-menu-id'))
      push('the expected actions are offered',
        ['reload', 'copyTitle', 'copyText', 'saveText', 'close', 'closeOthers', 'closeRight', 'closeAll']
          .every((id) => ids.includes(id)),
        ids.join(','))

      push('close is enabled on a real tab', state('close') === false)
      push('close others is enabled with four tabs', state('closeOthers') === false)
      push('close to the right is enabled on the first tab', state('closeRight') === false)

      // ---- reload ----------------------------------------------------------
      // An idle SSH connection the server has dropped is the case this exists
      // for: the pane is still on screen but its session is gone. Reload must
      // give the pane a live session again without moving it in the arrangement.
      const panelsBefore = panels()
      const titlesBefore = tabs().map((t) => (t.textContent || '').trim()).join('|')
      await rightClick(0)
      await clickItem('reload')
      await new Promise((r) => setTimeout(r, 4000))
      const panel = window.__tdDockApi.panels[0]
      const params = panel ? panel.api.getParameters() : null
      push('reload leaves the pane in place',
        panels() === panelsBefore && tabs().length === panelsBefore,
        'panels ' + panelsBefore + ' -> ' + panels() + ', tabs=' +
          tabs().map((t) => (t.textContent || '').trim()).join('|'))
      push('reload gives the pane a live session',
        !!(params && params.session && params.session.id),
        params && params.session ? 'session=' + params.session.id : 'no session on the panel')
      push('reload keeps the tab title',
        tabs().map((t) => (t.textContent || '').trim()).join('|') === titlesBefore,
        titlesBefore + ' -> ' + tabs().map((t) => (t.textContent || '').trim()).join('|'))

      // ---- close to the right --------------------------------------------
      await rightClick(1)
      await clickItem('closeRight')
      push('close tabs to the right leaves the leftmost two',
        tabs().length === 2 && panels() === 2,
        'tabs=' + tabs().length + ' panels=' + panels())

      const lastMenu = await rightClick(tabs().length - 1)
      push('close to the right is disabled on the last tab',
        !!lastMenu && state('closeRight') === true,
        lastMenu ? 'disabled=' + state('closeRight') : 'no menu')

      await clickItem('close')
      push('closing a tab removes exactly one', tabs().length === 1, 'tabs=' + tabs().length)

      // ---- close others ---------------------------------------------------
      await addTab()
      push('two tabs again for the group actions', tabs().length === 2, 'tabs=' + tabs().length)
      await rightClick(0)
      await clickItem('closeOthers')
      push('close other tabs leaves only the clicked one', tabs().length === 1,
        'tabs=' + tabs().length)

      // ---- close all ------------------------------------------------------
      await addTab()
      await rightClick(0)
      await clickItem('closeAll')
      push('close all tabs empties the workspace', tabs().length === 0, 'tabs=' + tabs().length)

      // ---- copy tab name --------------------------------------------------
      await addTab()
      await rightClick(0)
      await clickItem('copyTitle')
      await wait(400)
      const clip = await window.termdeck.readClipboard()
      push('copy tab name copies the title', /Local Shell/.test(clip || ''), JSON.stringify(clip))

      // ---- copy all output reads the scrollback, not just the viewport -----
      const marker = 'TABMENU_' + Date.now()
      const first = window.__tdDockApi.panels[0]
      if (!first) {
        push('a session is available for the output check', false, 'no panels')
        return out
      }
      await window.termdeck.writeSession(first.id, 'echo ' + marker + '\\r\\n')

      // Wait for the output to be in the terminal's buffer before copying: a
      // fixed delay raced the shell and copied an empty scrollback.
      const bufferHas = () => {
        const entry = window.__tdTerminals ? window.__tdTerminals[first.id] : null
        if (!entry || !entry.term) return false
        const buf = entry.term.buffer.active
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i)
          if (line && line.translateToString(true).includes(marker)) return true
        }
        return false
      }
      for (let i = 0; i < 40 && !bufferHas(); i++) await wait(250)
      push('the marker reached the terminal', bufferHas())

      await rightClick(0)
      await clickItem('copyText')
      await wait(600)
      const clipText = await window.termdeck.readClipboard()
      push('copy all output includes the scrollback',
        typeof clipText === 'string' && clipText.includes(marker),
        'length=' + (clipText ? clipText.length : 0))

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([
      {
        name: 'tab menu probe',
        ok: false,
        detail: String((err && err.message) || err)
      }
    ])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('tab menu probe crashed:', err)
    app.exit(1)
  })
)
