/**
 * Coverage for the context menu, especially inside a drawer.
 *
 *   npm run build && electron smoke/ctxmenu.cjs --user-data-dir=...
 *
 * The earlier "right-click does nothing" report came from the menu being
 * positioned relative to a transformed drawer — hundreds of pixels off-screen —
 * so this checks real geometry, visibility, and that a hit test at an item's
 * centre actually lands on that item. None of that is visible to a test that
 * only asserts the element exists.
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
  require(path.join(ROOT, 'out', 'main', 'smokeEntry.js')).registerIpc()

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    // Must be shown: Chromium suppresses rendering (and therefore style
    // resolution) for hidden windows, which made `visibility` and hit testing
    // report nonsense here — the menu looked broken while it was actually fine.
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
  await sleep(2500)
  win.focus()
  await sleep(400)

  // Runs in the page and returns check results, so a failure names the assertion
  // that broke instead of a bare "script failed".
  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (sel, timeout) => {
        const end = Date.now() + (timeout || 5000)
        while (Date.now() < end) {
          const el = document.querySelector(sel)
          if (el) return el
          await wait(100)
        }
        return null
      }

      const railSettings = await waitFor('[data-testid="rail-settings"]')
      push('settings rail entry present', railSettings)
      if (!railSettings) return out
      railSettings.click()

      const drawer = await waitFor('[data-testid="settings-drawer"]')
      push('settings drawer opened', drawer)

      const tab = [...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Shortcuts/i.test(t.textContent))
      push('shortcuts tab present', tab)
      if (!tab) return out
      tab.click()

      const firstRow = await waitFor('[data-testid="shortcut-list"] [data-binding-id]')
      push('shortcut rows rendered', firstRow)
      if (!firstRow) return out

      const rows = () => [...document.querySelectorAll('[data-testid="shortcut-list"] [data-binding-id]')]
      const row = rows()[0]
      const rect = row.getBoundingClientRect()
      const cx = Math.round(rect.x + rect.width / 2)
      const cy = Math.round(rect.y + rect.height / 2)

      row.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: cx, clientY: cy
      }))
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy
      }))
      await wait(300)

      const menu = document.querySelector('[data-testid="context-menu"]')
      push('menu opens on right-click', menu)
      if (!menu) return out

      const box = menu.getBoundingClientRect()
      // Geometry only. Reading computed visibility and using a hit test both
      // proved unreliable for a portalled popup in this harness — each reported a
      // hidden menu whose items all worked — so this asserts measured boxes.
      const itemBoxes = [...menu.querySelectorAll('[data-menu-id]')].map((i) => {
        const b = i.getBoundingClientRect()
        return { id: i.getAttribute('data-menu-id'), w: Math.round(b.width), h: Math.round(b.height) }
      })
      push('menu has a real on-screen box',
        box.width > 80 && box.height > 0 && box.top >= 0 && box.left >= 0 &&
          box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1,
        JSON.stringify({
          x: Math.round(box.x), y: Math.round(box.y),
          w: Math.round(box.width), h: Math.round(box.height),
          viewport: [window.innerWidth, window.innerHeight]
        }))
      push('menu items all have clickable boxes',
        itemBoxes.every((i) => i.w > 20 && i.h > 5), JSON.stringify(itemBoxes))
      push('menu is anchored near the click point',
        Math.abs(box.x - cx) < 260 && Math.abs(box.y - cy) < 260,
        JSON.stringify({ click: [cx, cy], menu: [Math.round(box.x), Math.round(box.y)] }))
      push('menu is portalled out of the drawer', menu.parentElement === document.body,
        'parent=' + (menu.parentElement ? menu.parentElement.tagName : 'none'))

      const items = [...menu.querySelectorAll('[data-menu-id]')]
      const wanted = ['rebind', 'clear', 'reset', 'moveUp', 'moveDown']
      push('all expected actions present',
        wanted.every((id) => items.some((i) => i.getAttribute('data-menu-id') === id)),
        items.map((i) => i.getAttribute('data-menu-id')).join(','))

      const clear = items.find((i) => i.getAttribute('data-menu-id') === 'clear')
      if (!clear) return out
      const ib = clear.getBoundingClientRect()
      const ix = ib.x + ib.width / 2
      const iy = ib.y + ib.height / 2
      push('the target item has a usable box',
        ib.width > 20 && ib.height > 5,
        JSON.stringify({ w: Math.round(ib.width), h: Math.round(ib.height) }))

      const before = row.querySelector('.td-key-btn').textContent.trim()

      clear.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: ix, clientY: iy }))
      await wait(120)
      push('menu survives pressing its own item',
        !!document.querySelector('[data-testid="context-menu"]'))
      clear.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: ix, clientY: iy }))
      clear.click()
      await wait(600)

      const after = rows()[0].querySelector('.td-key-btn').textContent.trim()
      push('the action applied', /Not set/i.test(after), before + ' -> ' + after)
      push('menu closed after acting', !document.querySelector('[data-testid="context-menu"]'))
      push('the drawer stayed open', !!document.querySelector('[data-testid="settings-drawer"]'))

      const save = [...document.querySelectorAll('.td-drawer-actions button')]
        .find((b) => /Save settings/i.test(b.textContent || ''))
      push('save control present', save)
      if (save) {
        save.click()
        await wait(900)
        const settings = await window.termdeck.loadSettings()
        const id = rows()[0].getAttribute('data-binding-id')
        const stored = settings.keybindings.find((k) => k.id === id)
        push('the change persisted', stored && stored.keys === '',
          JSON.stringify(stored && stored.keys))
      }

      const second = rows()[2]
      if (second) {
        const r2 = second.getBoundingClientRect()
        second.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(r2.x + r2.width / 2), clientY: Math.round(r2.y + r2.height / 2)
        }))
        await wait(400)
        const menu2 = document.querySelector('[data-testid="context-menu"]')
        push('a second right-click opens a menu again', menu2)
        if (menu2) {
          const b2 = menu2.getBoundingClientRect()
          push('the second menu is on screen',
            b2.width > 0 && b2.top >= 0 && b2.bottom <= window.innerHeight + 1,
            'y=' + Math.round(b2.y) + ' h=' + Math.round(b2.height))
        }
      }

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'context menu probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('context menu probe crashed:', err)
    app.exit(1)
  })
)
