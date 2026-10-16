/**
 * First-run welcome + the hosts backup entry in Settings → Credentials.
 *
 * The welcome screen is the only place the data directory can be chosen before
 * anything has been written into it, so it is tested as a whole: it appears on a
 * fresh profile, its four choices are real, saving them sticks, and it never comes
 * back.
 *
 * The export here goes through the *real* native save dialog path (the dialog is
 * stubbed in the main process, not bypassed), which is what the renderer actually
 * does when the user clicks Export — the rest of the share suite passes a path in
 * and would not notice that branch being broken.
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow, dialog } = require('electron')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'termdeck-onboarding-' + Date.now())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  /*
   * `wipeProfile` leaves an onboarded settings file behind so the other suites see
   * the app rather than this sheet; this is the one probe that wants the opposite.
   */
  fs.writeFileSync(
    path.join(app.getPath('userData'), 'settings.json'),
    JSON.stringify({}, null, 2) + '\n',
    'utf8'
  )
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  const stores = mod.storeAccess()
  stores.layout.clear()

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
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
  await sleep(3000)

  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' })
  const page = (code) => win.webContents.executeJavaScript(code)

  // ---- it appears on a fresh profile -----------------------------------------
  const shown = await page(`(() => {
    const el = document.querySelector('[data-testid="welcome-screen"]')
    if (!el) return null
    return {
      hasLanguage: !!document.querySelector('[data-testid="welcome-language"]'),
      themes: document.querySelectorAll('[data-testid="welcome-themes"] .td-theme-card').length,
      fonts: document.querySelectorAll('[data-testid="welcome-fonts"] .td-font-chip').length,
      dir: (document.querySelector('[data-testid="welcome-data-dir"]') || {}).textContent || '',
      start: !!document.querySelector('[data-testid="welcome-start"]'),
      text: (el.innerText || '').slice(0, 120)
    }
  })()`)
  push('a fresh profile opens on the welcome screen', !!shown, shown ? shown.text.slice(0, 60) : 'missing')
  if (!shown) {
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
    console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`)
    app.exit(1)
    return
  }
  push('it offers a language', shown.hasLanguage)
  push('it offers every theme', shown.themes >= 13, shown.themes + ' cards')
  push('it offers terminal fonts', shown.fonts >= 4, shown.fonts + ' chips')
  push('it shows where the data is kept', shown.dir.length > 6, shown.dir)
  push('it has a way out into the app', shown.start)

  // ---- the choices are real ---------------------------------------------------
  await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const lang = document.querySelector('[data-testid="welcome-language"]')
    lang.value = 'zh-CN'
    lang.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(500)
    const theme = [...document.querySelectorAll('[data-testid="welcome-themes"] .td-theme-card')]
      .find((el) => el.getAttribute('data-theme-id') === 'lavender')
    theme.click()
    await wait(400)
    const font = [...document.querySelectorAll('[data-testid="welcome-fonts"] .td-font-chip')]
      .find((el) => el.getAttribute('data-font') === 'Roboto Mono')
    if (font) font.click()
    await wait(400)
    return true
  })()`)

  const zh = await page(`(() => {
    const el = document.querySelector('[data-testid="welcome-screen"]')
    return el ? el.innerText : ''
  })()`)
  push('choosing Chinese redraws the screen itself', /[\u4e00-\u9fff]/.test(zh), zh.slice(0, 40))
  const previewed = await page(`document.documentElement.getAttribute('style') || ''`)
  push('choosing a theme previews it on the document', previewed.includes('--td-bg') || previewed.length > 0,
    previewed.slice(0, 60))

  /*
   * One chip, not several.
   *
   * The stack a chip builds always carries the bundled faces as fallbacks, so
   * "does the stack contain this name" marked Roboto Mono and JetBrains Mono as
   * chosen at the same time and picking a font never appeared to unpick the last.
   * The check is the *first* family, and this is the assertion that keeps it that
   * way: pick one, count the marked chips, pick another, count again.
   */
  const activeChips = () =>
    page(`(() => [...document.querySelectorAll('[data-testid="welcome-fonts"] .td-font-chip')]
      .filter((c) => c.className.includes('is-active'))
      .map((c) => c.getAttribute('data-font')))()`)

  const firstPick = await activeChips()
  push('exactly one font chip is marked as chosen', firstPick.length === 1, JSON.stringify(firstPick))

  const second = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const chips = [...document.querySelectorAll('[data-testid="welcome-fonts"] .td-font-chip')]
    const other = chips.find((c) => !c.className.includes('is-active'))
    other.click()
    await wait(400)
    return other.getAttribute('data-font')
  })()`)
  const secondPick = await activeChips()
  push('picking another font unpicks the previous one',
    secondPick.length === 1 && secondPick[0] === second,
    'now=' + JSON.stringify(secondPick) + ' was=' + JSON.stringify(firstPick))

  // Back to the first chip for the rest of the run, so the saved-font assertion
  // below keeps testing a known value.
  await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const chips = [...document.querySelectorAll('[data-testid="welcome-fonts"] .td-font-chip')]
    chips.find((c) => c.getAttribute('data-font') === 'Roboto Mono').click()
    await wait(400)
    return true
  })()`)

  await page(`document.querySelector('[data-testid="welcome-start"]').click()`)
  await sleep(1200)

  const saved = await page('window.termdeck.loadSettings()')
  push('the language is saved', saved.language === 'zh-CN', String(saved.language))
  push('the theme is saved', saved.theme === 'lavender', String(saved.theme))
  push('the font is saved and keeps its fallbacks',
    saved.terminal.fontFamily.startsWith('"Roboto Mono"') &&
      saved.terminal.fontFamily.includes('monospace'),
    saved.terminal.fontFamily)
  push('and the screen is marked as dealt with', saved.onboarded === true, String(saved.onboarded))

  const gone = await page(`!document.querySelector('[data-testid="welcome-screen"]')`)
  push('the welcome closes once it is done', gone)

  /*
   * What the user is left looking at. The rail is the strip on the left of the
   * window; the drawer is the wide column beside it on the terminal page. Both are
   * asserted because "the left side is hidden" is what a collapsed rail looks like.
   */
  const shell = await page(`(() => {
    const rail = document.querySelector('.td-rail')
    const drawer = document.querySelector('.td-sidebar')
    return {
      rail: !!rail,
      collapsed: rail ? rail.className.includes('is-collapsed') : null,
      drawer: !!drawer,
      scrollW: document.documentElement.scrollWidth
    }
  })()`)
  push('the shell comes up with the rail expanded, not hidden',
    shell.rail && shell.collapsed === false, JSON.stringify(shell))
  push('and the drawer is showing beside it', shell.drawer, JSON.stringify(shell))

  const storedLayout = await page('window.termdeck.loadLayout()')
  push('the saved arrangement agrees', storedLayout.railCollapsed === false,
    'railCollapsed=' + storedLayout.railCollapsed)

  win.webContents.reload()
  await sleep(3200)
  const afterReload = await page(`!document.querySelector('[data-testid="welcome-screen"]')`)
  push('and it does not come back on the next launch', afterReload)

  // ---- the hosts backup entry, in Settings -> Credentials ---------------------
  await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="rail-settings"]').click()
    await wait(1000)
    const tab = [...document.querySelectorAll('.td-settings-tab')].find((b) => b.textContent.includes('凭据'))
    tab.click()
    await wait(700)
    return true
  })()`)
  const credSection = await page(`(() => {
    const el = document.querySelector('[data-testid="credentials-share"]')
    if (!el) return null
    return {
      text: el.innerText,
      export: !!document.querySelector('[data-testid="credentials-export"]'),
      import: !!document.querySelector('[data-testid="credentials-import"]')
    }
  })()`)
  push('Settings → Credentials offers a hosts backup section', !!credSection,
    credSection ? credSection.text.split('\n')[0] : 'missing')
  push('with export and import buttons',
    !!credSection && credSection.export && credSection.import)

  // ---- export through the real dialog path ------------------------------------
  const target = path.join(TMP, 'shared.tdshare')
  fs.mkdirSync(TMP, { recursive: true })
  const realSave = dialog.showSaveDialog
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  try {
    const opened = await page(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      document.querySelector('[data-testid="credentials-export"]').click()
      await wait(900)
      return !!document.querySelector('[data-testid="share-dialog"]')
    })()`)
    push('the export button opens the share dialog from settings', opened)

    await page(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      // React tracks the value it last rendered, so assigning .value directly is
      // swallowed; go through the prototype setter the way a real keystroke does.
      const type = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      type(document.querySelector('[data-testid="share-passphrase"]'), 'colleague-passphrase')
      type(document.querySelector('[data-testid="share-confirm"]'), 'colleague-passphrase')
      await wait(400)
      document.querySelector('[data-testid="share-submit"]').click()
      await wait(1600)
      return true
    })()`)
    push('and the save dialog writes a real file',
      fs.existsSync(target) && fs.statSync(target).size > 100,
      fs.existsSync(target) ? fs.statSync(target).size + ' bytes' : 'no file')
    push('the dialog closes once the file is written',
      await page(`!document.querySelector('[data-testid="share-dialog"]')`))
  } finally {
    dialog.showSaveDialog = realSave
  }

  // ---- the data directory ------------------------------------------------------
  const chosenDir = path.join(TMP, 'data')
  const moved = await page(
    `window.termdeck.setDataDirectory({ dir: ${JSON.stringify(chosenDir)}, move: true })`
  )
  push('a data directory can be chosen', moved.ok === true, JSON.stringify(moved).slice(0, 120))
  push('it reports that a restart is needed', moved.restartRequired === true)
  push('it copies the existing files across', moved.moved.includes('settings.json'),
    (moved.moved || []).join(',') || 'nothing copied')

  /*
   * The running process keeps using the directory it started with — that is the
   * point of the restart — so what has to be true now is the *pointer*: the file in
   * userData that the next launch reads before opening any store.
   */
  const pointer = path.join(app.getPath('userData'), 'data-dir.json')
  let pointerValue = null
  try {
    pointerValue = JSON.parse(fs.readFileSync(pointer, 'utf8')).dataDir
  } catch {
    pointerValue = null
  }
  push('the pointer file names the new directory', pointerValue === chosenDir, String(pointerValue))

  const status = await page('window.termdeck.dataDirectory()')
  push('the running app still uses the old directory until it restarts',
    status.current !== chosenDir && status.moved === false, status.current)
  push('and the default location is reported separately',
    typeof status.default === 'string' && status.default.length > 3, status.default)

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('onboarding probe crashed:', err)
    app.exit(1)
  })
)
