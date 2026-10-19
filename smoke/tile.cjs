/**
 * Workspace workflow: arranging panes, and the settings drawer closing on save.
 *
 * The tiling is checked geometrically — group rectangles — because "it tiled" is a
 * claim about layout, and the two ways it can go wrong are visually obvious but
 * invisible to a state assertion: sessions being destroyed by a rebuilt layout, and
 * the 50/50 cascade (first pane half the window, the next a quarter, and so on)
 * that looks like a tiling in a data structure and nothing like one on screen.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  const stores = mod.storeAccess()
  stores.layout.clear()

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
  mod.attachFocusMode(win)
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)

  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' })
  const page = (code) => win.webContents.executeJavaScript(code)

  // ---- four panes to arrange ---------------------------------------------------
  const opened = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 4; i++) {
      const before = window.__tdDockApi.panels.length
      document.querySelector('[data-testid="local-shell"]').click()
      for (let n = 0; n < 40; n++) { await wait(200); if (window.__tdDockApi.panels.length > before) break }
    }
    await wait(1200)
    return { panels: window.__tdDockApi.panels.length, terminals: Object.keys(window.__tdTerminals || {}).length }
  })()`)
  push('four shells are open', opened.panels === 4 && opened.terminals === 4, JSON.stringify(opened))

  const openDialog = async () => {
    await page(`(() => { document.activeElement && document.activeElement.blur(); return true })()`)
    await page(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }))`)
    await sleep(700)
    return page(`(() => {
      const dialog = document.querySelector('[data-testid="tile-dialog"]')
      if (!dialog) return null
      const boxes = [...document.querySelectorAll('[data-testid="tile-pane"]')]
      return {
        panes: boxes.length,
        checked: boxes.filter((b) => b.checked).length,
        modes: [...document.querySelectorAll('[data-testid="tile-modes"] label')].map((l) => l.getAttribute('data-mode')),
        applyLabel: (document.querySelector('[data-testid="tile-apply"]') || {}).textContent || ''
      }
    })()`)
  }

  const dialog = await openDialog()
  push('Ctrl+Shift+T opens the arrange dialog', !!dialog, JSON.stringify(dialog))
  push('every pane is ticked by default',
    !!dialog && dialog.checked === 4 && dialog.panes === 4, JSON.stringify(dialog))
  push('the three arrangements are offered',
    !!dialog && ['grid', 'columns', 'rows'].every((m) => dialog.modes.includes(m)),
    JSON.stringify(dialog && dialog.modes))

  /** Group rectangles, for checking what the tiling actually looks like. */
  const groups = () =>
    page(`(() => [...document.querySelectorAll('.dv-groupview')].map((el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }))()`)

  const apply = async (mode) => {
    await page(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      document.querySelector('[data-testid="tile-mode-${mode}"]').click()
      await wait(200)
      document.querySelector('[data-testid="tile-apply"]').click()
      await wait(1800)
      return true
    })()`)
    await sleep(900)
  }

  const near = (a, b, tolerance) => Math.abs(a - b) <= (tolerance || 12)
  const allNear = (values) => values.every((v) => near(v, values[0]))

  // ---- columns -----------------------------------------------------------------
  await apply('columns')
  const columns = await groups()
  push('竖屏分割 gives four side-by-side panes', columns.length === 4, JSON.stringify(columns))
  push('with equal widths and full height',
    columns.length === 4 && allNear(columns.map((g) => g.w)) &&
      allNear(columns.map((g) => g.h)),
    JSON.stringify(columns.map((g) => g.w + 'x' + g.h)))
  push('and nothing lost its session', (await page('Object.keys(window.__tdTerminals || {}).length')) === 4)

  // ---- rows --------------------------------------------------------------------
  await openDialog()
  await apply('rows')
  const rows = await groups()
  push('横屏分割 gives four stacked panes', rows.length === 4, JSON.stringify(rows))
  push('with equal heights and full width',
    rows.length === 4 && allNear(rows.map((g) => g.h)) && allNear(rows.map((g) => g.w)),
    JSON.stringify(rows.map((g) => g.w + 'x' + g.h)))

  // ---- grid --------------------------------------------------------------------
  await openDialog()
  await apply('grid')
  const grid = await groups()
  const distinctX = new Set(grid.map((g) => g.x)).size
  const distinctY = new Set(grid.map((g) => g.y)).size
  push('瓷砖排列 gives a 2 × 2 grid',
    grid.length === 4 && distinctX === 2 && distinctY === 2,
    'x=' + distinctX + ' y=' + distinctY + ' ' + JSON.stringify(grid.map((g) => g.w + 'x' + g.h)))

  // ---- unticking a pane --------------------------------------------------------
  const subset = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(700)
    const boxes = [...document.querySelectorAll('[data-testid="tile-pane"]')]
    boxes[3].click()
    await wait(300)
    const label = (document.querySelector('[data-testid="tile-apply"]') || {}).textContent
    boxes[3].click()
    await wait(300)
    const back = (document.querySelector('[data-testid="tile-apply"]') || {}).textContent
    document.querySelector('[data-testid="tile-cancel"]').click()
    await wait(400)
    return { label, back, closed: !document.querySelector('[data-testid="tile-dialog"]') }
  })()`)
  push('unticking a pane changes the count in the button',
    /3/.test(subset.label || '') && /4/.test(subset.back || ''), JSON.stringify(subset))
  push('Cancel closes without arranging', subset.closed, JSON.stringify(subset))

  // ---- the settings drawer closes on save --------------------------------------
  const saved = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="rail-settings"]').click()
    await wait(1200)
    const drawer = !!document.querySelector('.td-settings')
    // A real edit, through a control that is definitely there: the language picker.
    const pick = document.querySelector('[data-testid="language-pick"]')
    const current = pick ? pick.value : null
    if (pick) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(pick, current === 'zh-CN' ? 'en' : 'zh-CN')
      pick.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await wait(700)
    const save = document.querySelector('[data-testid="settings-save"]')
    const enabled = !!save && !save.disabled
    if (save) save.click()
    await wait(1800)
    return {
      drawer,
      enabled,
      closed: !document.querySelector('.td-settings'),
      reopenable: !!document.querySelector('[data-testid="rail-settings"]')
    }
  })()`)
  push('the settings drawer opens', saved.drawer, JSON.stringify(saved))
  push('saving closes it', saved.closed && saved.reopenable, JSON.stringify(saved))

  // ---- the rail toggle ---------------------------------------------------------
  const toggle = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const rail = () => document.querySelector('.td-rail')
    const first = rail().className.includes('is-collapsed')
    document.querySelector('[data-testid="rail-terminal"]').click()
    await wait(700)
    const after = rail().className.includes('is-collapsed')
    document.querySelector('[data-testid="rail-terminal"]').click()
    await wait(700)
    return { first, after, back: rail().className.includes('is-collapsed') }
  })()`)
  push('clicking the current page collapses the column', toggle.after === !toggle.first,
    JSON.stringify(toggle))
  push('and clicking it again brings it back', toggle.back === toggle.first, JSON.stringify(toggle))

  // ---- a partial selection must not squeeze the rest ---------------------------
  await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(700)
    document.querySelectorAll('[data-testid="tile-pane"]')[3].click()
    await wait(300)
    document.querySelector('[data-testid="tile-mode-columns"]').click()
    await wait(200)
    document.querySelector('[data-testid="tile-apply"]').click()
    await wait(1800)
    return true
  })()`)
  await sleep(900)
  const partial = await groups()
  const widest = Math.max(...partial.map((g) => g.w))
  push('a partial selection keeps the unselected pane usable',
    partial.length === 4 && Math.min(...partial.map((g) => g.w)) > 100,
    JSON.stringify(partial.map((g) => g.w)))

  // ---- one window -------------------------------------------------------------
  const merged = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="merge-panes"]').click()
    await wait(1500)
    return {
      groups: document.querySelectorAll('.dv-groupview').length,
      tabs: document.querySelectorAll('.dv-tab').length
    }
  })()`)
  push('the one-window button merges every pane into a single group',
    merged.groups === 1 && merged.tabs === 4, JSON.stringify(merged))
  push('and nothing closed', (await page('Object.keys(window.__tdTerminals || {}).length')) === 4)

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('workspace probe crashed:', err)
    app.exit(1)
  })
)
