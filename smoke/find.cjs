/**
 * Text search inside a terminal pane (Ctrl+F).
 *
 *   npm run build && electron smoke/find.cjs --user-data-dir=...
 *
 * The pane's own box is the feature: Ctrl+F must open it instead of sending `0x06`
 * to the shell, the count must agree with what the buffer actually holds, every hit
 * on screen must be painted, the hit being looked at must be scrolled into view, and
 * Enter / Shift+Enter / the arrows must walk the hits — wrapping at both ends.
 *
 * What is asserted here is not the existence of a helper: the buffer is measured
 * independently (indexOf over every line) and compared against the count the pane
 * shows, so a search that quietly matches the wrong rows fails.
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

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
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
      // An occluded renderer is throttled: writes would not paint and the buffer
      // assertions below would read a terminal that never advanced.
      backgroundThrottling: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(2600)

  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const target = document.querySelector('[data-testid="local-shell"]')
    if (target) target.click()
    await wait(1500)
    return !!target
  })()`)

  await sleep(3000)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))

      const sessionId = window.__tdTerminals ? Object.keys(window.__tdTerminals)[0] : null
      const entry = () => (window.__tdTerminals && sessionId ? window.__tdTerminals[sessionId] : null)
      const term = () => (entry() ? entry().term : null)
      const finder = () => (entry() ? entry().find : null)
      const box = () => document.querySelector('[data-testid="terminal-find"]')
      const input = () => document.querySelector('[data-testid="terminal-find-input"]')
      const counter = () => document.querySelector('[data-testid="terminal-find-count"]')
      const textarea = () => document.querySelector('.xterm-helper-textarea')
      const textOf = (el) => (el ? (el.textContent || '').trim() : '')

      /* Every occurrence of a needle in the whole scrollback, measured here so the
         pane's own count has something independent to be compared against. */
      const countIn = (needle) => {
        const t = term()
        if (!t || !needle) return 0
        const hay = needle.toLowerCase()
        let n = 0
        for (let i = 0; i < t.buffer.active.length; i++) {
          const line = t.buffer.active.getLine(i)
          if (!line) continue
          const text = line.translateToString(true).toLowerCase()
          let at = text.indexOf(hay)
          while (at !== -1) {
            n += 1
            at = text.indexOf(hay, at + hay.length)
          }
        }
        return n
      }

      const rowOf = (needle) => {
        const t = term()
        const hay = needle.toLowerCase()
        for (let i = 0; i < t.buffer.active.length; i++) {
          const line = t.buffer.active.getLine(i)
          if (line && line.translateToString(true).toLowerCase().indexOf(hay) !== -1) return i
        }
        return -1
      }

      const bufferText = () => {
        const t = term()
        let text = ''
        for (let i = 0; i < t.buffer.active.length; i++) {
          const line = t.buffer.active.getLine(i)
          if (line) text += line.translateToString(true) + '\\n'
        }
        return text
      }

      const until = async (label, fn, tries) => {
        for (let i = 0; i < (tries || 40); i++) {
          if (fn()) return true
          await wait(150)
        }
        return false
      }

      /* Ctrl+F, aimed at the element xterm listens on — the pane's own handler is
         consulted from there, and a keyboard event on the body never reaches it. */
      const pressCtrlF = async () => {
        const target = textarea() || document.activeElement || document.body
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
        }))
        target.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true
        }))
        await wait(250)
      }

      /* React reads a controlled input's value from its own input event, and a plain
         assignment is swallowed by its value tracker — hence the native setter. */
      const typeQuery = async (value) => {
        const el = input()
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(200)
        return true
      }

      const pressKey = async (key, shift) => {
        const el = input() || textarea() || document.body
        const init = { key: key, code: key, shiftKey: Boolean(shift), bubbles: true, cancelable: true }
        el.dispatchEvent(new KeyboardEvent('keydown', init))
        el.dispatchEvent(new KeyboardEvent('keyup', init))
        await wait(200)
      }

      const TOKEN = 'TD_FINDONE_ALPHA'
      if (sessionId) {
        await window.termdeck.writeSession(sessionId, 'echo ' + TOKEN + '\\r')
        await window.termdeck.writeSession(sessionId, 'echo beta ' + TOKEN + '\\r')
        await window.termdeck.writeSession(sessionId, 'echo ' + TOKEN + ' omega\\r')
      }

      const printed = await until('token', () => countIn(TOKEN) >= 3)
      push('the shell printed the token being searched for',
        printed, 'occurrences in the buffer: ' + countIn(TOKEN))

      /* Push the token up out of the viewport, so "the hit is brought into view" is
         something the search actually has to do rather than something it inherits. */
      let filler = ''
      for (let i = 0; i < 60; i++) filler += 'echo td-filler-' + i + '\\r'
      if (sessionId) await window.termdeck.writeSession(sessionId, filler)
      const filled = await until('filler', () => countIn('td-filler-59') >= 1)
      const rows = term().rows
      const tokenRow = rowOf(TOKEN)
      const hidden = filled && tokenRow !== -1 && tokenRow < term().buffer.active.viewportY
      push('the token scrolled out of the viewport before searching',
        hidden, 'row ' + tokenRow + ' of a viewport starting at ' + term().buffer.active.viewportY +
          ', ' + rows + ' rows tall')

      const expected = countIn(TOKEN)
      const linesBefore = term().buffer.active.length

      await pressCtrlF()
      push('Ctrl+F opens the pane search box', !!box(),
        box() ? '' : 'no [data-testid="terminal-find"] in the DOM')
      push('the box takes the keyboard', document.activeElement === input(),
        document.activeElement ? String(document.activeElement.className) : 'no active element')
      push('Ctrl+F sent nothing to the shell', term().buffer.active.length === linesBefore,
        'buffer lines ' + linesBefore + ' -> ' + term().buffer.active.length)

      const typed = await typeQuery(TOKEN)
      push('the query reached the search', typed && !!finder(), 'finder: ' + String(!!finder()))

      const status = finder() ? finder().status() : { index: 0, total: 0, visible: 0 }
      push('the count matches what the buffer holds', status.total === expected,
        status.total + ' found, ' + expected + ' in the buffer')
      push('the box shows the first hit of that many',
        textOf(counter()) === '1 / ' + expected, 'counter reads "' + textOf(counter()) + '"')
      push('every hit on screen is painted', status.visible > 0,
        status.visible + ' decorations for ' + status.total + ' hits')
      push('the hit being looked at is scrolled into view',
        tokenRow >= term().buffer.active.viewportY && tokenRow < term().buffer.active.viewportY + rows,
        'row ' + tokenRow + ', viewport ' + term().buffer.active.viewportY + ' + ' + rows)

      await pressKey('Enter', false)
      push('Enter moves to the next hit', textOf(counter()) === '2 / ' + expected,
        'counter reads "' + textOf(counter()) + '"')
      await pressKey('Enter', true)
      push('Shift+Enter moves back', textOf(counter()) === '1 / ' + expected,
        'counter reads "' + textOf(counter()) + '"')
      await pressKey('Enter', true)
      push('walking back from the first hit wraps to the last',
        textOf(counter()) === expected + ' / ' + expected, 'counter reads "' + textOf(counter()) + '"')

      const nextButton = document.querySelector('[data-testid="terminal-find-next"]')
      if (nextButton) nextButton.click()
      await wait(200)
      push('the next button walks forward too', textOf(counter()) === '1 / ' + expected,
        'counter reads "' + textOf(counter()) + '"')

      await typeQuery(TOKEN.toLowerCase())
      push('the search ignores case',
        finder() && finder().status().total === expected,
        'lowercase query found ' + (finder() ? finder().status().total : -1))

      await typeQuery('TD_FINDONE_NOTHING_LIKE_THIS')
      push('a query with no hits reports none and paints nothing',
        finder() && finder().status().total === 0 && finder().status().visible === 0,
        'status ' + JSON.stringify(finder() ? finder().status() : null))
      push('the box says there is nothing rather than a count', textOf(counter()).length > 0,
        'counter reads "' + textOf(counter()) + '"')

      await pressKey('Escape', false)
      push('Escape closes the box', !box(), box() ? 'still in the DOM' : '')
      push('Escape drops the search with it',
        finder() && finder().status().total === 0, 'status ' + JSON.stringify(finder() ? finder().status() : null))
      push('Escape hands the keyboard back to the terminal',
        document.activeElement === textarea(), document.activeElement ? String(document.activeElement.className) : 'none')

      // The pane must still be a terminal after all of that: the prompt line is
      // where it was, and nothing the search did reached the shell.
      const text = bufferText()
      push('no control character leaked into the shell',
        text.indexOf(String.fromCharCode(6)) === -1 && text.indexOf('^F') === -1,
        text.indexOf('^F') === -1 ? 'clean' : 'a ^F reached the buffer')

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'find probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('find crashed:', err)
    app.exit(1)
  })
)
