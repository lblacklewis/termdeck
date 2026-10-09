/**
 * Repeatability check for the pane sizing.
 *
 *   npm run build && electron smoke/repeatchk.cjs [runs]
 *
 * A fix that passes "sometimes" is not a fix. Each run starts from a cleared
 * layout, opens a shell quickly (the timing that reproduced the bug), and the run
 * counts only if the pane reaches a real size and the terminal refits.
 *
 * Odd runs additionally change the interface scale with the pane already open.
 * `setZoomFactor` updates zoom asynchronously, so a layout pass taken while that
 * is in flight used to record a 100x100 placeholder as the size of dockview's
 * grid, collapsing every pane to about 65px with an empty terminal. Alternating
 * the two paths keeps both honest.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const RUNS = Number(process.argv[2] || 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()

  const results = []

  for (let run = 1; run <= RUNS; run++) {
    mod.storeAccess().layout.clear()
    mod.storeAccess().settings.save({ ...mod.storeAccess().settings.load(), uiScale: 1 })
    const rescaleMidway = run % 2 === 1

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
      await wait(1200)
      return true
    })()`)

    if (rescaleMidway) {
      await sleep(1200)
      // Through the real control, not the bridge directly.
      await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const open = [...document.querySelectorAll('button')]
          .find((b) => (b.getAttribute('title') || '') === 'Settings')
        open.click()
        await wait(900)
        document.querySelector('[data-testid="scale-picks"] [data-scale="1.25"]').click()
        await wait(600)
        document.querySelector('[data-testid="drawer-close"]').click()
        return true
      })()`)
    }

    let ok = false
    let detail = ''
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const s = await win.webContents.executeJavaScript(`(() => {
        const h = document.querySelector('.td-terminal-host')
        const pane = document.querySelector('.td-terminal')
        const grid = document.querySelector('.dv-grid-view')
        const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
        const t = e ? e.term : null
        const painted = t && t.element
          ? [...t.element.querySelectorAll('.xterm-rows > div')].filter((d) => (d.textContent || '').trim()).length
          : -1
        return {
          hostH: h ? h.clientHeight : -1,
          paneH: pane ? Math.round(pane.getBoundingClientRect().height) : -1,
          gridH: grid ? Math.round(grid.getBoundingClientRect().height) : -1,
          rows: t ? t.rows : -1,
          painted
        }
      })()`)
      detail =
        `host=${s.hostH} pane=${s.paneH} grid=${s.gridH} rows=${s.rows} painted=${s.painted}`
      // The pane must both be tall enough and have its rows actually painted: a
      // buffer with no DOM rows is what a collapsed pane looks like.
      if (s.hostH > 200 && s.rows > 24 && s.painted > 0) {
        ok = true
        break
      }
    }

    results.push({ run, ok, detail })
    console.log(`run ${run}: ${ok ? 'OK  ' : 'STUCK'}  ${rescaleMidway ? 'scale changed mid-run  ' : 'plain launch        '}${detail}`)
    if (!ok) {
      const dockTrail = await win.webContents.executeJavaScript(
        `JSON.stringify((window.__tdDockTrail || []).slice(-4))`
      )
      const fitTrail = await win.webContents.executeJavaScript(
        `JSON.stringify((window.__tdFitTrail || []).slice(-4))`
      )
      console.log('    dock: ' + dockTrail)
      console.log('    fit:  ' + fitTrail)
    }
    win.hide()
    await sleep(400)
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${RUNS} runs sized correctly`)
  app.exit(passed === RUNS ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('repeatchk crashed:', err)
    app.exit(1)
  })
)
