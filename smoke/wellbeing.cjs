/**
 * The break reminder (with its game) and the lock screen.
 *
 *   npm run build && electron smoke/wellbeing.cjs --user-data-dir=...
 *
 * Both are nothing but UI, so the checks are about what the user ends up seeing:
 * the reminder arrives with a playable canvas, finishing the run is what clears
 * it, the lock screen genuinely covers the panes (a hit test, not just an element
 * in the DOM), a wrong password is refused, and a lock with no password opens on
 * one click.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
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

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  win.webContents.on('console-message', (_e, level, message, line) => {
    if (level >= 2) console.log(`[renderer] ${message} @${line}`)
  })
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          const v = await fn()
          if (v) return true
          await wait(200)
        }
        return false
      }
      const openSettings = async (tab) => {
        const btn = document.querySelector('[data-testid="open-settings"]')
        if (!btn) return false
        btn.click()
        await wait(500)
        const tabBtn = [...document.querySelectorAll('.td-settings-tab')]
          .find((t) => (t.textContent || '').trim() === tab)
        if (!tabBtn) return false
        tabBtn.click()
        await wait(400)
        return true
      }
      const closeSettings = async () => {
        // The drawer has its own header button; it is not a ModalShell backdrop,
        // and clicking the wrong thing here left the drawer open over the lock.
        const close = document.querySelector('[data-testid="drawer-close"]')
        if (close) close.click()
        await wait(500)
      }
      /*
       * Everything about the lock is scoped to the lock screen.
       *
       * The settings tab has an input with the same aria-label, so an unscoped
       * query finds that one instead once the drawer has been open — the repo's
       * own rule: a probe names the element it means.
       */
      const lockEl = () => document.querySelector('[data-testid="lock-screen"]')
      const lockInput = () => lockEl()?.querySelector('[aria-label="lock-password"]')
      const lockButton = () => lockEl()?.querySelector('[data-testid="lock-unlock"]')
      let step = 'start'
      try {

      // A live terminal, so "the lock covers the panes" means something.
      const shellBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      if (shellBtn) shellBtn.click()
      const live = await waitFor(async () => (await window.termdeck.listSessions()).length > 0, 15000)
      push('a terminal is open behind the overlays', live)

      // ---- 1. the break reminder -----------------------------------------
      step = 'break'
      const settingsOpen = await openSettings('Wellbeing')
      push('settings has a Wellbeing tab', settingsOpen)
      const tab = document.querySelector('[data-testid="wellbeing-tab"]')
      push('the break reminder can be turned on', !!document.querySelector('[aria-label="break-enabled"]'))

      const minutes = document.querySelector('[aria-label="break-minutes"]')
      if (minutes) {
        // React tracks the value, so set it through the native setter.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(minutes, '20')
        minutes.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(200)
      }
      const enabled = document.querySelector('[aria-label="break-enabled"]')
      if (enabled && !enabled.checked) {
        enabled.click()
        await wait(200)
      }
      const save = document.querySelector('[data-testid="settings-save"]')
      if (save) save.click()
      await wait(700)
      const stored = await window.termdeck.loadSettings()
      push('the reminder settings are saved',
        stored.break.enabled === true && stored.break.minutes === 20,
        JSON.stringify(stored.break))

      await openSettings('Wellbeing')
      const preview = document.querySelector('[data-testid="break-preview"]')
      push('the reminder can be tried immediately', !!preview)
      if (preview) preview.click()
      const raised = await waitFor(() => !!document.querySelector('[data-testid="break-reminder"]'), 5000)
      push('the reminder appears', raised)
      const reminderText = document.querySelector('[data-testid="break-reminder"]')?.innerText || ''
      push('it explains how long you have been working', /20 minutes/.test(reminderText),
        JSON.stringify(reminderText.slice(0, 90)))

      const play = document.querySelector('[data-testid="break-play"]')
      push('it offers the game', !!play)
      if (play) play.click()
      const canvas = await waitFor(() => !!document.querySelector('[data-testid="break-game"]'), 5000)
      push('playing shows the game canvas', canvas)
      const size = document.querySelector('[data-testid="break-game"]')?.getBoundingClientRect()
      push('the canvas is a real, visible game view',
        !!size && size.width > 300 && size.height > 100,
        size ? Math.round(size.width) + 'x' + Math.round(size.height) : 'none')

      // Real input first: holding right must move the player.
      const game = window.__tdBreakGame
      const startX = game ? game.state().x : -1
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await wait(700)
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
      const movedX = game ? game.state().x : -1
      push('the arrow keys move the player', movedX > startX, 'x ' + startX + ' -> ' + movedX)

      // Then finish it: a probe cannot hold a key for thirty seconds, and "the
      // run is what clears the reminder" is the assertion that matters.
      if (game) game.finish()
      const cleared = await waitFor(() => !document.querySelector('[data-testid="break-reminder"]'), 6000)
      push('finishing the run clears the reminder', cleared)

      // ---- 2. the lock screen --------------------------------------------
      step = 'lock'
      const lockShortcut = () =>
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'L', ctrlKey: true, altKey: true, bubbles: true, cancelable: true
        }))

      lockShortcut()
      const locked = await waitFor(() => !!lockEl(), 4000)
      push('the lock shortcut locks the app', locked)

      // A hit test rather than an element check: the point is that the panes
      // cannot be read, so the topmost thing at the centre of the window has to
      // be the lock.
      const covered = document.elementFromPoint(
        Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2)
      )
      const insideLock = !!(covered && covered.closest('[data-testid="lock-screen"]'))
      push('the lock covers what is behind it', insideLock,
        covered ? (covered.className || covered.tagName).toString().slice(0, 40) : 'nothing')
      push('a lock with no password needs no typing', !lockInput())
      const unlockBtn = lockButton()
      if (unlockBtn) unlockBtn.click()
      const opened = await waitFor(() => !lockEl(), 4000)
      push('one click unlocks when no password is set', opened)

      // ---- 3. a password is asked for -------------------------------------
      step = 'password'
      await openSettings('Wellbeing')
      const field = document.querySelector(
        '[data-testid="settings-drawer"] [aria-label="lock-password"]'
      )
      push('the password can be set in settings', !!field)
      if (field) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(field, 'hunter2')
        field.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(200)
      }
      const saveLock = document.querySelector('[data-testid="lock-save"]')
      if (saveLock) saveLock.click()
      await wait(700)
      const statusText = document.querySelector('[data-testid="lock-status"]')?.textContent || ''
      const lockAfterSave = await window.termdeck.lockStatus()
      push('saving a password is confirmed',
        /Password saved|password is set/i.test(statusText) && lockAfterSave.hasPassword === true,
        JSON.stringify(statusText) + ' hasPassword=' + lockAfterSave.hasPassword)
      await closeSettings()
      push('the settings drawer is closed again',
        !document.querySelector('[data-testid="settings-drawer"]'))

      lockShortcut()
      const locked2 = await waitFor(() => !!lockEl(), 4000)
      push('it locks again with a password set', locked2)
      push('a password is now asked for', !!lockInput())

      const typePassword = async (value) => {
        const input = lockInput()
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(200)
        const button = lockButton()
        if (button) button.click()
        await wait(700)
        return true
      }

      await typePassword('wrong')
      const refused = !!lockEl()?.querySelector('[data-testid="lock-error"]')
      push('a wrong password is refused', refused && !!lockEl(),
        lockEl()?.querySelector('[data-testid="lock-error"]')?.textContent || 'no error shown')

      await typePassword('hunter2')
      const unlocked = await waitFor(() => !lockEl(), 4000)
      push('the right password unlocks', unlocked)

      // ---- 4. clearing it goes back to a click ----------------------------
      step = 'clear'
      await openSettings('Wellbeing')
      const clear = document.querySelector('[data-testid="lock-clear"]')
      push('the password can be cleared again', !!clear && !clear.disabled)
      if (clear) clear.click()
      await wait(700)
      const lockCleared = await window.termdeck.lockStatus()
      push('clearing removes the stored password', lockCleared.hasPassword === false,
        'hasPassword=' + lockCleared.hasPassword)
      await closeSettings()
      lockShortcut()
      await waitFor(() => !!lockEl(), 4000)
      push('after clearing, the lock asks for nothing', !lockInput())
      lockButton()?.click()
      const finalUnlock = await waitFor(() => !lockEl(), 4000)
      push('and one click opens it again', finalUnlock)

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
    report([{ name: 'wellbeing probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('wellbeing probe crashed:', err)
    app.exit(1)
  })
)
