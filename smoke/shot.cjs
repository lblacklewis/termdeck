/**
 * Visual check for the rail/drawer merge and the timestamp gutter.
 *
 *   npm run build && electron smoke/shot.cjs [outDir]
 *
 * Writes PNGs rather than asserting: layout questions ("is this one column or
 * two?") are judged by looking, and the assertions live in the feature probes.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] || path.join(ROOT, 'node_modules', '.smoke-data', 'shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  // Wipe the profile before anything constructs a store. The stores cache
  // their contents in memory, so deleting their files afterwards leaves the
  // previous run's data in place and the next write puts it back on disk.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  mod.registerIpc()
  fs.mkdirSync(OUT, { recursive: true })
  require(path.join(__dirname, 'clearstore.cjs')).resetStores(['sessions', 'layout', 'settings'])

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
  await sleep(2800)

  const save = async (name) => {
    // `capturePage` hands back an empty image when the window is not actually
    // being painted (occluded, or just after a reload). Nudge it and retry rather
    // than writing a 0-byte file that looks like a broken layout.
    win.show()
    win.focus()
    let img = null
    for (let i = 0; i < 12; i++) {
      img = await win.webContents.capturePage()
      if (!img.isEmpty()) break
      await sleep(300)
    }
    const file = path.join(OUT, name + '.png')
    if (!img || img.isEmpty()) {
      console.error('capture returned an empty image for ' + name)
      return
    }
    fs.writeFileSync(file, img.toPNG())
    console.log('wrote ' + file + ' (' + Math.round(img.getSize().width) + 'x' + Math.round(img.getSize().height) + ')')
  }

  // A terminal, so the timestamp gutter has content to show.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))
    if (btn) btn.click()
    await wait(2600)
    return true
  })()`)
  await sleep(1500)
  await save('01-full')

  // Timestamps on, scrolled so several lines carry one.
  await win.webContents.executeJavaScript(`(async () => {
    const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
    const t = e ? e.term : null
    if (!t) return false
    for (let i = 0; i < 6; i++) {
      t.write('echo gutter-line-' + i + '\\r\\n')
      await new Promise((r) => setTimeout(r, 260))
    }
    return true
  })()`)
  await sleep(1200)
  await save('02-timestamps')

  // Collapsed rail.
  await win.webContents.executeJavaScript(`document.querySelector('[data-testid="rail-toggle"]').click(); true`)
  await sleep(700)
  await save('03-rail-collapsed')

  // Expanded again, with snippets in the bottom bar so the drag targets are real.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="rail-toggle"]').click()
    await wait(500)
    await window.termdeck.saveSnippet({ label: 'deploy', command: 'kubectl apply -f .', group: 'prod', sendEnter: true })
    await window.termdeck.saveSnippet({ label: 'logs', command: 'tail -f /var/log/syslog', group: 'prod', sendEnter: true })
    await window.termdeck.saveSnippet({ label: 'whoami', command: 'whoami', group: '', sendEnter: true })
    await wait(600)
    return true
  })()`)
  await sleep(900)
  await save('04-snippet-bar')

  // The right-click menu, which is the part that was clipped before.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const chip = document.querySelector('[data-snippet-label="deploy"]')
    const r = chip.getBoundingClientRect()
    chip.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2)
    }))
    await wait(500)
    return !!document.querySelector('[data-testid="snippet-menu"]')
  })()`)
  await sleep(500)
  await save('05-snippet-menu')

  // The Hosts manager page, which is now the host editor as well as a list.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await window.termdeck.saveFolder({ name: 'prod' })
    await window.termdeck.saveSession({
      name: 'web-1', host: '10.0.0.11', port: 22, username: 'deploy',
      authMethod: 'password', tags: ['web']
    })
    await window.termdeck.saveSession({
      name: 'db-1', host: '10.0.0.12', port: 22, username: 'root',
      authMethod: 'password', tags: []
    })
    await wait(600)
    document.querySelector('[data-testid="rail-hosts"]').click()
    await wait(1400)
    return true
  })()`)
  await sleep(900)
  await save('06-hosts-rows')

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-testid="hosts-view-cards"]').click(); true`
  )
  await sleep(800)
  await save('07-hosts-cards')

  app.exit(0)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('shot crashed:', err)
    app.exit(1)
  })
)
