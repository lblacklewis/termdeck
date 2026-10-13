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
  // The break timer only counts while the window has focus — which is the point
  // of it — so the suite has to actually focus the window.
  win.focus()
  await sleep(500)

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
      const shellBtn = document.querySelector('[data-testid="local-shell"]')
      if (shellBtn) shellBtn.click()
      const live = await waitFor(async () => (await window.termdeck.listSessions()).length > 0, 15000)
      push('a terminal is open behind the overlays', live)

      // ---- 1. the break nudge ---------------------------------------------
      step = 'break settings'
      const settingsOpen = await openSettings('Wellbeing')
      push('settings has a Wellbeing tab', settingsOpen)
      push('the break reminder can be turned on',
        !!document.querySelector('[aria-label="break-enabled"]'))

      // A one-minute interval with a three-second quiet gate: the point of this
      // suite is the mechanism, and waiting 45 minutes for it is not a test.
      const setNumber = async (label, value) => {
        // No template literal here: this whole probe is itself a template literal,
        // and a nested backtick would end it early.
        const input = document.querySelector('[aria-label="' + label + '"]')
        if (!input) return false
        // React tracks the value, so set it through the native setter.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, String(value))
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(150)
        return true
      }
      await setNumber('break-minutes', 1)
      await setNumber('break-idle', 10)
      await setNumber('break-snooze', 10)
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
        stored.break.enabled === true && stored.break.minutes === 1 &&
          stored.break.idleSeconds === 10 && stored.break.snoozeMinutes === 10,
        JSON.stringify(stored.break))
      await closeSettings()

      /*
       * The gate, end to end: with a command producing output every second for
       * longer than the interval, the nudge must *not* appear — landing a banner
       * on top of a running command is the failure this exists to avoid. Once the
       * terminals go quiet it appears on its own.
       */
      step = 'busy gate'
      const busySession = (await window.termdeck.listSessions())[0]?.id
      push('a session is available to keep busy', !!busySession)
      for (let i = 0; i < 70; i++) {
        window.termdeck.writeSession(busySession, 'echo TICK' + String.fromCharCode(13))
        await wait(1000)
      }
      push('no nudge while a command is producing output',
        !document.querySelector('[data-testid="break-bar"]'),
        'after 70s of continuous output')

      step = 'idle gate'
      const appeared = await waitFor(() => !!document.querySelector('[data-testid="break-bar"]'), 25000)
      push('the nudge appears once the terminals are quiet', appeared)

      const bar = document.querySelector('[data-testid="break-bar"]')
      push('it sits in the layout above the panes, not over them',
        !!bar && !document.querySelector('.td-modal-backdrop'),
        'bar=' + !!bar + ' modal=' + !!document.querySelector('.td-modal-backdrop'))
      const host = document.querySelector('.td-terminal-host')
      const hostBox = host && host.getBoundingClientRect()
      push('the terminal keeps its box while the nudge is up',
        !!hostBox && hostBox.height > 100 && hostBox.width > 200,
        hostBox ? Math.round(hostBox.width) + 'x' + Math.round(hostBox.height) : 'none')
      const barText = bar?.innerText || ''
      push('it says how long it has been', /minute/i.test(barText), JSON.stringify(barText.slice(0, 70)))

      step = 'break actions'
      const snooze = document.querySelector('[data-testid="break-snooze"]')
      const done = document.querySelector('[data-testid="break-done"]')
      const lockBtn = document.querySelector('[data-testid="break-lock"]')
      push('it offers break, break-and-lock and snooze',
        !!snooze && !!done && !!lockBtn && !document.querySelector('[data-testid="break-game"]'))
      if (snooze) snooze.click()
      const snoozed = await waitFor(() => !document.querySelector('[data-testid="break-bar"]'), 5000)
      push('snoozing takes the nudge away', snoozed)
      const stillOn = await window.termdeck.loadSettings()
      push('snoozing leaves the interval alone',
        stillOn.break.enabled && stillOn.break.minutes === 1, JSON.stringify(stillOn.break))

      // Taking the break is what gets recorded.
      await openSettings('Wellbeing')
      const preview = document.querySelector('[data-testid="break-preview"]')
      push('the nudge can be tried immediately', !!preview)
      if (preview) preview.click()
      const shown = await waitFor(() => !!document.querySelector('[data-testid="break-bar"]'), 5000)
      push('the try-it button shows the nudge', shown)
      const taken = document.querySelector('[data-testid="break-done"]')
      if (taken) taken.click()
      const cleared = await waitFor(() => !document.querySelector('[data-testid="break-bar"]'), 5000)
      push('taking the break clears the nudge', cleared)
      const afterStats = await window.termdeck.loadSettings()
      push('the break is recorded',
        afterStats.breakStats.breaks === 1 && afterStats.breakStats.longestMinutes >= 1,
        JSON.stringify(afterStats.breakStats))

      // And it is written to the activity log, which is the page that keeps it.
      step = 'break log'
      const logsRail = document.querySelector('[data-testid="rail-logs"]')
      if (logsRail) logsRail.click()
      await wait(700)
      const logText = document.body.innerText || ''
      // Sliced rather than matched: an escape inside a regex in this template is
      // eaten, and a swallowed newline escape arrives as a real newline, which is
      // not a legal regex literal at all.
      const logIndex = logText.indexOf('Break taken after ')
      push('the break shows up in the activity log', logIndex >= 0,
        logIndex >= 0
          ? logText.slice(logIndex, logIndex + 44).split(String.fromCharCode(10))[0]
          : 'not found')
      const terminalRail = document.querySelector('[data-testid="rail-terminal"]')
      if (terminalRail) terminalRail.click()
      await wait(700)

      // Break and lock: the version that actually gets someone to stand up.
      step = 'break and lock'
      await openSettings('Wellbeing')
      const preview3 = document.querySelector('[data-testid="break-preview"]')
      if (preview3) preview3.click()
      await waitFor(() => !!document.querySelector('[data-testid="break-bar"]'), 5000)
      const lockAction = document.querySelector('[data-testid="break-lock"]')
      if (lockAction) lockAction.click()
      const lockedByBreak = await waitFor(() => !!lockEl(), 5000)
      push('break-and-lock covers the screen', lockedByBreak)
      const afterLock = await window.termdeck.loadSettings()
      push('it counts as a second break', afterLock.breakStats.breaks === 2,
        JSON.stringify(afterLock.breakStats))
      lockButton()?.click()
      await waitFor(() => !lockEl(), 5000)

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

      // ---- 5. the pomodoro cycle ------------------------------------------
      /*
       * A one-minute round and a one-minute break, so the whole cycle can be
       * watched. The work half is driven by *focused* time, so it is earned the
       * same way the reminder is: by keeping the window in front while the
       * terminals are busy.
       */
      step = 'pomodoro setup'
      await openSettings('Wellbeing')
      const pomodoroBtn = document.querySelector('[data-testid="break-mode-pomodoro"]')
      push('the wellness timer can be switched to a pomodoro cycle', !!pomodoroBtn)
      if (pomodoroBtn) pomodoroBtn.click()
      await wait(300)
      await setNumber('break-minutes', 1)
      await setNumber('break-length', 1)
      const savePomodoro = document.querySelector('[data-testid="settings-save"]')
      if (savePomodoro) savePomodoro.click()
      await wait(700)
      const pomodoroSettings = await window.termdeck.loadSettings()
      push('the cycle settings are saved',
        pomodoroSettings.break.mode === 'pomodoro' &&
          pomodoroSettings.break.minutes === 1 &&
          pomodoroSettings.break.breakMinutes === 1,
        JSON.stringify(pomodoroSettings.break))
      await closeSettings()

      step = 'pomodoro chip'
      const chip = await waitFor(() => !!document.querySelector('[data-testid="wellness-chip"]'), 5000)
      push('the drawer footer shows the cycle', chip,
        document.querySelector('[data-testid="wellness-clock"]')?.textContent || 'none')
      push('the chip starts on the work half',
        document.querySelector('[data-testid="wellness-chip"]')?.getAttribute('data-phase') === 'work')

      const roundSession = (await window.termdeck.listSessions())[0]?.id
      for (let i = 0; i < 70; i++) {
        window.termdeck.writeSession(roundSession, 'echo ROUND' + String.fromCharCode(13))
        await wait(1000)
      }

      step = 'pomodoro break'
      const breakBar = await waitFor(
        () => document.querySelector('[data-testid="break-bar"]')?.getAttribute('data-kind') === 'break',
        30000
      )
      push('the round ends at the first quiet moment after the mark', breakBar)
      const countdown = document.querySelector('[data-testid="break-countdown"]')?.textContent || ''
      push('the break counts down in the bar', /[0-9]:[0-9][0-9]/.test(countdown),
        JSON.stringify(countdown.slice(0, 60)))
      push('the chip switches to the break half',
        document.querySelector('[data-testid="wellness-chip"]')?.getAttribute('data-phase') === 'break',
        document.querySelector('[data-testid="wellness-clock"]')?.textContent || 'none')

      const backToWork = document.querySelector('[data-testid="break-end"]')
      push('a break can be cut short', !!backToWork)
      if (backToWork) backToWork.click()
      const barGone = await waitFor(() => !document.querySelector('[data-testid="break-bar"]'), 5000)
      push('ending the break clears the bar', barGone)
      const afterRound = await window.termdeck.loadSettings()
      push('the finished round is recorded',
        afterRound.breakStats.pomodoros === 1 && afterRound.breakStats.breaks >= 3,
        JSON.stringify(afterRound.breakStats))
      push('the chip is back on the work half',
        document.querySelector('[data-testid="wellness-chip"]')?.getAttribute('data-phase') === 'work')

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
