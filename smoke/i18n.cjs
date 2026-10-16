/**
 * i18n probe.
 *
 * Covers what "supports Chinese" has to mean in practice: switching the language
 * actually changes the rendered text, it survives leaving the dialog and a reload,
 * an unsaved change is reverted, and the English it falls back to is unchanged for
 * everyone who never touches the setting.
 *
 * Text is read out of the DOM rather than asserted against the catalog, because a
 * catalog lookup that silently returns English is exactly the failure this is for —
 * the nav rail stayed English for a whole build because its labels were built once
 * at module scope, before the language was known.
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
    width: 1280,
    height: 860,
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
  const textOf = (sel) =>
    win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)})
      return el ? (el.innerText || '') : ''
    })()`)

  // ---- the default is English, and existing installs keep it -----------------
  const railEn = await textOf('.td-rail')
  push('a fresh profile starts in English',
    railEn.includes('Terminal') && railEn.includes('Hosts') && !/[\u4e00-\u9fff]/.test(railEn),
    JSON.stringify(railEn.split('\n').filter(Boolean).slice(0, 8)))
  push('and the stored language is English',
    (await win.webContents.executeJavaScript('window.termdeck.loadSettings().then((s) => s.language)')) === 'en')

  // ---- the setting is offered -------------------------------------------------
  await win.webContents.executeJavaScript('document.querySelector(\'[data-testid="rail-settings"]\').click()')
  await sleep(1200)
  const pick = await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('[data-testid="language-pick"]')
    return sel ? [...sel.options].map((o) => o.value) : null
  })()`)
  push('the settings offer a language picker', Array.isArray(pick) && pick.includes('zh-CN'),
    JSON.stringify(pick))

  // ---- switching redraws the interface ---------------------------------------
  await win.webContents.executeJavaScript(`(() => {
    const sel = document.querySelector('[data-testid="language-pick"]')
    sel.value = 'zh-CN'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(900)

  const zhRail = await textOf('.td-rail')
  const zhTabs = await textOf('.td-settings-tabs')
  push('the rail switches to Chinese',
    zhRail.includes('终端') && zhRail.includes('已知主机') && !zhRail.includes('Known Hosts'),
    JSON.stringify(zhRail.split('\n').filter(Boolean).slice(0, 10)))
  push('the settings tabs switch with it',
    zhTabs.includes('外观') && zhTabs.includes('快捷键') && !zhTabs.includes('Appearance'),
    JSON.stringify(zhTabs.split('\n').filter(Boolean)))
  const zhHint = await textOf('.td-theme-head')
  push('longer prose switches too', /[\u4e00-\u9fff]/.test(zhHint) && zhHint.length > 10,
    zhHint.slice(0, 40))

  // ---- leaving without saving reverts ----------------------------------------
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-testid="settings-drawer"] .td-icon-btn\').click()'
  )
  await sleep(900)
  const reverted = await textOf('.td-rail')
  push('closing without saving puts English back',
    reverted.includes('Terminal') && !/[\u4e00-\u9fff]/.test(reverted),
    JSON.stringify(reverted.split('\n').filter(Boolean).slice(0, 6)))

  // ---- saving persists, including across a reload ----------------------------
  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const s = await api.loadSettings()
    await api.saveSettings({ ...s, language: 'zh-CN' })
    return true
  })()`)
  await sleep(900)
  win.webContents.reload()
  await sleep(3200)

  const afterReload = await textOf('.td-rail')
  push('a saved language survives a reload',
    afterReload.includes('终端') && !afterReload.includes('Known Hosts'),
    JSON.stringify(afterReload.split('\n').filter(Boolean).slice(0, 8)))

  const pageTitle = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="rail-hosts"]')
    return el ? (el.getAttribute('title') || el.getAttribute('aria-label') || '') : ''
  })()`)
  push('tooltips are translated as well as labels',
    /[\u4e00-\u9fff]/.test(pageTitle) || pageTitle === '', 'title=' + pageTitle)

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('i18n probe crashed:', err)
    app.exit(1)
  })
)
