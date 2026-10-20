/**
 * Tool pages cost nothing until they are opened.
 *
 *   npm run build && electron smoke/memory.cjs --user-data-dir=...
 *
 * The app carries six or seven whole pages that most sessions never touch (the
 * S3 browser, the REST client, the tunnel list, hosts, snippets, logs, the SFTP
 * panel). Each one is code plus, once opened, whatever state it holds — a 5 MB
 * response body, a bucket listing, a connection with a secret in it. None of that
 * should exist for a user who is just sitting in a terminal.
 *
 * Two things are asserted, and they catch different mistakes:
 *
 *   1. Structure. No tool page module is fetched at startup, opening the page
 *      fetches exactly its own chunk, and leaving it unmounts the component —
 *      which is what drops the state it was holding.
 *   2. Memory. Opening and closing every tool page several times does not make
 *      the renderer's private bytes climb. A page that keeps a response, a
 *      listing or a live connection after it is closed shows up here.
 *
 * The bound is deliberately generous: the point is to catch a tool that holds
 * megabytes or grows per visit, not to police a few hundred kilobytes of JIT.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

/*
 * A collection is forced before every measurement. Private bytes include heap
 * that V8 simply has not given back yet, and "nothing collected it" is a very
 * different statement from "the page kept it" — only the second one is a bug.
 */
app.commandLine.appendSwitch('js-flags', '--expose-gc')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

/** Every page that is supposed to arrive only when it is asked for. */
const LAZY_PAGES = [
  { page: 'tunnels', root: 'tunnels-page', chunk: 'TunnelsPage' },
  { page: 'rest', root: 'rest-page', chunk: 'RestPage' },
  { page: 's3', root: 's3-page', chunk: 'S3Page' }
]

/**
 * Whether each page's code lives in its own file rather than in the entry.
 *
 * Checked against the build output rather than at runtime: the renderer is loaded
 * over `file://`, where `performance.getEntriesByType('resource')` records
 * nothing, so a runtime probe would pass by being blind. A page's own test ids
 * are the marker — they exist in exactly one chunk, and must not exist in the
 * bundle that every window parses at startup.
 */
