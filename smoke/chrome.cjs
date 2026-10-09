/**
 * Coverage for the shell refinements:
 *   1. the sidebar collapses to a slim strip and gives the width back
 *   2. the timestamp gutter is blended, not a boxed sidebar
 *   3. right-clicking a pane offers show/hide timestamps, and it persists
 *
 *   npm run build && electron smoke/chrome.cjs --user-data-dir=...
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
  // Timestamps are asserted to start *on*, and the sidebar to start expanded, so
  // a settings file left by another run has to go.
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

  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))
    if (btn) btn.click()
    await wait(3000)
    return true
  })()`)
  await sleep(3000)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const w = (sel) => {
        const el = document.querySelector(sel)
        return el ? Math.round(el.getBoundingClientRect().width) : null
      }
      const term = () => {
        const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
        return e && e.term ? e.term : null
      }

      // ---- 1. collapse the sidebar ----------------------------------------
      const expandedSidebar = w('.td-sidebar')
      const colsBefore = term() ? term().cols : null

      const collapse = document.querySelector('[data-testid="sidebar-collapse"]')
      push('the sidebar offers a collapse control', collapse)
      if (!collapse) return out
      collapse.click()
      await wait(2000)

      const strip = document.querySelector('[data-testid="sidebar-collapsed"]')
      push('collapsing shows the slim strip', strip)
      push('the strip is narrow', !!strip && w('.td-sidebar') <= 56,
        'strip=' + w('.td-sidebar') + 'px (was ' + expandedSidebar + 'px)')

      const colsAfter = term() ? term().cols : null
      push('collapsing gives width back to the terminal',
        colsAfter !== null && colsBefore !== null && colsAfter > colsBefore,
        'cols ' + colsBefore + ' -> ' + colsAfter)

      push('the strip keeps the primary actions one click away',
        !!document.querySelector('[data-testid="collapsed-connect"]') &&
          !!document.querySelector('[data-testid="collapsed-local"]'))

      // ---- 2. gutter is blended, not boxed --------------------------------
      const gutter = document.querySelector('[data-testid="timestamp-gutter"]')
      push('the timestamp gutter is present', gutter)
      if (gutter) {
        const cs = getComputedStyle(gutter)
        const paneCs = getComputedStyle(document.querySelector('.td-terminal'))
        push('the gutter has no separating border',
          cs.borderRightStyle === 'none' || cs.borderRightWidth === '0px',
          'border-right=' + cs.borderRightStyle + ' ' + cs.borderRightWidth)
        push('the gutter has no panel background of its own',
          cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent',
          'background=' + cs.backgroundColor)
        push('the gutter shares the terminal background',
          cs.backgroundColor === 'rgba(0, 0, 0, 0)' ||
            paneCs.backgroundColor !== 'rgba(0, 0, 0, 0)',
          'pane=' + paneCs.backgroundColor + ' gutter=' + cs.backgroundColor)
        push('the gutter is dimmed so it recedes',
          Number(cs.opacity) < 1 || cs.color !== getComputedStyle(document.querySelector('.xterm')).color,
          'opacity=' + cs.opacity + ' color=' + cs.color)
      }

      // ---- 3. right-click toggles timestamps ------------------------------
      const tab = document.querySelector('.dv-tab')
      const r = tab.getBoundingClientRect()
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2)
      }))
      await wait(500)
      const menu = document.querySelector('[data-testid="tab-menu"]')
      push('the pane menu opens', menu)
      const item = menu && menu.querySelector('[data-menu-id="toggleTimestamps"]')
      push('the menu offers a timestamp toggle', item,
        item ? JSON.stringify(item.textContent) : 'missing')
      if (!item) return out

      push('it reads as an action to hide, since timestamps are on',
        /hide/i.test(item.textContent || ''), JSON.stringify(item.textContent))

      item.click()
      await wait(1600)
      const afterHide = await api.loadSettings()
      push('choosing it turns timestamps off',
        afterHide.terminal.showTimestamps === false,
        'showTimestamps=' + afterHide.terminal.showTimestamps)
      push('the gutter disappears from the pane',
        !document.querySelector('[data-testid="timestamp-gutter"]'))

      // Re-open and turn them back on, confirming it is a real toggle.
      const tab2 = document.querySelector('.dv-tab')
      const r2 = tab2.getBoundingClientRect()
      tab2.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(r2.x + r2.width / 2), clientY: Math.round(r2.y + r2.height / 2)
      }))
      await wait(500)
      const menu2 = document.querySelector('[data-testid="tab-menu"] [data-menu-id="toggleTimestamps"]')
      push('re-opening offers to show them again',
        !!menu2 && /show/i.test(menu2.textContent || ''), menu2 ? JSON.stringify(menu2.textContent) : 'missing')
      if (menu2) {
        menu2.click()
        await wait(1600)
        push('choosing it turns timestamps back on',
          (await api.loadSettings()).terminal.showTimestamps === true)
        push('the gutter returns', !!document.querySelector('[data-testid="timestamp-gutter"]'))
      }

      // ---- the collapsed state survives a reload --------------------------
      push('the sidebar is still collapsed', !!document.querySelector('[data-testid="sidebar-collapsed"]'))
      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'chrome probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // Reload: the collapsed choice must have been persisted.
  await win.reload()
  await sleep(3000)
  report(
    await win.webContents.executeJavaScript(`(() => {
      const strip = document.querySelector('[data-testid="sidebar-collapsed"]')
      return [{
        name: 'the collapsed sidebar is restored after a reload',
        ok: !!strip,
        detail: strip ? 'slim strip present' : 'sidebar came back expanded'
      }]
    })()`)
  )

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('chrome probe crashed:', err)
    app.exit(1)
  })
)
