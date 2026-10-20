/**
 * Inline command suggestions.
 *
 * The behaviour asked for is WindTerm's: start typing, get the commands you have run
 * before, walk them with ↑/↓, and press Enter to bring one into the line *without
 * running it*. That last part is the whole point and the easiest thing to get wrong,
 * so it is what this suite checks hardest: after accepting a completion the shell
 * must still be sitting at a prompt with the command unt run.
 *
 * The history is seeded rather than typed, because the interesting cases are about
 * what is *not* stored as much as what is.
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  const stores = mod.storeAccess()
  stores.layout.clear()

  /*
   * Seed the shared list through the store itself, so the suite tests the same
   * filters the app applies: a leading space (the shell's "do not keep this") and a
   * duplicate have to be dropped.
   */
  const history = stores.history
  history.remember('Get-Date')
  history.remember('git status --short')
  history.remember('git stash list')
  history.remember('Get-Process')
  history.remember(' secret-typed-by-mistake')
  history.remember('Get-Date')
  const seeded = history.globalCommands()
  const file = path.join(stores.configDir, 'commands.json')

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  mod.attachFocusMode(win)
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)

  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' })
  const page = (code) => win.webContents.executeJavaScript(code)

  push('the shared list keeps commands and de-duplicates',
    seeded[0] === 'Get-Date' && seeded.filter((c) => c === 'Get-Date').length === 1 &&
      seeded.includes('git status --short'),
    JSON.stringify(seeded))
  push('a line starting with a space is never stored',
    !seeded.some((c) => c.includes('secret-typed-by-mistake')), JSON.stringify(seeded))
  push('and it is on disk for the next run', fs.existsSync(file), file)

  // ---- open a shell and type a prefix -----------------------------------------
  const ipc = await page('window.termdeck.globalCommandHistory()')
  push('the renderer can read the shared list over IPC',
    Array.isArray(ipc) && ipc.includes('Get-Date'), JSON.stringify(ipc))

  const typed = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = window.__tdDockApi.panels.length
    document.querySelector('[data-testid="local-shell"]').click()
    for (let i = 0; i < 40; i++) { await wait(250); if (window.__tdDockApi.panels.length > before) break }
    await wait(1200)
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    entry.term.focus()
    await wait(300)
    // Does a paste reach onData at all? The popup is fed from there.
    let seen = ''
    entry.term.onData((data) => { seen += data })
    for (const ch of 'Get-') entry.term.paste(ch)
    await wait(900)
    const box = document.querySelector('[data-testid="command-suggest"]')
    return {
      sawData: seen,
      debug: window.__tdSuggest || null,
      box: !!box,
      visible: !!box && !box.hidden,
      items: box ? [...box.querySelectorAll('.td-suggest-item')].map((el) => el.textContent) : [],
      active: box ? ((box.querySelector('.td-suggest-item.is-active') || {}).textContent ?? null) : null
    }
  })()`)
  push('a paste reaches the input stream the popup is fed from',
    typed.sawData.includes('Get-'), JSON.stringify(typed.sawData))
  push('typing a prefix opens the suggestion list', typed.visible, JSON.stringify(typed))
  push('it lists the commands starting with what was typed',
    typed.items.length === 2 && typed.items.every((t) => t.startsWith('Get-')),
    JSON.stringify(typed.items))
  push('nothing is selected when the list opens', typed.active === null, String(typed.active))

  // ---- ↑/↓ walk the list ------------------------------------------------------
  const walked = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const send = (key) => document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    send('ArrowDown')
    await wait(250)
    const box = document.querySelector('[data-testid="command-suggest"]')
    const afterDown = (box.querySelector('.td-suggest-item.is-active') || {}).textContent
    send('ArrowUp')
    await wait(250)
    const afterUp = (box.querySelector('.td-suggest-item.is-active') || {}).textContent
    return { afterDown, afterUp }
  })()`)
  push('ArrowDown selects the first candidate', walked.afterDown === typed.items[0],
    JSON.stringify(walked))
  push('ArrowUp wraps around the list', walked.afterUp === typed.items[1], JSON.stringify(walked))

  // ---- Enter brings it into the line, without running it ----------------------
  const accepted = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await wait(900)
    const term = entry.term
    const line = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)
    return {
      row: line ? line.translateToString(true) : '',
      cursorX: term.buffer.active.cursorX,
      suggestOpen: !!document.querySelector('[data-testid="command-suggest"]') &&
        !document.querySelector('[data-testid="command-suggest"]').hidden,
      running: (await window.termdeck.listSessions()).length
    }
  })()`)
  push('the completion lands in the line', /Get-Process/.test(accepted.row), accepted.row)
  push('the popup closes once it is used', !accepted.suggestOpen)
  push('and the command was not executed', !/\d{1,2}:\d{2}:\d{2}/.test(accepted.row),
    accepted.row)
  push('the session is still alive', accepted.running === 1, String(accepted.running))

  // ---- Escape leaves the shell alone ------------------------------------------
  const escaped = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    // Abandon the line the previous check left behind, then type a fresh prefix
    // that really has matches.
    entry.term.paste(String.fromCharCode(3))
    await wait(500)
    for (const ch of 'git ') entry.term.paste(ch)
    await wait(800)
    const opened = !!document.querySelector('[data-testid="command-suggest"]') &&
      !document.querySelector('[data-testid="command-suggest"]').hidden
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await wait(400)
    const box = document.querySelector('[data-testid="command-suggest"]')
    return { opened, closed: !!box && box.hidden }
  })()`)
  push('Escape dismisses the list', escaped.opened && escaped.closed, JSON.stringify(escaped))

  // ---- typing on past the list dismisses it ------------------------------------
  const typedOn = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    entry.term.paste(String.fromCharCode(3))
    await wait(500)
    for (const ch of 'git ') entry.term.paste(ch)
    await wait(700)
    const box = () => document.querySelector('[data-testid="command-suggest"]')
    const opened = !!box() && !box().hidden
    // Four more characters, no selection: the list has to get out of the way.
    for (const ch of 'stas') entry.term.paste(ch)
    await wait(800)
    const closed = !!box() && box().hidden
    const after = [...(box() ? box().querySelectorAll('.td-suggest-item') : [])].length
    return { opened, closed, after }
  })()`)
  push('typing on past the list closes it', typedOn.opened && typedOn.closed,
    JSON.stringify(typedOn))

  // ---- history records what ran, not what was typed ----------------------------
  const completed = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    entry.term.paste(String.fromCharCode(3))
    await wait(500)
    /*
     * Type a command, run it, then recall it with Up.
     *
     * The Up key sends only an escape sequence, so a record built from the keystrokes
     * would store nothing at all — that the recalled command is what lands in history
     * is the proof that the line comes from the screen. (Driving the shell's own Tab
     * completion from a probe turned out not to be possible: a synthetic keydown is
     * ignored by xterm, and a pasted Tab is literal text to PSReadLine.)
     */
    entry.term.paste('Get-Dat')
    await wait(700)
    entry.term.paste(String.fromCharCode(13))
    await wait(1500)
    entry.term.paste(String.fromCharCode(27) + '[A')
    await wait(1200)
    const b = entry.term.buffer.active
    const row = b.getLine(b.baseY + b.cursorY)
    const screen = row ? row.translateToString(true).slice(0, b.cursorX) : ''
    entry.term.paste(String.fromCharCode(13))
    await wait(2000)
    return { screen }
  })()`)
  const recorded = stores.history.globalCommands()
  push('history stores the command the shell ran, not the keys typed',
    recorded[0] === 'Get-Dat' && !recorded.some((c) => /[>$#%]/.test(c)),
    'screen=' + completed.screen + ' history=' + recorded.slice(0, 3).join(' | '))

  /*
   * ---- what does *not* get into history ---------------------------------------
   *
   * The store is the last line of defence. Everything refused below was seen in a
   * real history file: `-s` and `lssc-s` came from the keystroke mirror drifting
   * away from the screen (Tab completion never passes through the input path), and
   * the prompt-shaped ones from a slice that started one column too early.
   */
  const guardSession = 'probe-guard'
  const BS = String.fromCharCode(92)
  const keptAfter = (command) => {
    const before = stores.history.list(guardSession).length
    stores.history.add(guardSession, 'guard', command)
    return stores.history.list(guardSession).length > before
  }
  push('a bare argument is not a command', !keptAfter('-s'))
  push('nor is a line that was typed with a leading space', !keptAfter(' secret-typed-here'))
  push('nor a command with its prompt still attached',
    !keptAfter('PS C:' + BS + 'Users' + BS + 'me> Get-Date') &&
      !keptAfter('[root@host ~]# ls -ltr') &&
      !keptAfter('me@host:~$ ls'))
  push('and a real command still gets through', keptAfter('ls -ltr'))
  stores.history.remember('-s')
  stores.history.remember('me@host:~$ ls')
  push('the suggestion list refuses the same shapes',
    !stores.history.globalCommands().includes('-s') &&
      !stores.history.globalCommands().some((c) => c.includes('~$')),
    JSON.stringify(stores.history.globalCommands().slice(0, 6)))
  stores.history.clear(guardSession)

  /*
   * ---- a full-screen program is not a command line ----------------------------
   *
   * vim, less, man and htop all switch the terminal to the alternate screen buffer
   * (`ESC [ ? 1049 h`) on the way in and back on the way out, and that switch is
   * what the app watches. The bytes are written straight to the terminal here
   * because vim is not installed on a Windows build machine — they arrive by the
   * same path a real one uses, since session output is `term.write(chunk)` too.
   */
  const fullScreen = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const id = Object.keys(window.__tdTerminals || {}).pop()
    const entry = window.__tdTerminals[id]
    entry.term.focus()
    await wait(300)
    const ESC = String.fromCharCode(27)
    const box = () => document.querySelector('[data-testid="command-suggest"]')
    const open = () => { const b = box(); return !!b && !b.hidden }

    // 1. A list that is open when the program takes over has to go away.
    entry.term.paste('Get-')
    await wait(900)
    const openedBefore = open()
    entry.term.write(ESC + '[?1049h')
    await wait(700)
    const mode = entry.term.buffer.active.type
    const closedWhenFullScreen = !open()

    // 2. Nothing typed in there opens one again, and nothing is mirrored.
    for (const ch of 'Get-') entry.term.paste(ch)
    await wait(900)
    const stillClosed = !open()
    const debug = window.__tdSuggest || {}

    // 3. Leaving hands the prompt back, suggestions and all.
    entry.term.write(ESC + '[?1049l')
    await wait(700)
    const backToNormal = entry.term.buffer.active.type
    entry.term.paste(String.fromCharCode(3))   // discard the line typed above
    await wait(500)
    entry.term.paste('Get-')
    await wait(1000)
    const openedAgain = open()
    entry.term.paste(String.fromCharCode(3))
    return {
      openedBefore, mode, closedWhenFullScreen, stillClosed,
      mirrored: debug.line, open2: debug.open, backToNormal, openedAgain
    }
  })()`)
  push('a suggestion list is open before the full-screen program starts',
    fullScreen.openedBefore, JSON.stringify(fullScreen))
  push('starting one switches the terminal to its own screen',
    fullScreen.mode === 'alternate', 'buffer=' + fullScreen.mode)
  push('and the list that was open goes away with it',
    fullScreen.closedWhenFullScreen)
  push('typing in there does not open a new one', fullScreen.stillClosed,
    'open=' + fullScreen.open2)
  push('nor is what it types mirrored as a command line',
    fullScreen.mirrored === '', JSON.stringify(fullScreen.mirrored))
  push('leaving it gives the prompt back', fullScreen.backToNormal === 'normal')
  push('and suggestions work again at the prompt',
    fullScreen.openedAgain, JSON.stringify(fullScreen))

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('suggest probe crashed:', err)
    app.exit(1)
  })
)
