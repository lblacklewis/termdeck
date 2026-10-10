/**
 * Regression coverage for four reported issues:
 *
 *   1. a saved session with no password used to dead-end with "edit the session";
 *      it must now prompt for the password and offer to save it
 *   2. "New session" must live with the session list, not in the sidebar actions
 *   3. the shortcut list's right-click menu did nothing (modal closed on mousedown
 *      before the item's click could fire)
 *   4. the snippet bar could be hidden but not shown again (pointer-events: none)
 *
 *   npm run build && electron smoke/ui4.cjs --user-data-dir=...
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

/**
 * Run one probe section. A section that throws is reported as a single failure
 * instead of taking the whole run down and hiding everything after it.
 */
async function section(name, promise) {
  try {
    report(await promise)
  } catch (err) {
    const detail = String((err && err.message) || err)
    report([{ name: name + ' section', ok: false, detail }])
  }
}

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  // Wipe the profile before anything constructs a store. The stores cache
  // their contents in memory, so deleting their files afterwards leaves the
  // previous run's data in place and the next write puts it back on disk.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  mod.registerIpc()

  // Start from empty stores: this suite is about saved sessions with and without
  // stored credentials, and inheriting a session from another run changes what it
  // finds on the first screen.
  require(path.join(__dirname, 'clearstore.cjs')).resetStores([
    'sessions',
    'layout',
    'settings'
  ])

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

  // ---- 1. sidebar layout -------------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const actions = [...document.querySelectorAll('.td-sidebar-actions .td-btn')]
        .map((b) => b.textContent.trim())
      push('sidebar actions no longer hold New session',
        !actions.some((t) => /New session/i.test(t)), actions.join(' | '))

      const toolbar = document.querySelector('.td-tree-toolbar')
      push('sessions header exists', !!toolbar)
      const newBtn = document.querySelector('[data-testid="tree-new-session"]')
      push('New session button is in the sessions header', !!newBtn,
        toolbar ? toolbar.textContent.trim() : 'no toolbar')

      // It must actually open the editor, at the root.
      newBtn.click()
      await new Promise((r) => setTimeout(r, 500))
      push('it opens the session editor',
        !!document.querySelector('[data-testid="session-save"]'))
      const folder = document.querySelector('[data-testid="session-form"] [aria-label="session-folder"]')
      push('new session defaults to the root folder', folder && folder.value === '',
        folder ? JSON.stringify(folder.value) : 'no select')
      const cancel = [...document.querySelectorAll('[data-testid="session-form"] button')]
        .find((b) => /^Cancel$/.test((b.textContent || '').trim()))
      cancel.click()
      await new Promise((r) => setTimeout(r, 300))

      return out
    })()`)
  )

  // ---- 2. password prompt ------------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // A saved session with password auth and nothing stored.
      const tree = await api.saveSession({
        name: 'needs-password', host: ${JSON.stringify(SSH_HOST)}, port: 22,
        username: ${JSON.stringify(SSH_USER)}, authMethod: 'password', tags: []
      })
      const session = tree.sessions.find((s) => s.name === 'needs-password')
      await new Promise((r) => setTimeout(r, 600))

      const row = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      push('session row rendered', !!row)
      row.querySelector('.td-node-main').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )

      // The old behaviour was an alert telling the user to edit the session.
      let prompt = null
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        prompt = document.querySelector('[data-testid="password-prompt"]')
        if (prompt) break
      }
      push('connecting without a password opens a prompt', !!prompt,
        prompt ? 'prompt shown' : 'still no prompt')
      push('no dead-end alert is shown',
        !document.querySelector('[data-testid="connect-alert"]'))
      if (!prompt) return out

      push('prompt names the session',
        /needs-password/.test(prompt.textContent || ''),
        prompt.querySelector('strong') ? prompt.querySelector('strong').textContent : 'n/a')
      push('prompt offers to save the password',
        !!prompt.querySelector('[aria-label="prompt-remember"]'))
      push('save is the default',
        prompt.querySelector('[aria-label="prompt-remember"]').checked === true)

      const pw = prompt.querySelector('[aria-label="prompt-password"]')
      push('password field starts empty', pw.value === '')
      push('connect is disabled until something is typed',
        prompt.querySelector('[data-testid="prompt-connect"]').disabled === true)

      const setValue = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      // Submitting must reach the handshake: a wrong password proves the value
      // travelled, because the failure becomes an authentication error.
      setValue(pw, 'definitely-not-the-password')
      await new Promise((r) => setTimeout(r, 250))
      prompt.querySelector('[data-testid="prompt-connect"]').click()

      let alert = null
      for (let i = 0; i < 70; i++) {
        await new Promise((r) => setTimeout(r, 300))
        alert = document.querySelector('[data-testid="connect-alert"]')
        if (alert) break
      }
      push('submitted password is used by the handshake', !!alert,
        alert ? alert.querySelector('p').textContent.slice(0, 70) : 'no alert')
      push('failure is an authentication rejection, not a missing credential',
        !!alert && /Authentication failed/i.test(alert.textContent || ''),
        alert ? alert.querySelector('p').textContent.slice(0, 70) : 'n/a')

      // The password was remembered (checkbox was on), so the next attempt uses
      // the stored value rather than prompting again.
      const afterSave = await api.loadSessionTree()
      const updated = afterSave.sessions.find((s) => s.id === session.id)
      push('remembering the password stored it', updated.hasPassword === true,
        'hasPassword=' + updated.hasPassword)

      // --- retry affordance on the alert ---------------------------------
      const retry = alert.querySelector('[data-testid="alert-enter-password"]')
      push('failure alert offers a password retry', !!retry)
      if (retry) {
        retry.click()
        await new Promise((r) => setTimeout(r, 500))
        const again = document.querySelector('[data-testid="password-prompt"]')
        push('retry reopens the prompt', !!again)
        push('retry prompt is labelled as a rejection',
          !!again && /rejected/i.test(again.querySelector('h2').textContent || ''),
          again ? again.querySelector('h2').textContent : 'n/a')
        const cancel2 = [...again.querySelectorAll('button')]
          .find((b) => /^Cancel$/.test((b.textContent || '').trim()))
        cancel2.click()
        await new Promise((r) => setTimeout(r, 300))
        push('prompt is dismissible', !document.querySelector('[data-testid="password-prompt"]'))
      }

      return out
    })()`)
  )

  // ---- 3. shortcut context menu actually acts ----------------------------

  await section('shortcut menu', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))

      // Wait for an element rather than assuming a delay, and fail with a name
      // instead of "undefined.click".
      const waitFor = async (selector, timeout = 5000) => {
        const deadline = Date.now() + timeout
        while (Date.now() < deadline) {
          const el = document.querySelector(selector)
          if (el) return el
          await wait(100)
        }
        return null
      }

      // Open settings from the rail: the sidebar button only exists on the
      // terminal page, and this section may run from any page.
      const railSettings = await waitFor('[data-testid="rail-settings"]')
      push('settings rail entry present', !!railSettings)
      railSettings.click()

      const drawer = await waitFor('[data-testid="settings-drawer"]')
      push('settings drawer opened', !!drawer)
      const tab = await waitFor('.td-settings-tab')
      push('settings tabs rendered', !!tab)
      ;[...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Shortcuts/i.test(t.textContent)).click()
      await wait(400)

      const rows = () => [...document.querySelectorAll('[data-testid="shortcut-list"] [data-binding-id]')]
      const targetId = rows()[0].getAttribute('data-binding-id')
      const before = (await api.loadSettings()).keybindings.find((b) => b.id === targetId).keys

      // This is the exact interaction that used to do nothing.
      rows()[0].dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 320, clientY: 320
      }))
      await new Promise((r) => setTimeout(r, 400))
      const menu = document.querySelector('[data-testid="context-menu"]')
      push('menu opens', !!menu)
      if (!menu) return out

      // Click the way a user does: mousedown then mouseup/click on the item.
      const item = menu.querySelector('[data-menu-id="clear"]')
      push('menu item present', !!item)
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      item.click()
      await new Promise((r) => setTimeout(r, 500))

      push('settings dialog stayed open after using the menu',
        !!document.querySelector('.td-settings'))
      push('menu closed after the action',
        !document.querySelector('[data-testid="context-menu"]'))

      const cleared = rows()[0].querySelector('.td-key-btn').textContent.trim()
      push('the action actually applied (shortcut cleared)',
        /Not set/i.test(cleared), before + ' -> ' + cleared)

      // Persist and confirm, so we know it is not just a visual change.
      const save = [...document.querySelectorAll('.td-drawer-actions button')]
        .find((b) => /Save settings/i.test(b.textContent || ''))
      push('save control present', !!save)
      save.click()
      await new Promise((r) => setTimeout(r, 900))
      const stored = (await api.loadSettings()).keybindings.find((b) => b.id === targetId)
      push('cleared shortcut persisted as empty', stored.keys === '',
        JSON.stringify(stored.keys))

      const close = [...document.querySelectorAll('.td-drawer-actions button')]
        .find((b) => /^Close$/.test((b.textContent || '').trim()))
      close.click()
      await new Promise((r) => setTimeout(r, 400))

      return out
    })()`)
  )

  // ---- 4. snippet bar hide / show ----------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const barVisible = () => !!document.querySelector('[data-testid="snippet-bar"]')
      const hideBtn = () => {
        const bar = document.querySelector('[data-testid="snippet-bar"]')
        return bar
          ? [...bar.querySelectorAll('.td-snippet-actions button')].pop()
          : null
      }

      push('snippet bar starts visible', barVisible())
      const hider = hideBtn()
      push('hide control present', !!hider)
      hider.click()
      await new Promise((r) => setTimeout(r, 400))
      push('bar hides', !barVisible())

      // The exact bug: this button was unclickable because of pointer-events.
      const restore = document.querySelector('.td-snippet-restore')
      push('restore control rendered', !!restore)
      if (!restore) return out
      const cs = getComputedStyle(restore)
      push('restore control accepts pointer events',
        cs.pointerEvents !== 'none', 'pointer-events=' + cs.pointerEvents)

      restore.click()
      await new Promise((r) => setTimeout(r, 400))
      push('bar comes back', barVisible())

      // Round-trip once more to be sure it is not a one-off.
      hideBtn().click()
      await new Promise((r) => setTimeout(r, 350))
      const restore2 = document.querySelector('.td-snippet-restore')
      restore2.click()
      await new Promise((r) => setTimeout(r, 350))
      push('hide/show round-trips reliably', barVisible())

      // The sidebar keyboard shortcut must do the same thing.
      const toggle = document.querySelector('[data-testid="toggle-snippets"]')
      toggle.click()
      await new Promise((r) => setTimeout(r, 350))
      push('sidebar toggle hides it', !barVisible())
      const restore3 = document.querySelector('.td-snippet-restore')
      restore3.click()
      await new Promise((r) => setTimeout(r, 350))
      push('restore works after toggling from the sidebar', barVisible())

      return out
    })()`)
  )

  if (consoleErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of consoleErrors.slice(0, 12)) console.log('  ' + e)
  }

  void os
  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('ui4 probe crashed:', err)
    app.exit(1)
  })
)