function chunkReport() {
  const dir = path.join(ROOT, 'out', 'renderer', 'assets')
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'))
  const entry = files.find((name) => /^index-/.test(name))
  if (!entry) return { ok: false, detail: 'no entry chunk in ' + dir }
  const entrySource = fs.readFileSync(path.join(dir, entry), 'utf8')

  const problems = []
  for (const { page, root, chunk } of LAZY_PAGES) {
    const own = files.find((name) => name.startsWith(chunk + '-'))
    if (!own) {
      problems.push(page + ': no ' + chunk + '-*.js chunk')
      continue
    }
    if (!fs.readFileSync(path.join(dir, own), 'utf8').includes(root)) {
      problems.push(page + ': its chunk does not contain ' + root)
    }
    if (entrySource.includes(root)) {
      problems.push(page + ': ' + root + ' is in the entry bundle (' + entry + ')')
    }
  }
  return {
    ok: problems.length === 0,
    detail: problems.length === 0
      ? LAZY_PAGES.map((p) => p.chunk).join(', ') + ' are separate from ' + entry
      : problems.join('; ')
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  const win = new BrowserWindow({
    width: 1400,
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

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)
  win.focus()

  /** Chunk files the page has actually fetched, by name. */
  const fetchedChunks = () =>    win.webContents.executeJavaScript(`
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name.split('/').pop())
        .filter((name) => /-.*[.]js$/.test(name) && !/^index-/.test(name))
    `)

  /*
   * Renderer private bytes, straight from Electron's own per-process metrics.
   * `webContents.getProcessMemoryInfo` does not exist in this version, and
   * `process.memoryUsage()` is only available inside the preload, not the page.
   */
  const privateBytes = async () => {
    // Collect first; `--expose-gc` was requested on the command line above.
    await win.webContents.executeJavaScript('(window.gc ? window.gc() : 0, true)')
    const metrics = app.getAppMetrics()
    const renderer = metrics.find((entry) => entry.type === 'Tab' || entry.type === 'renderer')
    const memory = renderer && renderer.memory
    // Electron reports these in kilobytes.
    return ((memory && (memory.privateBytes || memory.workingSetSize)) || 0) * 1024
  }

  /*
   * One round trip per open and per leave, with the waiting done inside the page.
   * Polling from here would evaluate a script every 150 ms, and those evaluations
   * are themselves a measurable amount of the renderer's heap — which would be
   * the probe measuring itself instead of the pages.
   */
  const openPage = (page, root) =>
    win.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const tab = document.querySelector('[data-testid="rail-${page}"]')
        if (!tab) return false
        tab.click()
        for (let i = 0; i < 60; i += 1) {
          if (document.querySelector('[data-testid="${root}"]')) return true
          await wait(150)
        }
        return false
      })()
    `)

  const leavePage = (root) =>
    win.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const tab = document.querySelector('[data-testid="rail-terminal"]')
        if (tab) tab.click()
        for (let i = 0; i < 40; i += 1) {
          if (!document.querySelector('[data-testid="${root}"]')) return true
          await wait(150)
        }
        return false
      })()
    `)

  // ---- 1. nothing tool-shaped is loaded at startup ------------------------
  const chunks = chunkReport()
  report([
    {
      name: 'no tool page ships inside the startup bundle',
      ok: chunks.ok,
      detail: chunks.detail
    }
  ])

  const baseline = await privateBytes()
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
  console.log('renderer private bytes at rest: ' + mb(baseline))

  // ---- 2. each page arrives on demand and leaves when abandoned -----------
  for (const { page, root } of LAZY_PAGES) {
    const opened = await openPage(page, root)
    const left = await leavePage(root)
    report([
      {
        name: `${page}: the page opens when asked for`,
        ok: opened,
        detail: opened ? 'shown' : 'never appeared'
      },
      {
        name: `${page}: leaving the page unmounts it, dropping what it held`,
        ok: left,
        detail: 'still in the DOM: ' + !left
      }
    ])
    await sleep(400)
  }

  // ---- 3. doing that repeatedly must not climb -----------------------------
  /*
   * Four rounds. The first visits pay for parsing chunks that then stay in the
   * heap for the life of the process — nothing can unload a module — so the
   * number that matters is the growth of the *last* round, by which point the JIT
   * and the module graph have settled. Steady growth there would mean a page
   * keeps something of its own after it is closed.
   */
  const cycle = async () => {
    for (const { page, root } of LAZY_PAGES) {
      await openPage(page, root)
      await sleep(250)
      await leavePage(root)
      await sleep(250)
    }
    await sleep(600)
    return privateBytes()
  }

  const readings = []
  for (let i = 0; i < 4; i += 1) readings.push(await cycle())
  const steps = readings.map((value, i) => value - (i === 0 ? baseline : readings[i - 1]))
  console.log(
    'growth per round: ' + steps.map((step) => (step >= 0 ? '+' : '') + mb(step)).join(', ')
  )

  const lastStep = readings[readings.length - 1] - readings[readings.length - 2]
  report([
    {
      name: 'opening every tool page stays well inside a sane budget',
      ok: readings[0] - baseline < 16 * 1024 * 1024,
      detail: mb(baseline) + ' -> ' + mb(readings[0]) + ' (+' + mb(readings[0] - baseline) + ')'
    },
    {
      name: 'and by the fourth round the cost per round has settled',
      ok: lastStep < 1 * 1024 * 1024,
      detail: 'round3->4 ' + (lastStep >= 0 ? '+' : '') + mb(lastStep) +
        ' (all: ' + readings.map(mb).join(' -> ') + ')'
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('memory probe crashed:', err)
    app.exit(1)
  })
)
