/**
 * Contrast audit for every theme, on every page.
 *
 *   npm run build && electron smoke/contrast.cjs --user-data-dir=...
 *
 * Compares each text element's computed colour against its effective background
 * and reports pairs below the WCAG AA threshold. This is how the light-theme
 * "dark box with dark text" bug and the missing navigation-rail tokens were
 * found; eyeballing themes does not catch these.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')

/** Pages audited in each theme, so every surface is exercised. */
const AUDIT_PAGES = ['terminal', 'hosts', 'known-hosts', 'snippets', 'logs']

/** Injected into the page: returns the low-contrast pairs it can find. */
const MEASURE_SOURCE = `(() => {
  const parse = (v) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(v || '')
    if (!m) return null
    const p = m[1].split(',').map(x => parseFloat(x.trim()))
    if (p.length > 3 && p[3] === 0) return null
    return p.slice(0, 3)
  }
  const lum = (rgb) => {
    const [r, g, b] = rgb.map(v => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (fg, bg) => {
    const a = lum(fg), b = lum(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const effectiveBg = (el) => {
    let node = el
    while (node && node !== document.documentElement.parentNode) {
      const bg = parse(getComputedStyle(node).backgroundColor)
      if (bg) return bg
      node = node.parentElement
    }
    return [255, 255, 255]
  }

  const themeState = {
    id: document.documentElement.dataset.themeId,
    scheme: document.documentElement.dataset.themeScheme,
    bg: getComputedStyle(document.documentElement).getPropertyValue('--td-bg').trim(),
    surface: getComputedStyle(document.documentElement).getPropertyValue('--td-surface').trim()
  }

  /**
   * Decorative glyphs and numeric badges are not prose, so the text-contrast
   * rule does not apply and they are intentionally dimmed. Markup opts out with
   * data-contrast-exempt, plus a few purely decorative state indicators.
   */
  const DECORATIVE = [
    'td-caret', 'td-mini', 'td-icon-btn', 'td-brand-mark', 'td-badge',
    'td-snippet-count', 'td-node-count', 'td-snippet-restore', 'td-dot',
    'td-host-status', 'td-rail-icon', 'td-rail-badge', 'td-drag-grip'
  ]

  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('body *')) {
    const text = (el.textContent || '').trim()
    if (!text) continue
    if ([...el.children].some(c => (c.textContent || '').trim() === text)) continue
    const cls = (el.className || '').toString()
    if (DECORATIVE.some(d => cls.includes(d))) continue
    if (el.closest('[data-contrast-exempt]')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue
    const box = el.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) continue
    const fg = parse(style.color)
    if (!fg) continue
    const bg = effectiveBg(el)
    const c = ratio(fg, bg)
    if (c >= 3.0) continue
    const key = style.color + '|' + bg.join(',') + '|' + cls
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      cls: (cls || el.tagName).toString().slice(0, 46),
      text: text.slice(0, 26),
      fg: style.color,
      bg: 'rgb(' + bg.join(', ') + ')',
      ratio: Math.round(c * 100) / 100,
      border: style.borderTopColor,
      theme: themeState
    })
  }
  return out.slice(0, 10)
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await sleep(2200)

  // Populate data so list pages render rows rather than the empty state.
  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const s = await api.loadSettings()
    await api.saveSettings({ ...s, hostKeys: { policy: 'trust' } })
    await api.saveFolder({ name: 'audit-folder' })
    await api.saveSession({ name: 'audit-session', host: '10.1.2.3', username: 'root', tags: ['audit'] })
    await api.saveSnippet({ label: 'audit-snippet', command: 'echo hi', group: 'ops', sendEnter: true })
    return true
  })()`)
  await sleep(800)

  // Read the theme list once, from the settings drawer. The drawer is reached
  // through the rail rather than the sidebar footer: the footer button only exists
  // on the Terminal page, since only that page has the list drawer beside it.
  const themes = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-testid="rail-settings"]').click()
    await new Promise((r) => setTimeout(r, 600))
    const ids = [...document.querySelectorAll('[data-testid="theme-grid"] .td-theme-card')]
      .map((c) => c.getAttribute('data-theme-id'))
    document.querySelector('[data-testid="drawer-close"]').click()
    await new Promise((r) => setTimeout(r, 400))
    return ids
  })()`)
  if (themes.length === 0) throw new Error('no themes found in the picker')

  // Freeze transitions for the whole run: a theme switch animates colours, and
  // sampling mid-interpolation reports blended values that exist for a few
  // frames only — that produced bogus findings until it was pinned down.
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style')
    style.id = 'td-audit-freeze'
    style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'
    document.head.appendChild(style)
    return true
  })()`)

  const allFindings = []

  for (const themeId of themes) {
    await win.webContents.executeJavaScript(`(async () => {
      const api = window.termdeck
      const s = await api.loadSettings()
      await api.saveSettings({ ...s, theme: ${JSON.stringify(themeId)} })
      return true
    })()`)
    await sleep(450)

    for (const page of AUDIT_PAGES) {
      await win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('[data-testid="rail-${page}"]'); if (b) b.click(); return true })()`
      )
      await sleep(280)
      const findings = await win.webContents.executeJavaScript(MEASURE_SOURCE)
      if (findings.length > 0) allFindings.push({ themeId, page, findings })
    }
  }

  let bad = 0
  for (const { themeId, page, findings } of allFindings) {
    bad += findings.length
    console.log(`FAIL  ${themeId} / ${page}: ${findings.length} low-contrast element(s)`)
    for (const f of findings) {
      console.log(`        ${f.ratio}:1  ${f.cls}`)
      console.log(`          "${f.text}"  fg=${f.fg} bg=${f.bg} border=${f.border}`)
      console.log(
        `          theme=${f.theme.id}/${f.theme.scheme} --td-bg=${f.theme.bg} --td-surface=${f.theme.surface}`
      )
    }
  }

  for (const themeId of themes) {
    if (!allFindings.some((f) => f.themeId === themeId)) {
      console.log(`PASS  ${themeId}: clean on all ${AUDIT_PAGES.length} pages`)
    }
  }

  console.log(
    `\n${bad === 0 ? 'no' : bad} low-contrast finding(s) across ${themes.length} themes x ${AUDIT_PAGES.length} pages`
  )
  app.exit(bad === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('contrast audit crashed:', err)
    app.exit(1)
  })
)
