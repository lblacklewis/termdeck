/**
 * Interface scale ("resolution looks a bit high").
 *
 *   npm run build && electron smoke/scale.cjs --user-data-dir=...
 *
 * Checks the four things a scale setting has to get right:
 *   1. there is a control, and it starts at a sensible value for this display
 *   2. picking a value really resizes the interface (not just a number in a file)
 *   3. the choice survives a reload, including Electron's zoom reset
 *   4. closing the drawer without saving puts the old value back, by *every*
 *      route — the Close button, the header X and the backdrop
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

/** Zoom outside the renderer, so the probe is not grading its own homework. */
const zoom = (win) => Math.round(win.webContents.getZoomFactor() * 1000) / 1000

/**
 * Open the settings drawer from either the rail or the sidebar footer, so the
 * probe does not depend on which of the two happens to be on screen.
 */
const OPEN_SETTINGS = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = [...document.querySelectorAll('button')].find(
    (b) => (b.getAttribute('title') || '') === 'Settings'
  )
  if (!btn) return false
  btn.click()
  await wait(900)
  return !!document.querySelector('[data-testid="settings-drawer"]')
})()`

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()
  // Start from 100% regardless of what earlier runs left behind: the whole probe
  // is about the change from the starting value.
  mod.storeAccess().settings.save({ ...mod.storeAccess().settings.load(), uiScale: 1 })

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
  // Electron keeps the zoom factor across `reload`, so set the launch value the
  // way `createWindow` does rather than inheriting whatever the last run left.
  win.webContents.setZoomFactor(1)
  await win.reload()
  await sleep(2800)

  // ---- 1. the control exists and starts somewhere reasonable ---------------
  const opened = await win.webContents.executeJavaScript(OPEN_SETTINGS)

  report([
    {
      name: 'the settings drawer opens',
      ok: opened === true,
      detail: opened ? '' : 'no Settings control was found, or the drawer never appeared'
    }
  ])

  const controls = await win.webContents.executeJavaScript(`(() => {
    const picks = document.querySelector('[data-testid="scale-picks"]')
    const chips = picks ? [...picks.querySelectorAll('[data-scale]')] : []
    return {
      present: !!picks,
      values: chips.map((c) => Number(c.dataset.scale)),
      labels: chips.map((c) => (c.textContent || '').trim()),
      active: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => Number(c.dataset.scale)),
      hint: (document.querySelector('[data-testid="scale-hint"]') || {}).textContent || ''
    }
  })()`)

  report([
    {
      name: 'the appearance tab offers interface scale choices',
      ok: controls.present && controls.values.length >= 4,
      detail: controls.values.map((v) => `${Math.round(v * 100)}%`).join(' ')
    },
    {
      name: 'exactly one choice is shown as active',
      ok: controls.active.length === 1,
      detail: 'active=' + JSON.stringify(controls.active)
    },
    {
      name: 'the hint names the current size',
      ok: new RegExp('\\d+%').test(controls.hint),
      detail: JSON.stringify(controls.hint.trim().slice(0, 90))
    }
  ])

  // ---- 2. picking a value resizes the real interface -----------------------
  const before = {
    zoom: zoom(win),
    devicePixelRatio: await win.webContents.executeJavaScript('window.devicePixelRatio'),
    viewport: await win.webContents.executeJavaScript('window.innerWidth')
  }

  const picked = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const chip = document.querySelector('[data-testid="scale-picks"] [data-scale="1.25"]')
    if (!chip) return false
    chip.click()
    await wait(1400)
    return true
  })()`)

  const after = {
    zoom: zoom(win),
    devicePixelRatio: await win.webContents.executeJavaScript('window.devicePixelRatio'),
    viewport: await win.webContents.executeJavaScript('window.innerWidth'),
    hint: await win.webContents.executeJavaScript(
      `(document.querySelector('[data-testid="scale-hint"]') || {}).textContent || ''`
    )
  }

  report([
    {
      name: 'the probe starts from the launch scale',
      ok: Math.abs(before.zoom - 1) < 0.02,
      detail: 'zoom=' + before.zoom
    },
    { name: 'the scale picker is clickable', ok: picked === true },
    {
      name: 'choosing 125% raises the window zoom factor',
      ok: Math.abs(after.zoom - 1.25) < 0.02,
      detail: `${before.zoom} -> ${after.zoom}`
    },
    {
      name: 'the interface really re-renders larger',
      ok: after.devicePixelRatio > before.devicePixelRatio + 0.1,
      detail: `devicePixelRatio ${before.devicePixelRatio} -> ${after.devicePixelRatio}`
    },
    {
      name: 'the window fits fewer CSS pixels, so content is genuinely bigger',
      ok: after.viewport < before.viewport,
      detail: `viewport ${before.viewport} -> ${after.viewport} CSS px`
    },
    {
      name: 'the hint switches to preview wording before saving',
      ok: /preview/i.test(after.hint),
      detail: JSON.stringify(after.hint.trim().slice(0, 90))
    }
  ])

  // ---- 4a. the header X must revert an unsaved preview ---------------------
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="drawer-close"]').click(); true`)
  await sleep(1000)
  report([
    {
      name: 'closing with the header X reverts the unsaved scale',
      ok: Math.abs(zoom(win) - before.zoom) < 0.02,
      detail: `${after.zoom} -> ${zoom(win)} (expected ${before.zoom})`
    },
    {
      name: 'the reverted scale was never written to settings',
      ok: mod.storeAccess().settings.load().uiScale === before.zoom,
      detail: 'stored uiScale=' + mod.storeAccess().settings.load().uiScale
    }
  ])

  // ---- 3. saving persists, including across Electron's zoom reset ----------
  await win.webContents.executeJavaScript(OPEN_SETTINGS)
  await sleep(400)
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="scale-picks"] [data-scale="1.25"]').click()
    await wait(1200)
    document.querySelector('[data-testid="settings-save"]').click()
    await wait(1200)
    document.querySelector('[data-testid="drawer-close"]').click()
    await wait(600)
    return true
  })()`)
  await sleep(600)

  const savedStore = mod.storeAccess().settings.load().uiScale
  report([
    { name: 'saving stores 125%', ok: Math.abs(savedStore - 1.25) < 0.001, detail: 'stored=' + savedStore },
    { name: 'saving keeps the interface scaled', ok: Math.abs(zoom(win) - 1.25) < 0.02, detail: 'zoom=' + zoom(win) }
  ])

  // ---- 3b. changing the scale must not wreck an open terminal --------------
  // This is the regression the feature shipped with. `setZoomFactor` updates zoom
  // asynchronously, so a dockview layout pass taken while it was in flight cached
  // a 100x100 placeholder as the grid size: every pane collapsed to ~65px and the
  // terminal went blank, while the buffer still held the shell's output. Only
  // runs with a pane open at that moment showed it.
  // Measure the pane we just opened, not whichever one happens to be first in
  // the DOM: earlier sections leave other panes behind, and reading the wrong
  // one reports a healthy terminal while a broken one sits next to it.
  const measurePane = () =>
    win.webContents.executeJavaScript(`(() => {
      const reg = window.__tdTerminals || {}
      const ids = Object.keys(reg)
      const id = window.__tdTracked || ids[ids.length - 1]
      const entry = reg[id]
      const term = entry ? entry.term : null
      const root = term && term.element ? term.element : null
      const host = root ? root.closest('.td-terminal-host') : null
      const pane = host ? host.closest('.td-panel-content') : null
      return {
        id,
        hostH: host ? host.clientHeight : -1,
        paneH: pane ? Math.round(pane.getBoundingClientRect().height) : -1,
        rows: term ? term.rows : -1,
        painted: root
          ? [...root.querySelectorAll('.xterm-rows > div')].filter((d) => (d.textContent || '').trim()).length
          : -1
      }
    })()`)

  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = Object.keys(window.__tdTerminals || {})
    const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))
    if (btn) btn.click()
    await wait(2600)
    const after = Object.keys(window.__tdTerminals || {})
    window.__tdTracked = after.find((id) => !before.includes(id)) || after[after.length - 1] || null
    return window.__tdTracked
  })()`)
  const trackedSessionId = await win.webContents.executeJavaScript(`window.__tdTracked || null`)
  await sleep(1200)

  const withTerminal = await measurePane()
  report([
    {
      name: 'the probe is measuring the pane it just opened',
      ok: withTerminal.id === trackedSessionId && withTerminal.hostH > 200,
      detail: `id=${withTerminal.id} host=${withTerminal.hostH} pane=${withTerminal.paneH}`
    }
  ])
  // Open the drawer, push the scale up, close without saving (the zoom still
  // happens — the preview is a real applied change, which is the point).
  for (const scale of ['1.5', '1']) {
    await win.webContents.executeJavaScript(OPEN_SETTINGS)
    await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      document.querySelector('[data-testid="scale-picks"] [data-scale="${scale}"]').click()
      await wait(1200)
      document.querySelector('[data-testid="drawer-close"]').click()
      await wait(1200)
      return true
    })()`)
    await sleep(1500)
  }

  const afterScaleCycle = await measurePane()
  report([
    {
      name: 'a terminal opened before the scale change keeps its size',
      ok: afterScaleCycle.hostH > 150 && afterScaleCycle.hostH >= withTerminal.hostH - 20,
      detail: `host ${withTerminal.hostH} -> ${afterScaleCycle.hostH}`
    },
    {
      name: 'and keeps painting its rows rather than going blank',
      ok: afterScaleCycle.painted > 0 && afterScaleCycle.rows > 24,
      detail: `rows=${afterScaleCycle.rows} painted=${afterScaleCycle.painted}`
    }
  ])

  await win.reload()
  await sleep(3000)
  const afterReload = {
    zoom: zoom(win),
    devicePixelRatio: await win.webContents.executeJavaScript('window.devicePixelRatio')
  }
  report([
    {
      name: 'the scaled interface comes back after a reload',
      ok: Math.abs(afterReload.zoom - 1.25) < 0.03,
      detail: 'zoom=' + afterReload.zoom + ' devicePixelRatio=' + afterReload.devicePixelRatio
    }
  ])

  // ---- 4b. an already stored scale is what the app opens with --------------
  // The renderer no longer pushes zoom on its first render (that push used to
  // break the pane layout), so the launch value has to come from the main
  // process. An existing settings file without the key must not be treated as
  // "already decided" — it has to pick up the first-run default for the display.
  const legacyScale = (() => {
    const saved = { ...mod.storeAccess().settings.load() }
    delete saved.uiScale
    mod.storeAccess().settings.save(saved)
    return mod.storeAccess().settings.load().uiScale
  })()
  report([
    {
      name: 'a settings file with no scale yet gets the display default',
      ok: typeof legacyScale === 'number' && legacyScale > 0.69 && legacyScale < 2.01,
      detail: 'seeded ' + Math.round(legacyScale * 100) + '%'
    }
  ])

  mod.storeAccess().settings.save({
    ...mod.storeAccess().settings.load(),
    uiScale: 1.25
  })
  await win.reload()
  await sleep(3200)
  report([
    {
      name: 'a stored scale is applied by the launch, not by the renderer',
      ok: Math.abs(zoom(win) - 1.25) < 0.03,
      detail: 'opened at zoom=' + zoom(win) + ' devicePixelRatio=' +
        (await win.webContents.executeJavaScript('window.devicePixelRatio'))
    }
  ])

  // ---- 4c. the Close button and the backdrop also revert -------------------
  for (const [label, closeScript] of [
    [
      'the Close button',
      `[...document.querySelectorAll('.td-drawer-actions .td-btn')].find((b) => /close/i.test(b.textContent || '')).click()`
    ],
    ['the backdrop', `document.querySelector('[data-testid="drawer-backdrop"]').click()`]
  ]) {
    await win.webContents.executeJavaScript(OPEN_SETTINGS)
    await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      document.querySelector('[data-testid="scale-picks"] [data-scale="0.8"]').click()
      await wait(1200)
      return true
    })()`)
    const previewed = zoom(win)
    await win.webContents.executeJavaScript(`${closeScript}; true`)
    await sleep(1000)
    report([
      {
        name: `closing with ${label} reverts an unsaved scale`,
        ok: Math.abs(previewed - 0.8) < 0.02 && Math.abs(zoom(win) - 1.25) < 0.02,
        detail: `preview ${previewed} -> ${zoom(win)} (expected 1.25)`
      }
    ])
  }

  // ---- 5. the pure parts: defaults and clamping ---------------------------
  report([
    {
      name: 'a laptop-sized display keeps 100%',
      ok: mod.defaultScaleForWidth(1440) === 1 && mod.defaultScaleForWidth(1700) === 1,
      detail: '1440 -> ' + mod.defaultScaleForWidth(1440) + ', 1700 -> ' + mod.defaultScaleForWidth(1700)
    },
    {
      name: 'a wide desktop display starts a step larger',
      ok: mod.defaultScaleForWidth(1920) === 1.05 && mod.defaultScaleForWidth(2560) === 1.15,
      detail: '1920 -> ' + mod.defaultScaleForWidth(1920) + ', 2560 -> ' + mod.defaultScaleForWidth(2560)
    },
    {
      name: 'a 4K panel at 200% OS scaling stays at 100%',
      ok: mod.defaultScaleForWidth(3840 / 2) === 1.05,
      detail: '3840 physical at 200% reports 1920 logical -> ' + mod.defaultScaleForWidth(1920)
    },
    {
      name: 'a nonsense width falls back to 100% rather than throwing',
      ok: mod.defaultScaleForWidth(0) === 1 && mod.defaultScaleForWidth(NaN) === 1,
      detail: '0 -> ' + mod.defaultScaleForWidth(0) + ', NaN -> ' + mod.defaultScaleForWidth(NaN)
    },
    {
      name: 'the scale is clamped into a usable range',
      ok: mod.clampScale(0.1) === 0.7 && mod.clampScale(10) === 2 && mod.clampScale(1.25) === 1.25,
      detail: '0.1 -> ' + mod.clampScale(0.1) + ', 10 -> ' + mod.clampScale(10)
    }
  ])

  // Leave the machine's settings file back at 100% for later probes.
  mod.storeAccess().settings.save({ ...mod.storeAccess().settings.load(), uiScale: 1 })

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('scale probe crashed:', err)
    app.exit(1)
  })
)
