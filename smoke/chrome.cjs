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
  // Wipe the profile before anything constructs a store. The stores cache
  // their contents in memory, so deleting their files afterwards leaves the
  // previous run's data in place and the next write puts it back on disk.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
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
  const consoleErrors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)

  await win.reload()
  await sleep(2600)

  // Open a fitted shell first: a collapsed pane leaves the "give width back"
  // comparison nothing real to compare. `openFittedShell` retries a fresh boot,
  // because the stuck state does not clear on its own (see smoke/panestep.cjs).
  const fitted = await require(path.join(__dirname, 'panestep.cjs')).openFittedShell(win)
  report([
    {
      name: 'a fitted shell pane is open',
      ok: fitted,
      detail: fitted
        ? 'rows > 24'
        : 'the first terminal never grew past 24 rows; ' +
          (await win.webContents.executeJavaScript(
            `JSON.stringify({ grid: (() => { const g = document.querySelector('.dv-grid-view'); ` +
              `return g ? g.clientWidth + 'x' + g.clientHeight : null })(), ` +
              `dock: (() => { const d = document.querySelector('.td-dockview'); ` +
              `return d ? d.clientWidth + 'x' + d.clientHeight : null })() })`
          ))
    }
  ])

  // Give the shell something to timestamp: the gutter can only be judged against
  // real output, and the stamps only exist for lines the terminal has received.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
    if (e && e.term) e.term.write('echo stamp-check-one\\r\\necho stamp-check-two\\r\\n')
    await wait(1500)
    return true
  })()`)
  await sleep(800)

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

      // ---- 1. the rail and its drawer are one column ----------------------
      const expandedSidebar = w('.td-sidebar')
      const expandedRail = w('.td-rail')
      const colsBefore = term() ? term().cols : null

      const toggle = document.querySelector('[data-testid="rail-toggle"]')
      push('the rail offers a shrink control', toggle)
      if (!toggle) return out
      push('the drawer sits beside the rail, sharing its background',
        expandedSidebar !== null && expandedRail !== null,
        'rail=' + expandedRail + 'px drawer=' + expandedSidebar + 'px')
      push('the seam between them is not a border on both sides',
        getComputedStyle(document.querySelector('.td-rail')).borderRightStyle === 'none',
        'rail border-right=' + getComputedStyle(document.querySelector('.td-rail')).borderRightStyle)

      toggle.click()
      await wait(2000)

      push('the drawer goes away entirely, leaving icons only',
        !document.querySelector('.td-sidebar') &&
          document.querySelector('.td-rail').classList.contains('is-collapsed'),
        'drawer=' + w('.td-sidebar') + 'px rail=' + w('.td-rail') + 'px')
      push('the icons stay reachable while collapsed',
        !!document.querySelector('[data-testid="rail-terminal"]') &&
          !!document.querySelector('[data-testid="rail-snippets"]'))

      const colsAfter = term() ? term().cols : null
      push('shrinking gives width back to the terminal',
        colsAfter !== null && colsBefore !== null && colsAfter > colsBefore,
        'cols ' + colsBefore + ' -> ' + colsAfter)

      // Clicking the section you are already on toggles the drawer back.
      document.querySelector('[data-testid="rail-terminal"]').click()
      await wait(1200)
      push('clicking the active icon brings the drawer back',
        !!document.querySelector('.td-sidebar') &&
          !document.querySelector('.td-rail').classList.contains('is-collapsed'))

      // ---- 2. the gutter is off by default, and blends when shown ----------
      /*
       * Timestamps are off by default now: in a split they cost horizontal room in
       * every pane at once. So this enables them explicitly and then asserts the
       * toggle takes them away again — which is also the honest test of the
       * right-click control.
       */
      push('timestamps default to off',
        (await api.loadSettings()).terminal.showTimestamps === false &&
          !document.querySelector('[data-testid="timestamp-gutter"]'),
        'gutter=' + !!document.querySelector('[data-testid="timestamp-gutter"]'))

      let s = await api.loadSettings()
      await api.saveSettings({ ...s, terminal: { ...s.terminal, showTimestamps: true } })
      await wait(1400)

      const gutter = document.querySelector('[data-testid="timestamp-gutter"]')
      push('turning them on shows the gutter', gutter)
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

        /*
         * The stamps must actually be there and must not be clipped. They were
         * both blank (the sync ran before xterm had parsed the write) and cut
         * short (the column was narrower than a full HH:MM:SS stamp), and neither
         * showed up as anything but "the gutter exists".
         *
         * The measuring cell carries its own class, so a plain stamp query already
         * returns only rendered rows.
         */
        const rows = [...gutter.querySelectorAll('.td-terminal-stamp')]
        const filled = rows.filter((el) => (el.textContent || '').trim().length > 0)
        push('the gutter shows a timestamp on written lines', filled.length > 0,
          filled.length + ' of ' + rows.length + ' rows filled, first=' +
            JSON.stringify((filled[0] || {}).textContent || null))
        const filledTexts = filled.map((el) => (el.textContent || '').trim())
        /*
         * Character checks rather than a regular expression.
         *
         * This code lives inside a template literal that the main process
         * evaluates before sending it to the renderer, and a backslash escape
         * there does not survive reliably — a pattern written with escapes
         * arrived as a plain character class and silently matched nothing, which
         * looked exactly like the product bug it was meant to catch.
         */
        const isStamp = (t) =>
          t.length === 10 &&
          t[0] === '[' &&
          t[9] === ']' &&
          t[3] === ':' &&
          t[6] === ':' &&
          [1, 2, 4, 5, 7, 8].every((i) => t[i] >= '0' && t[i] <= '9')
        const odd = filledTexts.filter((t) => !isStamp(t))
        push('every stamp is a full bracketed time',
          filled.length > 0 && odd.length === 0,
          'filled=' + filled.length + ' odd=' + odd.length +
            ' values=' + JSON.stringify(filledTexts.slice(0, 3)))
        push('the stamps are not clipped by the column',
          filled.length > 0 && filled.every((el) => el.scrollWidth <= el.clientWidth + 1),
          filled.length ? filled[0].scrollWidth + 'px of ' + filled[0].clientWidth + 'px' : 'none')
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

      // And back on, through the same menu, so the control is proven both ways.
      await api.saveSettings({
        ...afterHide,
        terminal: { ...afterHide.terminal, showTimestamps: true }
      })
      await wait(1200)
      const tabAgain = document.querySelector('.dv-tab')
      const rAgain = tabAgain.getBoundingClientRect()
      tabAgain.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
        clientX: Math.round(rAgain.x + rAgain.width / 2),
        clientY: Math.round(rAgain.y + rAgain.height / 2)
      }))
      await wait(500)
      const backItem = document.querySelector(
        '[data-testid="tab-menu"] [data-menu-id="toggleTimestamps"]'
      )
      push('re-opening offers to hide them again',
        !!backItem && /hide/i.test(backItem.textContent || ''),
        backItem ? JSON.stringify(backItem.textContent) : 'missing')
      if (backItem) {
        backItem.click()
        await wait(1500)
        push('choosing it removes the gutter again',
          !document.querySelector('[data-testid="timestamp-gutter"]') &&
            (await api.loadSettings()).terminal.showTimestamps === false)
      }

      // ---- the collapsed state survives a reload --------------------------
      // Collapse once more here: the earlier toggle was undone on purpose, and
      // this is the state that has to come back.
      document.querySelector('[data-testid="rail-toggle"]').click()
      await wait(1200)
      push('the rail is collapsed again', !document.querySelector('.td-sidebar'))
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
      const rail = document.querySelector('.td-rail')
      const collapsed = !!rail && rail.classList.contains('is-collapsed')
      return [{
        name: 'the collapsed rail is restored after a reload',
        ok: collapsed && !document.querySelector('.td-sidebar'),
        detail: collapsed ? 'drawer hidden, icons only' : 'rail came back expanded'
      }]
    })()`)
  )

  const failed = all.filter((c) => !c.ok)
  if (consoleErrors.length > 0) {
    console.log('\nrenderer errors:\n  ' + consoleErrors.slice(0, 10).join('\n  '))
  }
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('chrome probe crashed:', err)
    app.exit(1)
  })
)
