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

  /*
   * ---- a tool page, translated as a whole ------------------------------------
   *
   * The REST page's labels were the last English left inside a Chinese interface:
   * its strings were already wrapped in `t()`, but the catalog had not a single
   * `restpage.*` entry, so every one of them fell back. That failure is invisible
   * to `check:i18n` (a missing translation is only a note there), which is why it
   * survived a whole release — so this asserts the *rendered page*:
   *
   *   1. every label that has a Chinese form shows it, including `aria-label`s and
   *      the `<option>` rows, which are text but not visible chrome;
   *   2. the English each of those labels used to show is gone. Listing the English
   *      is what makes this discriminate: against the untranslated page every one
   *      of these fails, whereas "the page contains Chinese somewhere" would pass
   *      on the rail alone.
   */
  await win.webContents.executeJavaScript(
    'document.querySelector(\'[data-testid="rail-rest"]\').click()'
  )
  await sleep(1500)

  const rest = await win.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('[data-testid="rest-page"]')
    if (!page) return { missing: true }
    const field = (id) => document.querySelector('[data-testid="' + id + '"]')
    const text = (id) => (field(id) ? field(id).textContent || '' : '')
    const attr = (id, name) => (field(id) ? field(id).getAttribute(name) || '' : '')
    const options = (id) => {
      const el = field(id)
      return el ? [...el.options].map((o) => o.textContent || '') : []
    }
    const templateOptions = options('rest-template')
    const savedOptions = options('rest-saved')
    return {
      missing: false,
      body: page.textContent || '',
      send: text('rest-send'),
      copy: text('rest-copy-curl'),
      addHeader: text('rest-header-add'),
      format: text('rest-format'),
      templateAria: attr('rest-template', 'aria-label'),
      savedAria: attr('rest-saved', 'aria-label'),
      blankOption: templateOptions[0] || '',
      noSavedOption: savedOptions[0] || '',
      historyEmpty: text('rest-history-empty'),
      keptEmpty: text('rest-kept-empty'),
      groupTitles: [...page.querySelectorAll('.td-rest-group-title')].map((el) => el.textContent || ''),
      fieldLabels: [...page.querySelectorAll('.td-field > span:first-child')].map((el) => el.textContent || ''),
      templates: templateOptions.slice(1)
    }
  })()`)

  const hasCJK = (value) => /[\u4e00-\u9fff]/.test(value || '')
  const show = (value) => JSON.stringify(String(value || '').slice(0, 60))

  push('opening REST in Chinese shows the page', !rest.missing,
    rest.missing ? 'no [data-testid=rest-page]' : 'ok')
  push('the REST toolbar is Chinese',
    rest.send === '发送' && hasCJK(rest.copy) && (rest.copy || '').includes('cURL') &&
      hasCJK(rest.addHeader) && hasCJK(rest.format),
    [rest.send, rest.copy, rest.addHeader, rest.format].join(' | '))
  /*
   * The label of a field is the first span inside it, but for the two fields that carry
   * controls on the same line (headers, body) that span also wraps the controls, so its
   * text reads "请求头逐条JSON". Asserting what the label *starts with* is the honest
   * form; requiring the array to equal the four words was wrong about the DOM.
   */
  const fieldLabels = rest.fieldLabels || []
  push('the REST field labels are Chinese',
    ['方法', '请求头', '请求体', '超时'].every((label) =>
      fieldLabels.some((value) => value.indexOf(label) === 0)),
    JSON.stringify(fieldLabels))
  push('its list headings and empty hints are Chinese',
    (rest.groupTitles || []).length === 2 && rest.groupTitles.every(hasCJK) &&
      hasCJK(rest.historyEmpty) && hasCJK(rest.keptEmpty),
    (rest.groupTitles || []).concat([rest.historyEmpty, rest.keptEmpty]).join(' | '))
  push('the built-in templates are Chinese, not their English names',
    (rest.templates || []).length >= 6 &&
      rest.templates.filter(hasCJK).length >= 5 &&
      !rest.templates.some((name) =>
        /list models|generate|Cluster health|Instant query|Health check|repository/i.test(name)),
    JSON.stringify(rest.templates))
  push('aria labels and menu rows are translated, not only visible text',
    hasCJK(rest.templateAria) && rest.templateAria !== 'Template' &&
      hasCJK(rest.savedAria) && rest.savedAria !== 'Saved requests' &&
      hasCJK(rest.blankOption) && hasCJK(rest.noSavedOption),
    [rest.templateAria, rest.savedAria, rest.blankOption, rest.noSavedOption].join(' | '))

  const stillEnglish = [
    'Send', 'Copy as cURL', 'Add header', 'Format JSON', 'Timeout (s)',
    'Accept a self-signed certificate', 'Method', 'Headers', 'Body',
    'History', 'Kept requests', 'Calls you send show up here.',
    'Keep a call to find it again by name.', 'Saved requests', 'Blank request',
    'No response yet', 'Rows', 'Search the response',
    'Fold back to the first 400 lines'
  ].filter((phrase) => (rest.body || '').includes(phrase))
  push('none of the page English is left anywhere on it', stillEnglish.length === 0,
    stillEnglish.length ? stillEnglish.join(' | ') : 'clean')

  /*
   * Two more things the page cannot translate on its own, and so were still
   * English in the catalog-complete build: the description of the selected
   * template (shared data, one row per template) and the reason a call failed
   * (produced in the main process). The second one is asserted on the *new*
   * error each time — the previous error is still on screen otherwise, and the
   * first attempt at this kind of probe passed against a stale one.
   */
  const restDeep = await win.webContents.executeJavaScript(`(async () => {
    const field = (id) => document.querySelector('[data-testid="' + id + '"]')
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const setValue = (el, value) => {
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    }
    const readError = () => {
      const el = field('rest-error')
      return el ? el.textContent || '' : ''
    }
    const nextError = async (previous) => {
      for (let i = 0; i < 60; i += 1) {
        await wait(150)
        const now = readError()
        if (now && now !== previous) return now
      }
      return readError()
    }

    setValue(field('rest-template'), 'elasticsearch-health')
    await wait(600)
    const hint = (field('rest-template-hint') || {}).textContent || ''
    const url = (field('rest-url') || {}).value || ''

    setValue(field('rest-url'), 'nope')
    await wait(600)
    field('rest-send').click()
    const noScheme = await nextError('')

    setValue(field('rest-url'), 'ftp://example.com/x')
    await wait(600)
    field('rest-send').click()
    const badScheme = await nextError(noScheme)

    return { hint, url, noScheme, badScheme }
  })()`)

  push('a selected template explains itself in Chinese',
    hasCJK(restDeep.hint) && !/Cluster health|the usual first question/.test(restDeep.hint || ''),
    show(restDeep.hint))
  push('and picking a template still fills the request in',
    (restDeep.url || '').includes('9200'), show(restDeep.url))
  push('a failure the main process reported comes back in Chinese',
    hasCJK(restDeep.noScheme) && !/That is not a URL/.test(restDeep.noScheme || ''),
    show(restDeep.noScheme))
  push('and each reason keeps its own wording',
    hasCJK(restDeep.badScheme) && restDeep.badScheme !== restDeep.noScheme &&
      !/Only http/.test(restDeep.badScheme || ''),
    show(restDeep.badScheme))

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
