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
        const end = Date.now() + (timeout || 15000)
        while (Date.now() < end) {
          if (fn()) return true
          await wait(200)
        }
        return false
      }
      const api = window.termdeck

      const localBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
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
          return text.includes(runMarker) && /[>$#]\s*$/.test(text.trimEnd())
        }, 10000)
        const afterRun = bufferText()
        const idx = afterRun.indexOf(runMarker)
        push('text ending in a line break IS executed', promptFollowed,
          JSON.stringify({
            context: idx >= 0 ? afterRun.slice(idx, idx + 90) : 'marker absent',
            endsWithPrompt: /[>$#]\s*$/.test(afterRun.trimEnd())
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
