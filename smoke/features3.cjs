/**
 * Coverage for the appearance and broadcast features:
 *   1. the font picker lists real installed fonts and applies the choice
 *   2. the cursor blink is slower than xterm's built-in flicker
 *   3. broadcast input reaches every pane, and only when enabled
 *
 *   npm run build && electron smoke/features3.cjs --user-data-dir=...
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
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  require(path.join(__dirname, 'clearstore.cjs')).resetStores(['sessions', 'settings'])
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

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 20000)
        while (Date.now() < end) {
          if (fn()) return true
          await wait(200)
        }
        return false
      }
      const api = window.termdeck

      // ---- 1. font picker -------------------------------------------------
      const fonts = await api.listFonts()
      push('installed fonts were enumerated', fonts.monospace.length > 5,
        fonts.monospace.length + ' monospaced, ' + fonts.others.length + ' others')
      push('known monospaced families are found',
        fonts.monospace.some((f) => /consol|cascadia|mono/i.test(f)),
        JSON.stringify(fonts.monospace.slice(0, 6)))

      document.querySelector('[data-testid="open-settings"]').click()
      await waitFor(() => document.querySelector('[data-testid="settings-drawer"]'))
      await wait(500)
      ;[...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Terminal/i.test(t.textContent)).click()
      await waitFor(() => document.querySelector('[data-testid="font-picks"]'))
      await wait(400)

      const picks = [...document.querySelectorAll('[data-testid="font-picks"] [data-font]')]
      push('the picker offers font chips', picks.length >= 5, picks.length + ' chips')
      push('each chip renders in its own font',
        picks.slice(0, 3).every((c) => (c.style.fontFamily || '').includes(c.getAttribute('data-font'))),
        picks.slice(0, 3).map((c) => c.getAttribute('data-font')).join(', '))

      const field = document.querySelector('[aria-label="font-family"]')
      push('the font field shows the primary family only',
        !!field && !field.value.includes(','),
        JSON.stringify(field ? field.value : null))

      // Choosing a font must change the setting and keep the fallback stack.
      const target = picks.find((c) => /consol/i.test(c.getAttribute('data-font')))
        || picks[0]
      const chosen = target.getAttribute('data-font')
      target.click()
      await wait(600)
      const saveBtn = [...document.querySelectorAll('.td-drawer-actions button')]
        .find((b) => /Save settings/i.test(b.textContent || ''))
      saveBtn.click()
      await wait(1200)
      const saved = await api.loadSettings()
      push('choosing a font updates the setting',
        saved.terminal.fontFamily.includes(chosen),
        JSON.stringify(saved.terminal.fontFamily))
      push('the fallback stack is preserved',
        /monospace/.test(saved.terminal.fontFamily) && saved.terminal.fontFamily.includes(','),
        'still ends in a generic family')

      // The live preview must use the chosen family.
      const preview = document.querySelector('[data-testid="font-preview"]')
      push('there is a live preview', !!preview)
      if (preview) {
        push('the preview uses the chosen family',
          (preview.style.fontFamily || '').includes(chosen),
          preview.style.fontFamily)
      }

      // ---- 3. broadcast input ---------------------------------------------
      const localBtn = () => [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      const panels = () => window.__tdDockApi.panels.length

      const openShell = async () => {
        const before = panels()
        localBtn().click()
        await waitFor(() => panels() > before)
        await wait(1600)
      }
      await openShell()
      await openShell()
      push('two panes are open for the broadcast test', panels() >= 2,
        'panels=' + panels())

      // ---- 2. cursor blink (needs a pane, so it runs after the panes open) --
      const paneHosts = () => [...document.querySelectorAll('.td-terminal-host')]
      const blinkHost = () =>
        paneHosts().find((h) => h.getAttribute('data-cursor-blink') === 'on') ||
        paneHosts()[0] ||
        null

      // The rule must exist and use the variable the pane sets; this is the part
      // that makes the rate ours rather than xterm's built-in flicker.
      const blinkRule = [...document.styleSheets]
        .flatMap((s) => { try { return [...s.cssRules] } catch { return [] } })
        .find((r) => r.cssText && r.cssText.includes('td-cursor-blink') && r.cssText.includes('animation'))
      push('a blink animation rule exists', !!blinkRule,
        blinkRule ? blinkRule.cssText.slice(0, 120) : 'not found')

      const blinkSetting = saved.terminal.cursorBlinkMs
      push('the default blink is slower than xterm built-in (~500ms)',
        blinkSetting >= 700, blinkSetting + 'ms')

      {
        const host = blinkHost()
        push('the pane applies the blink rate from settings',
          !!host && host.getAttribute('data-cursor-blink') === 'on' &&
            (host.style.getPropertyValue('--td-cursor-blink-duration') || '').length > 0,
          JSON.stringify({
            hosts: paneHosts().length,
            blink: host ? host.getAttribute('data-cursor-blink') : null,
            duration: host ? host.style.getPropertyValue('--td-cursor-blink-duration') : null
          }))
      }

      // Turning blink off must clear the animation rather than leave a static one.
      {
        const s = await api.loadSettings()
        await api.saveSettings({ ...s, terminal: { ...s.terminal, cursorBlink: false } })
        await wait(1300)
        const host = blinkHost()
        push('blinking can be turned off',
          !!host && host.getAttribute('data-cursor-blink') !== 'on',
          host ? 'blink=' + host.getAttribute('data-cursor-blink') : 'no host')
        // Restore for the rest of the run.
        await api.saveSettings({ ...s, terminal: { ...s.terminal, cursorBlink: true } })
        await wait(900)
      }

      const ids = window.__tdDockApi.panels.map((p) => p.id)
      const textFor = (id) => {
        const entry = window.__tdTerminals ? window.__tdTerminals[id] : null
        if (!entry || !entry.term) return ''
        const buf = entry.term.buffer.active
        const lines = []
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i)
          if (line) lines.push(line.translateToString(true))
        }
        return lines.join('\\n')
      }

      // Typing goes through term.onData, so the test must too. writeSession
      // goes straight over IPC and would bypass broadcast entirely — a test using
      // it would pass while the feature was broken. term.paste feeds the same
      // input handler that real keystrokes use.
      const typeInto = (id, text) => {
        const entry = window.__tdTerminals ? window.__tdTerminals[id] : null
        if (!entry || !entry.term) throw new Error('no terminal for ' + id)
        // A carriage return submits the line in this shell.
        entry.term.paste(text + String.fromCharCode(13))
      }

      const toggle = document.querySelector('[data-testid="toggle-broadcast"]')
      push('a broadcast button is present', toggle)
      push('broadcast starts off', toggle && toggle.getAttribute('aria-pressed') === 'false',
        toggle ? 'aria-pressed=' + toggle.getAttribute('aria-pressed') : 'no button')

      // With it OFF, typing in one pane must not reach the other.
      const soloMarker = 'SOLO_' + Date.now()
      typeInto(ids[0], 'echo ' + soloMarker)
      await wait(3000)
      push('with broadcast off only the typed-in pane receives input',
        textFor(ids[0]).includes(soloMarker) && !textFor(ids[1]).includes(soloMarker),
        'pane0=' + textFor(ids[0]).includes(soloMarker) +
          ' pane1=' + textFor(ids[1]).includes(soloMarker))

      // Turn it on through the real button.
      toggle.click()
      await wait(600)
      push('the button reports broadcast on',
        document.querySelector('[data-testid="toggle-broadcast"]').getAttribute('aria-pressed') === 'true')

      const bothMarker = 'BOTH_' + Date.now()
      typeInto(ids[0], 'echo ' + bothMarker)
      await wait(3500)
      const p0 = textFor(ids[0]).includes(bothMarker)
      const p1 = textFor(ids[1]).includes(bothMarker)
      push('with broadcast on typing reaches the other pane', p1,
        JSON.stringify({ pane0: p0, pane1: p1 }))
      // The source pane must receive it exactly once, not twice.
      const twice = (textFor(ids[0]).match(new RegExp(bothMarker, 'g')) || []).length
      push('the typed-in pane does not receive the input twice', twice <= 2,
        twice + ' occurrence(s) — 2 is input plus the echoed output')

      // Turning it off again must stop the fan-out.
      document.querySelector('[data-testid="toggle-broadcast"]').click()
      await wait(600)
      const afterMarker = 'AFTER_' + Date.now()
      typeInto(ids[0], 'echo ' + afterMarker)
      await wait(3000)
      push('turning broadcast off stops the fan-out',
        textFor(ids[0]).includes(afterMarker) && !textFor(ids[1]).includes(afterMarker),
        'pane1 has it=' + textFor(ids[1]).includes(afterMarker))

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'appearance probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('appearance probe crashed:', err)
    app.exit(1)
  })
)
