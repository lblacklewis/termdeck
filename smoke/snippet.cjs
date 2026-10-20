/**
 * Coverage for sending a saved command.
 *
 *   npm run build && electron smoke/snippet.cjs --user-data-dir=...
 *
 * The rule under test: a snippet is sent EXACTLY as written. It is only executed
 * if the user's own text ends with a line break. Nothing is appended.
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
  // Wipe the profile before anything constructs a store. The stores cache
  // their contents in memory, so deleting their files afterwards leaves the
  // previous run's data in place and the next write puts it back on disk.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  mod.registerIpc()
  // Start from empty stores: snippets live in settings and this suite asserts on
  // the exact set of them.
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
      nodeIntegration: false,
      // An occluded renderer is throttled and then serves stale computed styles
      // (and never paints), which reads as a 65px pane in a 100x100 grid. See
      // docs/项目会话总结.md.
      backgroundThrottling: false
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
        const end = Date.now() + (timeout || 15000)
        while (Date.now() < end) {
          if (fn()) return true
          await wait(200)
        }
        return false
      }
      const api = window.termdeck

      const localBtn = document.querySelector('[data-testid="local-shell"]')
      push('local shell button present', localBtn)
      if (!localBtn) return out
      localBtn.click()

      // Wait for real output, not just for the element to exist.
      let ready = false
      for (let i = 0; i < 60; i++) {
        await wait(250)
        const rows = document.querySelector('.xterm-rows')
        if (rows && (rows.textContent || '').length > 0) { ready = true; break }
      }
      push('a local shell produced a prompt', ready)
      if (!ready) return out
      await wait(1000)

      const sessionId = window.__tdDockApi.activePanel
        ? window.__tdDockApi.activePanel.id
        : null
      push('a session is active', !!sessionId)
      if (!sessionId) return out

      /** The whole buffer of the active session. */
      const bufferText = () => {
        const entry = window.__tdTerminals ? window.__tdTerminals[sessionId] : null
        if (!entry || !entry.term) return ''
        const buf = entry.term.buffer.active
        const lines = []
        for (let i = 0; i < buf.length; i++) {
          const line = buf.getLine(i)
          if (line) lines.push(line.translateToString(true))
        }
        return lines.join('\\n')
      }

      // Control: a direct write must reach the terminal. If this fails the
      // harness is wrong, not the feature.
      const control = 'CONTROL_' + Date.now()
      await api.writeSession(sessionId, 'echo ' + control + '\\r\\n')
      const controlArrived = await waitFor(() => bufferText().includes(control))
      push('control: a direct write reaches the terminal', controlArrived,
        JSON.stringify(bufferText().slice(-50)))
      if (!controlArrived) return out

      // ---- 1. no trailing line break: typed, not executed -------------------
      const typedMarker = 'SNIP_TYPED_' + Date.now()
      await api.saveSnippet({ label: 'typed-only', command: 'echo ' + typedMarker, group: 'snip' })
      await wait(900)
      const typedBtn = document.querySelector('[data-snippet-label="typed-only"]')
      push('the snippet button rendered', typedBtn)
      if (!typedBtn) return out
      push('the snippet button is enabled with an active terminal', !typedBtn.disabled)

      typedBtn.click()
      await waitFor(() => bufferText().includes(typedMarker), 6000)
      const afterTyped = bufferText()
      push('text with no line break is typed into the prompt',
        afterTyped.includes(typedMarker),
        JSON.stringify({ tail: afterTyped.slice(-70) }))

      // The marker must appear exactly once: the typed input, with no shell echo
      // of a command output. Two occurrences would mean it ran.
      const typedCount = (afterTyped.match(new RegExp(typedMarker, 'g')) || []).length
      push('text with no line break is NOT executed', typedCount === 1,
        typedCount + ' occurrence(s) — 1 means typed only')

      // ---- 2. trailing line break: executes ---------------------------------
      const runMarker = 'SNIP_RUN_' + Date.now()
      await api.saveSnippet({
        label: 'run-it',
        command: 'echo ' + runMarker + '\\r\\n',
        group: 'snip'
      })
      await wait(900)

      const stored = (await api.loadSettings()).snippets.find((s) => s.label === 'run-it')
      push('the stored command keeps its trailing line break',
        !!stored && /[\\r\\n]$/.test(stored.command), JSON.stringify(stored && stored.command))

      const runBtn = document.querySelector('[data-snippet-label="run-it"]')
      push('the second snippet button rendered', runBtn)
      if (runBtn) {
        // Counting occurrences is timing-dependent: the echoed input can scroll
        // out of the buffer. A prompt appearing *after* the marker is the
        // definitive sign that the shell received and ran the line.
        runBtn.click()
        const promptFollowed = await waitFor(() => {
          const text = bufferText()
          // trimEnd already removes the padding, so the check is just "does it
          // now end at a prompt character". No whitespace escape here: the
          // injected template would eat the backslash and leave a different regex.
          return text.includes(runMarker) && /[$#>]$/.test(text.trimEnd())
        }, 10000)
        const afterRun = bufferText()
        const idx = afterRun.indexOf(runMarker)
        push('text ending in a line break IS executed', promptFollowed,
          JSON.stringify({
            context: idx >= 0 ? afterRun.slice(idx, idx + 90) : 'marker absent',
            endsWithPrompt: /[$#>]$/.test(afterRun.trimEnd())
          }))
      }

      // ---- 3. multi-line command is preserved verbatim ----------------------
      const lineA = 'SNIP_A_' + Date.now()
      const lineB = 'SNIP_B_' + Date.now()
      await api.saveSnippet({
        label: 'two-lines',
        command: 'echo ' + lineA + '\\r\\necho ' + lineB + '\\r\\n',
        group: 'snip'
      })
      await wait(900)
      const multiBtn = document.querySelector('[data-snippet-label="two-lines"]')
      if (multiBtn) {
        multiBtn.click()
        await waitFor(
          () => bufferText().includes(lineA) && bufferText().includes(lineB),
          8000
        )
        const afterMulti = bufferText()
        push('a multi-line command runs both lines',
          afterMulti.includes(lineA) && afterMulti.includes(lineB),
          'A=' + afterMulti.includes(lineA) + ' B=' + afterMulti.includes(lineB))
      }

      /*
       * ---- the keyboard comes back to the pane ------------------------------
       *
       * Reaching for a snippet happens in the middle of typing, so focus has to end
       * up back in the terminal — in the pane the command went to, whatever the
       * click did to the caret.
       */
      const focusMarker = 'focus-' + String(Date.now()).slice(-6)
      await api.saveSnippet({
        label: 'focus-check',
        command: 'echo ' + focusMarker + String.fromCharCode(13),
        group: 'snip'
      })
      await waitFor(() => !!document.querySelector('[data-snippet-label="focus-check"]'), 5000)
      const focusEntry = window.__tdTerminals[Object.keys(window.__tdTerminals).pop()]
      focusEntry.term.focus()
      await wait(400)
      const focusedBefore = !!document.activeElement && !!document.activeElement.closest('.xterm')
      const focusBtn = document.querySelector('[data-snippet-label="focus-check"]')
      if (focusBtn) {
        focusBtn.click()
        await waitFor(() => bufferText().includes(focusMarker), 8000)
      }
      const focusedAfter = !!document.activeElement && !!document.activeElement.closest('.xterm')
      push('the terminal has the keyboard before a snippet is clicked', focusedBefore,
        'active=' + (document.activeElement ? document.activeElement.className : 'none'))
      push('and gets it back after, so typing can continue',
        focusedAfter && bufferText().includes(focusMarker),
        'active=' + (document.activeElement ? document.activeElement.className : 'none') +
          ' ran=' + bufferText().includes(focusMarker))

      // ---- a snippet can carry its own shortcut -----------------------------
      const hotkeyMarker = 'hotkey-' + String(Date.now()).slice(-6)
      const withKey = await api.saveSnippet({
        label: 'hotkey-run',
        command: 'echo ' + hotkeyMarker + String.fromCharCode(13),
        group: 'snip',
        keys: 'Ctrl+Shift+U'
      })
      const keyed = withKey.snippets.find((s) => s.label === 'hotkey-run')
      push('a shortcut is stored on the snippet', !!keyed && keyed.keys === 'Ctrl+Shift+U',
        JSON.stringify(keyed && keyed.keys))
      await wait(700)
      const beforeHotkey = bufferText().includes(hotkeyMarker)
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'U', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
        })
      )
      await waitFor(() => bufferText().includes(hotkeyMarker), 8000)
      push('pressing it runs the snippet', !beforeHotkey && bufferText().includes(hotkeyMarker),
        'ran=' + bufferText().includes(hotkeyMarker))

      /*
       * ---- a conflicting shortcut is refused --------------------------------
       *
       * Ctrl+T is New connection by default, so binding a snippet to it is exactly
       * the mistake the check exists for: both are matched by the same dispatcher,
       * and whichever came first in the list would win, silently.
       */
      document.querySelector('[data-testid="rail-settings"]').click()
      await waitFor(() => !!document.querySelector('.td-settings'), 6000)
      const shortcutsTab = [...document.querySelectorAll('.td-settings-tab')]
        .find((el) => /Shortcut/i.test(el.textContent))
      shortcutsTab.click()
      await wait(400)
      push('snippet shortcuts are listed beside the others',
        !!document.querySelector('[data-testid="snippet-shortcut-list"]'))
      const keyBtn = document.querySelector('[data-testid="snippet-binding-' + (keyed ? keyed.id : '') + '"]')
      push('and each snippet row has its own recorder', !!keyBtn)
      if (keyBtn) {
        keyBtn.click()
        await wait(250)
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true })
        )
        await wait(450)
        const bannerText = [...document.querySelectorAll('.td-form-error')]
          .map((el) => el.textContent || '')
          .join(' | ')
        // The banner lower-cases the chord it reports, so compare that way.
        const banner = bannerText.toLowerCase()
        push('a clash with a built-in is reported, naming both sides',
          banner.includes('ctrl+t') && /New connection/i.test(bannerText) &&
            /hotkey-run/i.test(bannerText),
          bannerText.slice(0, 200))
        push('and the row itself is marked', keyBtn.className.includes('is-conflict'),
          keyBtn.className)

        document.querySelector('[data-testid="settings-save"]').click()
        await wait(600)
        const stillOpen = !!document.querySelector('.td-settings')
        push('saving is refused while the clash stands', stillOpen,
          'open=' + stillOpen)

        // Clearing it removes the warning, so the block is not a dead end.
        const clearBtn = keyBtn.parentElement.querySelector('.td-mini')
        if (clearBtn) clearBtn.click()
        await wait(450)
        push('removing the duplicate clears the warning',
          document.querySelectorAll('.td-key-btn.is-conflict').length === 0,
          'marked=' + document.querySelectorAll('.td-key-btn.is-conflict').length)
      }
      const closeSettings = [...document.querySelectorAll('.td-drawer button')]
        .find((b) => /Close/i.test((b.textContent || '').trim()))
      if (closeSettings) closeSettings.click()
      await wait(400)

      // Clean up.
      const settings = await api.loadSettings()
      for (const s of settings.snippets.filter((x) => x.group === 'snip')) {
        await api.deleteSnippet(s.id)
      }

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'snippet probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('snippet probe crashed:', err)
    app.exit(1)
  })
)
