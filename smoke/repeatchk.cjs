/**
 * Repeatability check for the pane sizing.
 *
 *   npm run build && electron smoke/repeatchk.cjs [runs]
 *
 * A fix that passes "sometimes" is not a fix. Each run starts from a cleared
 * layout, opens a shell quickly (the timing that reproduced the bug), and the run
 * counts only if the pane reaches a real size and the terminal refits.
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

    let ok = false
    let detail = ''
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      const s = await win.webContents.executeJavaScript(`(() => {
        const h = document.querySelector('.td-terminal-host')
        const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
        const t = e ? e.term : null
        return { hostH: h ? h.clientHeight : -1, rows: t ? t.rows : -1 }
      })()`)
      detail = `host=${s.hostH} rows=${s.rows}`
      if (s.hostH > 200 && s.rows > 24) {
        ok = true
        break
      }
    }

    results.push({ run, ok, detail })
    console.log(`run ${run}: ${ok ? 'OK  ' : 'STUCK'}  ${detail}`)
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
