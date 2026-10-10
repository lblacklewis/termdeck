/**
 * Verification for the credential, theme and appearance work:
 *   1. a password typed in the session editor is saved encrypted, can be
 *      revealed, and is what the connection actually uses
 *   2. the theme picker restyles the app and travels to the terminal
 *   3. the rounded/macOS look is actually in effect (radius tokens applied)
 *
 *   npm run build && electron smoke/ui3.cjs --user-data-dir=...
 */
const path = require('node:path')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const SSH_USER = process.env.TD_SSH_USER || 'root'

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

  // Start from empty stores. This suite asserts which sessions report a stored
  // password and what the editor says about them; a session left by another run
  // pollutes those counts (the store has no `clear`, so it has to go before the
  // first access, which is what constructs it).
  require(path.join(__dirname, 'clearstore.cjs')).resetStores([
    'sessions',
    'layout',
    'settings'
  ])

  const stores = mod.storeAccess()

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

  const consoleErrors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(2500)

  await win.webContents.executeJavaScript(
    `window.termdeck.loadSettings().then(s =>
       window.termdeck.saveSettings({ ...s, hostKeys: { policy: 'trust' } }))`
  )
  await sleep(300)

  // ---- 1. credential saved through the session editor --------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      document.querySelector('[data-testid="tree-new-session"]').click()
      await new Promise((r) => setTimeout(r, 500))

      const f = (label) => document.querySelector('[data-testid="session-drawer"] [aria-label="' + label + '"]')
      const setValue = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      push('no unlock step is required',
        !document.querySelector('[aria-label="vault-master"]') &&
          !document.querySelector('[data-testid="vault-unlock"]'))

      setValue(f('session-name'), 'cred-session')
      setValue(f('session-host'), ${JSON.stringify(SSH_HOST)})
      setValue(f('session-username'), ${JSON.stringify(SSH_USER)})
      await new Promise((r) => setTimeout(r, 200))
      setValue(f('session-password'), 'hunter2-saved')
      await new Promise((r) => setTimeout(r, 300))

      const hint = [...document.querySelectorAll('[data-testid="session-drawer"] .td-hint')]
        .map((n) => n.textContent).join(' ')
      push('editor explains where the password goes',
        /encrypted/i.test(hint), hint.slice(0, 90))

      document.querySelector('[data-testid="session-save"]').click()
      await new Promise((r) => setTimeout(r, 900))
      push('editor closed after saving', !document.querySelector('[data-testid="session-save"]'))

      const tree = await api.loadSessionTree()
      const saved = tree.sessions.find((s) => s.name === 'cred-session')
      push('session saved', !!saved)
      push('tree reports a stored password, not the value',
        saved && saved.hasPassword === true && saved.password === undefined,
        'hasPassword=' + (saved && saved.hasPassword) + ' password=' + (saved && saved.password))

      // Reopening must not expose the value, and must offer to reveal it.
      const row = document.querySelector('.td-node[data-node-id="' + saved.id + '"]')
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-menu-id="edit"]').click()
      await new Promise((r) => setTimeout(r, 600))

      const pw = f('session-password')
      push('reopened editor shows the field empty', pw && pw.value === '',
        pw ? JSON.stringify(pw.value) : 'no field')
      push('reopened editor says a password is saved',
        /one is saved/i.test(document.querySelector('[data-testid="session-drawer"]').textContent || ''))

      const showBtn = [...document.querySelectorAll('[data-testid="session-drawer"] button')]
        .find((b) => /^Show$/.test((b.textContent || '').trim()))
      push('a reveal button is offered', !!showBtn)
      if (showBtn) {
        showBtn.click()
        await new Promise((r) => setTimeout(r, 600))
        push('reveal fetches the stored password', f('session-password').value === 'hunter2-saved',
          JSON.stringify(f('session-password').value))
      }

      // Saving without touching the password must keep it.
      setValue(f('session-name'), 'cred-session-renamed')
      await new Promise((r) => setTimeout(r, 250))
      document.querySelector('[data-testid="session-save"]').click()
      await new Promise((r) => setTimeout(r, 900))

      const after = await api.loadSessionTree()
      const renamed = after.sessions.find((s) => s.name === 'cred-session-renamed')
      push('renaming keeps the stored password', renamed && renamed.hasPassword === true,
        'hasPassword=' + (renamed && renamed.hasPassword))

      return out
    })()`)
  )

  // The stored password must be what the connection uses.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // Swap the stored password to the real one for the test host, then connect
      // from the sidebar: this proves the credential reaches ssh2.
      const tree = await api.loadSessionTree()
      const session = tree.sessions.find((s) => s.name === 'cred-session-renamed')
      await api.saveSession({
        id: session.id,
        host: session.host,
        username: session.username,
        authMethod: 'password',
        credential: { password: 'definitely-wrong-password' }
      })
      await new Promise((r) => setTimeout(r, 600))

      const row = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      row.querySelector('.td-node-main').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )

      // A wrong password must fail with an auth error, not "credential missing":
      // that difference proves the stored value reached the handshake.
      let alert = null
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 300))
        alert = document.querySelector('[data-testid="connect-alert"]')
        if (alert) break
      }
      push('wrong stored password produces an auth failure', !!alert,
        alert ? (alert.querySelector('p') || {}).textContent.slice(0, 80) : 'no alert')
      push('the failure is authentication, not a missing credential',
        !!alert && /Authentication failed/i.test(alert.textContent || ''),
        alert ? (alert.querySelector('p') || {}).textContent.slice(0, 80) : 'n/a')

      return out
    })()`)
  )

  // ---- 2. themes ---------------------------------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      const themeIds = await (async () => {
        const btn = document.querySelector('[data-testid="open-settings"]')
        btn.click()
        await new Promise((r) => setTimeout(r, 600))
        // Scope to the grid: <html> also carries data-theme-id.
        return [...document.querySelectorAll('[data-testid="theme-grid"] .td-theme-card')]
          .map((c) => c.getAttribute('data-theme-id'))
      })()
      push('many themes are offered', themeIds.length >= 8, themeIds.join(','))
      push('theme list has no duplicates',
        new Set(themeIds).size === themeIds.length, themeIds.length + ' ids')

      const measure = () => {
        const root = getComputedStyle(document.documentElement)
        return {
          id: document.documentElement.dataset.themeId,
          scheme: document.documentElement.dataset.themeScheme,
          bg: root.getPropertyValue('--td-bg').trim(),
          accent: root.getPropertyValue('--td-accent').trim()
        }
      }

      const openSettings = async () => {
        document.querySelector('[data-testid="open-settings"]').click()
        await new Promise((r) => setTimeout(r, 600))
      }
      const closeSettings = async () => {
        const foot = [...document.querySelectorAll('[data-testid="settings-drawer"] .td-drawer-actions button')]
        const close = foot.find((b) => /^Close$/.test((b.textContent || '').trim()))
        close.click()
        await new Promise((r) => setTimeout(r, 400))
      }
      const saveSettings = async () => {
        const save = [...document.querySelectorAll('[data-testid="settings-drawer"] .td-drawer-actions button')]
          .find((b) => /Save settings/i.test(b.textContent || ''))
        save.click()
        await new Promise((r) => setTimeout(r, 900))
      }

      /** Preview a theme and save it, leaving the dialog open. */
      const pick = async (id) => {
        document.querySelector('[data-testid="theme-grid"] [data-theme-id="' + id + '"]').click()
        await new Promise((r) => setTimeout(r, 250))
        await saveSettings()
      }

      // --- live preview: picking a theme applies it before saving --------
      await openSettings()
      const storedBefore = (await api.loadSettings()).theme
      const before = measure()
      document.querySelector('[data-testid="theme-grid"] [data-theme-id="midnight"]').click()
      await new Promise((r) => setTimeout(r, 500))
      const previewed = measure()
      push('clicking a theme previews it immediately',
        previewed.id === 'midnight' && previewed.bg !== before.bg,
        before.id + ' -> ' + previewed.id + ' (--td-bg ' + before.bg + ' -> ' + previewed.bg + ')')
      push('a preview badge is shown', !!document.querySelector('[data-testid="theme-previewing"]'))

      const notSavedYet = (await api.loadSettings()).theme
      push('preview did not persist anything', notSavedYet === storedBefore,
        'stored=' + notSavedYet)

      // Closing without saving must put the stored theme back.
      await closeSettings()
      const reverted = measure()
      push('closing without saving reverts the preview', reverted.id === storedBefore,
        'back to ' + reverted.id)
      push('preview badge gone after close',
        !document.querySelector('[data-testid="theme-previewing"]'))

      // --- saving keeps it ----------------------------------------------
      await openSettings()
      await pick('nord')
      const afterNord = measure()
      push('switching theme changes --td-bg', afterNord.bg !== before.bg,
        before.bg + ' -> ' + afterNord.bg)
      push('theme id reaches the document', afterNord.id === 'nord', afterNord.id)

      await pick('termius-light')
      const light = measure()
      push('light theme sets the light scheme flag', light.scheme === 'light', light.scheme)
      const bodyBg = getComputedStyle(document.body).backgroundColor
      push('body actually repaints for the light theme',
        /^rgb\\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\\)$/.test(bodyBg), bodyBg)

      // Every surface token must be light, which is what the earlier bug broke.
      const lightTokens = await (async () => {
        const root = getComputedStyle(document.documentElement)
        const names = ['--td-bg', '--td-bg-raised', '--td-bg-sunken', '--td-surface', '--td-elevated']
        return names.map((n) => [n, root.getPropertyValue(n).trim()])
      })()
      const allLight = lightTokens.every(([, v]) => {
        const hex = v.replace('#', '')
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)
        return (r + g + b) / 3 > 180
      })
      push('every surface token is light in the light theme', allLight,
        lightTokens.map(([n, v]) => n + '=' + v).join(' '))

      await pick('dracula')
      const dark = measure()
      push('switching back restores a dark scheme', dark.scheme === 'dark', dark.scheme)

      // Restore the default so later suites see a predictable theme.
      await pick('termius-dark')

      const settings = await api.loadSettings()
      push('theme choice persisted', settings.theme === 'termius-dark', settings.theme)

      return out
    })()`)
  )

  // ---- 2b. shortcut list: context menu and drag reorder ------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      document.querySelector('[data-testid="open-settings"]').click()
      await new Promise((r) => setTimeout(r, 600))
      const tabBtn = [...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Shortcuts/i.test(t.textContent))
      tabBtn.click()
      await new Promise((r) => setTimeout(r, 400))

      const rows = () => [...document.querySelectorAll('[data-testid="shortcut-list"] [data-binding-id]')]
      const order = () => rows().map((r) => r.getAttribute('data-binding-id'))
      push('shortcut rows rendered', rows().length >= 8, rows().length + ' rows')
      const startOrder = order()

      // --- right-click menu ---------------------------------------------
      const first = rows()[0]
      first.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 300, clientY: 300
      }))
      await new Promise((r) => setTimeout(r, 350))

      const menu = document.querySelector('[data-testid="context-menu"]')
      push('right-click opens a shortcut menu', !!menu)
      if (!menu) return out

      const actions = [...menu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id'))
      push('menu offers rebind/remove/reset/reorder',
        ['rebind', 'clear', 'reset', 'moveUp', 'moveDown'].every((a) => actions.includes(a)),
        actions.join(','))

      // Rebind through the menu arms the recorder.
      menu.querySelector('[data-menu-id="rebind"]').click()
      await new Promise((r) => setTimeout(r, 350))
      const recording = document.querySelector('.td-key-btn.is-recording')
      push('rebind starts recording', !!recording,
        recording ? recording.textContent.trim() : 'no recorder')

      // Press a combination the API can verify.
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'j', ctrlKey: true, altKey: true, bubbles: true
      }))
      await new Promise((r) => setTimeout(r, 350))
      const armed = first.querySelector('.td-key-btn').textContent.trim()
      push('recorded combination is shown', /Ctrl\\+Alt\\+J/i.test(armed), armed)

      // --- reorder via the menu -----------------------------------------
      const second = rows()[1].getAttribute('data-binding-id')
      rows()[1].dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 300, clientY: 320
      }))
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-testid="context-menu"] [data-menu-id="moveUp"]').click()
      await new Promise((r) => setTimeout(r, 400))
      const afterMenuMove = order()
      push('menu reorder moved the row up',
        afterMenuMove[0] === second && afterMenuMove[1] === startOrder[0],
        afterMenuMove.slice(0, 3).join(','))

      // --- drag to reorder ----------------------------------------------
      const beforeDrag = order()
      const src = rows()[0]
      const dst = rows()[2]
      const srcId = src.getAttribute('data-binding-id')
      const dstId = dst.getAttribute('data-binding-id')
      const dt = new DataTransfer()
      const fire = (el, type) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      )
      fire(src, 'dragstart')
      await new Promise((r) => setTimeout(r, 200))
      fire(dst, 'dragover')
      // React commits the highlight on the next tick, so give it one.
      await new Promise((r) => setTimeout(r, 250))
      push('drop target highlighted during drag', dst.classList.contains('is-drop'),
        'classes=' + dst.className)
      fire(dst, 'drop')
      await new Promise((r) => setTimeout(r, 250))
      const orderAfterDrop = order()
      fire(src, 'dragend')
      await new Promise((r) => setTimeout(r, 400))

      const afterDrag = order()
      push('drag reordered the list', afterDrag.indexOf(srcId) > beforeDrag.indexOf(srcId),
        beforeDrag.slice(0, 4).join(',') + '  ->  ' + afterDrag.slice(0, 4).join(','))
      push('order is stable after dragend', orderAfterDrop.join(',') === afterDrag.join(','),
        'afterDrop=' + orderAfterDrop.slice(0, 4).join(',') + ' afterDragEnd=' + afterDrag.slice(0, 4).join(','))

      // --- save and confirm persistence ---------------------------------
      const save = [...document.querySelectorAll('[data-testid="settings-drawer"] .td-drawer-actions button')]
        .find((b) => /Save settings/i.test(b.textContent || ''))
      push('save is enabled after edits', !save.disabled)
      const domOrderAtSave = order()
      const draftOrderAtSave = (window.__tdDraftBindings || []).slice()

      save.click()
      await new Promise((r) => setTimeout(r, 900))

      const stored = await api.loadSettings()
      const storedIds = stored.keybindings.map((b) => b.id)
      push('draft matches the rendered order', draftOrderAtSave.join(',') === domOrderAtSave.join(','),
        'draft=' + draftOrderAtSave.slice(0, 4).join(',') + ' dom=' + domOrderAtSave.slice(0, 4).join(','))
      push('new order persisted', storedIds.join(',') === afterDrag.join(','),
        'dom=' + domOrderAtSave.slice(0, 4).join(',') +
          ' draft=' + draftOrderAtSave.slice(0, 4).join(',') +
          ' saved=' + storedIds.slice(0, 4).join(','))
      const rebound = stored.keybindings.find((b) => b.id === startOrder[0])
      push('recorded binding persisted', /ctrl\\+alt\\+j/i.test(rebound.keys), rebound.keys)

      return out
    })()`)
  )

  // ---- 3. rounded, macOS-leaning styling ---------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const root = getComputedStyle(document.documentElement)
      const radiusWindow = root.getPropertyValue('--td-radius-window').trim()
      const radius = parseInt(root.getPropertyValue('--td-radius').trim(), 10)
      push('corner radius tokens are defined', !!radiusWindow && radius >= 8,
        '--td-radius=' + radius + 'px window=' + radiusWindow)

      const blur = root.getPropertyValue('--td-blur').trim()
      push('a frosted-glass token exists', /blur/.test(blur), blur)

      // The modal must actually be rounded and blurred, not just declared.
      document.querySelector('[data-testid="open-settings"]').click()
      await new Promise((r) => setTimeout(r, 600))
      const modal = document.querySelector('[data-testid="settings-drawer"]')
      const modalStyle = getComputedStyle(modal)
      push('modal has a large radius', parseInt(modalStyle.borderRadius, 10) >= 12,
        modalStyle.borderRadius)
      push('modal has a soft shadow', modalStyle.boxShadow !== 'none',
        modalStyle.boxShadow.slice(0, 42))

      const backdrop = document.querySelector('.td-drawer-backdrop')
      const backdropStyle = getComputedStyle(backdrop)
      push('backdrop uses backdrop-filter', /blur/.test(backdropStyle.backdropFilter || ''),
        backdropStyle.backdropFilter || 'none')

      const closeBtn = document.querySelector('[data-testid="drawer-close"]')
      closeBtn.click()
      await new Promise((r) => setTimeout(r, 300))

      // Controls should be rounder than before (10px is the new default).
      const btn = document.querySelector('.td-sidebar .td-btn')
      push('buttons use the rounded radius', parseInt(getComputedStyle(btn).borderRadius, 10) >= 8,
        getComputedStyle(btn).borderRadius)

      // A terminal should adopt the theme palette.
      const local = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      local.click()
      await new Promise((r) => setTimeout(r, 3000))
      const ids = Object.keys(window.__tdTerminals || {})
      push('terminal opened for palette check', ids.length > 0, ids.length + ' terminal(s)')
      if (ids.length > 0) {
        const term = window.__tdTerminals[ids[0]].term
        const theme = term.options.theme || {}
        push('terminal painted with the theme background',
          /^#/.test(theme.background || ''), 'background=' + theme.background)
        push('terminal palette has ANSI colours',
          !!theme.red && !!theme.brightBlue, theme.red + '/' + theme.brightBlue)
      }

      return out
    })()`)
  )

  if (consoleErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of consoleErrors.slice(0, 12)) console.log('  ' + e)
  }

  void stores
  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('ui3 probe crashed:', err)
    app.exit(1)
  })
)
