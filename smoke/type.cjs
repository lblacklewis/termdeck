/**
 * Interface type: the font, and the breathing room around it.
 *
 *   npm run build && electron smoke/type.cjs --user-data-dir=...
 *
 * Two things that are easy to claim and easy to get wrong:
 *
 *  - the interface has its own font and it does **not** follow the terminal's. A
 *    user who picks a terminal font should see the terminal change and nothing
 *    else; if the UI followed it, a monospace terminal font would make every
 *    label in the app monospace too.
 *  - dialog text has a gutter. A dialog whose body was bare paragraphs used to
 *    run its text flush into the frame — measured here, not eyeballed.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`)
    all.push(c)
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.registerQuitIpc()
  mod.storeAccess().layout.clear()

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
  mod.attachQuitConfirmation(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2800)
  win.focus()
  await sleep(300)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 6000)
        while (Date.now() < end) {
          if (await fn()) return true
          await wait(150)
        }
        return false
      }
      const familyOf = (el) => getComputedStyle(el).fontFamily
      let step = 'start'
      try {

      // ---- 1. the interface has its own font ------------------------------
      step = 'font'
      const loaded = await waitFor(() => document.fonts.check('13px Inter'), 5000)
      push('the bundled interface font is loaded', loaded,
        'families=' + [...document.fonts].map((f) => f.family).join(','))
      const bodyFamily = familyOf(document.body)
      push('the interface uses it', /Inter/i.test(bodyFamily.split(',')[0]), bodyFamily)
      const label = document.querySelector('[data-testid="sidebar"] .td-section-title') ||
        document.querySelector('.td-sidebar-section')
      push('and so do the drawer labels', !!label && /Inter/i.test(familyOf(label).split(',')[0]),
        label ? familyOf(label) : 'no label')

      // ---- 2. it does not follow the terminal font ------------------------
      /*
       * The terminal's font is the terminal's. Picking a distinctive one must move
       * the terminal and nothing else.
       */
      step = 'independence'
      const settings = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...settings,
        terminal: { ...settings.terminal, fontFamily: '"Comic Sans MS", cursive' }
      })
      await wait(600)

      // A pane has to exist for the terminal to be measured at all.
      const shell = document.querySelector('[data-testid="local-shell"]')
      if (shell) shell.click()
      const paneUp = await waitFor(() => !!document.querySelector('.xterm'), 12000)
      push('a terminal is open to compare against', paneUp)
      /*
       * Measured on the rows element, which is what actually paints the glyphs:
       * xterm sets the font there rather than on the terminal root, so reading the
       * root would only ever report the inherited interface stack.
       */
      await wait(800)
      const rows = document.querySelector('.xterm-rows')
      const rowsFamily = rows ? familyOf(rows) : ''
      const termFont = Object.values(window.__tdTerminals || {})[0]?.term?.options?.fontFamily || ''
      push('the terminal takes the chosen font',
        /Comic Sans/i.test(rowsFamily) && /Comic Sans/i.test(termFont),
        'rows=' + rowsFamily + ' option=' + termFont)
      const uiFamily = familyOf(document.body).split(',')[0]
      push('the interface ignores it', /Inter/i.test(uiFamily) && !/Comic Sans/i.test(uiFamily),
        'body=' + familyOf(document.body))
      const stillLabel = document.querySelector('.td-sidebar-section')
      push('and every label stays on the interface font',
        !!stillLabel && /Inter/i.test(familyOf(stillLabel)) && !/Comic Sans/i.test(familyOf(stillLabel)),
        stillLabel ? familyOf(stillLabel) : 'none')

      // Put the terminal font back so the rest of the suite sees a normal pane.
      const back = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...back,
        terminal: { ...back.terminal, fontFamily: settings.terminal.fontFamily }
      })
      await wait(400)

      // ---- 3. dialog text keeps its distance from the frame ---------------
      step = 'dialog gutter'
      window.termdeck.quitApp === undefined ? null : null
      return out
      } catch (err) {
        out.push({
          name: 'failed at step: ' + step,
          ok: false,
          detail: String((err && err.message) || err)
        })
        return out
      }
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'type probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // ---- 4. the quit dialog's text gutter (measured while it is on screen) ----
  win.close()
  await sleep(900)
  const gutter = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[data-testid="quit-confirm"]')
    const body = dialog && dialog.querySelector('.td-modal-body')
    const text = dialog && dialog.querySelector('[data-testid="quit-detail"]')
    const hint = dialog && dialog.querySelector('.td-hint')
    const head = dialog && dialog.querySelector('.td-modal-head')
    const foot = dialog && dialog.querySelector('.td-modal-foot')
    if (!dialog || !body || !text || !hint || !head || !foot) {
      return { present: false }
    }
    const d = dialog.getBoundingClientRect()
    const t = text.getBoundingClientRect()
    const h = hint.getBoundingClientRect()
    const hd = head.getBoundingClientRect()
    const ft = foot.getBoundingClientRect()
    return {
      present: true,
      dialog: { w: Math.round(d.width), h: Math.round(d.height) },
      leftInset: Math.round(t.left - d.left),
      rightInset: Math.round(d.right - t.right),
      hintLeftInset: Math.round(h.left - d.left),
      hintRightInset: Math.round(d.right - h.right),
      rowGap: Math.round(h.top - t.bottom),
      headFull: Math.round(hd.left - d.left) <= 1 && Math.round(d.right - hd.right) <= 1,
      footFull: Math.round(ft.left - d.left) <= 1 && Math.round(d.right - ft.right) <= 1,
      padding: getComputedStyle(body).padding
    }
  })()`)

  const checks = [
    {
      name: 'the quit dialog is on screen to measure',
      ok: gutter.present === true,
      detail: gutter.present ? JSON.stringify(gutter.dialog) : 'not found'
    }
  ]
  if (gutter.present) {
    checks.push(
      {
        name: 'its text keeps a real gutter from the frame',
        ok: gutter.leftInset >= 16 && gutter.rightInset >= 16,
        detail: 'left=' + gutter.leftInset + ' right=' + gutter.rightInset +
          ' padding=' + gutter.padding
      },
      {
        name: 'the hint sits on the same gutter as the headline',
        ok: gutter.hintLeftInset === gutter.leftInset &&
          gutter.hintRightInset === gutter.rightInset,
        detail: 'text=' + gutter.leftInset + '/' + gutter.rightInset +
          ' hint=' + gutter.hintLeftInset + '/' + gutter.hintRightInset
      },
      {
        name: 'the two paragraphs are not crammed together',
        ok: gutter.rowGap >= 8,
        detail: 'gap=' + gutter.rowGap + 'px'
      },
      {
        name: 'the head and foot bars still span the dialog',
        ok: gutter.headFull && gutter.footFull,
        detail: 'head=' + gutter.headFull + ' foot=' + gutter.footFull
      }
    )
  }
  report(checks)

  // Cancel the quit so the suite exits on its own terms.
  await win.webContents.executeJavaScript(
    'document.querySelector("[data-testid=\\"quit-cancel\\"]")?.click(); true'
  )

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('type probe crashed:', err)
    app.exit(1)
  })
)
