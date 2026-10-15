/**
 * Adding hosts a batch at a time.
 *
 *   npm run build && electron smoke/batch.cjs --user-data-dir=...
 *
 * Two halves. The first drives the parser directly, in the main process, because
 * reading a pasted list is pure logic and worth pinning down case by case. The
 * second drives the real form: a range typed into the box, saved in one go, with
 * one password landing on every host it created — and the same range pasted again
 * adding nothing, because a list that quietly doubles is worse than a slow one.
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
  mod.storeAccess().layout.clear()

  // ---- 1. the parser ------------------------------------------------------
  const parsed = (text) => mod.parseBatchHosts(text)
  const hosts = (text) => parsed(text).entries.map((e) => e.host)
  const NL = String.fromCharCode(10)

  report([
    {
      name: 'a last-octet range expands in order',
      ok:
        hosts('10.17.20.210-215').join(',') ===
        '10.17.20.210,10.17.20.211,10.17.20.212,10.17.20.213,10.17.20.214,10.17.20.215',
      detail: hosts('10.17.20.210-215').join(',')
    },
    {
      name: 'a numbered name range expands and keeps its padding',
      ok: hosts('node01-04').join(',') === 'node01,node02,node03,node04',
      detail: hosts('node01-04').join(',')
    },
    {
      name: 'a range spelled out at both ends expands too',
      ok: hosts('10.17.20.210-10.17.20.213').join(',') ===
        '10.17.20.210,10.17.20.211,10.17.20.212,10.17.20.213',
      detail: hosts('10.17.20.210-10.17.20.213').join(',')
    },
    {
      name: 'an ordinary hyphenated name is not mistaken for a range',
      ok: hosts('web-1.example.com').join(',') === 'web-1.example.com',
      detail: hosts('web-1.example.com').join(',')
    },
    {
      name: 'user, port and ssh:// are read off the line',
      ok: (() => {
        const e = parsed('ssh://root@10.0.0.5:2222').entries[0]
        return !!e && e.host === '10.0.0.5' && e.port === 2222 && e.username === 'root'
      })(),
      detail: JSON.stringify(parsed('ssh://root@10.0.0.5:2222').entries)
    },
    {
      name: 'comments, blank lines and commas are all handled',
      ok:
        hosts('# prod hosts' + NL + '10.0.0.1, 10.0.0.2' + NL + NL + '  10.0.0.3  ').join(',') ===
        '10.0.0.1,10.0.0.2,10.0.0.3',
      detail: hosts('# prod hosts' + NL + '10.0.0.1, 10.0.0.2' + NL + NL + '  10.0.0.3  ').join(',')
    },
    {
      name: 'the same host pasted twice is only listed once',
      ok: hosts('10.0.0.1' + NL + '10.0.0.1').length === 1,
      detail: hosts('10.0.0.1' + NL + '10.0.0.1').join(',')
    },
    {
      name: 'a backwards range is reported rather than coming out empty',
      ok: (() => {
        const r = parsed('10.17.20.215-210')
        return r.entries.length === 0 && r.problems.length === 1
      })(),
      detail: JSON.stringify(parsed('10.17.20.215-210').problems)
    },
    {
      name: 'an impossible port is reported with the text that caused it',
      ok: (() => {
        const r = parsed('10.0.0.1:99999')
        return r.entries.length === 0 && r.problems.length === 1 && r.problems[0].text === '10.0.0.1:99999'
      })(),
      detail: JSON.stringify(parsed('10.0.0.1:99999').problems)
    },
    {
      name: 'a range bigger than the cap is refused, not truncated silently',
      ok: (() => {
        const r = parsed('10.0.0.1-999')
        return r.entries.length === 0 && r.problems.length === 1
      })(),
      detail: JSON.stringify(parsed('10.0.0.1-999').problems)
    },
    {
      name: 'a paste past the cap stops at it and says so',
      ok: (() => {
        const r = parsed('10.0.0.1-200' + NL + '10.1.0.1-200')
        return r.entries.length === mod.BATCH_HOST_LIMIT && r.truncated === true
      })(),
      detail: (() => {
        const r = parsed('10.0.0.1-200' + NL + '10.1.0.1-200')
        return r.entries.length + ' entries, truncated=' + r.truncated
      })()
    }
  ])

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
  mod.attachFocusMode(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2800)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const NL = String.fromCharCode(10)
      const setInput = (el, value, proto) => {
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const setText = (el, value) => setInput(el, value, window.HTMLTextAreaElement)
      const setValue = (el, value) => setInput(el, value, window.HTMLInputElement)
      const summary = () =>
        (document.querySelector('[data-testid="batch-summary"]') || {}).textContent || ''
      const openEditor = async () => {
        if (!document.querySelector('.td-sidebar')) {
          document.querySelector('[data-testid="rail-toggle"]').click()
          await wait(700)
        }
        document.querySelector('[data-testid="tree-new-session"]').click()
        await wait(600)
      }
      const toBatchMode = async () => {
        document.querySelector('[data-testid="session-mode-many"]').click()
        await wait(400)
      }

      let step = 'start'
      try {
        step = 'the editor offers both modes'
        await openEditor()
        push('a new session opens the single-host form',
          !!document.querySelector('[aria-label="session-host"]'))
        push('the editor offers a several-hosts mode',
          !!document.querySelector('[data-testid="session-mode-many"]'))

        step = 'batch mode'
        await toBatchMode()
        const area = document.querySelector('[aria-label="session-hosts"]')
        push('batch mode swaps the host field for a list',
          !!area && !document.querySelector('[aria-label="session-host"]'))
        push('the shared fields stay: username, port, password',
          !!document.querySelector('[aria-label="session-username"]') &&
            !!document.querySelector('[aria-label="session-port"]') &&
            !!document.querySelector('[aria-label="session-password"]'))
        push('the password is described as shared',
          /shared by every host/i.test(
            (document.querySelector('[aria-label="session-password"]').closest('label') || {})
              .textContent || ''))

        setText(area, '10.17.20.210-215')
        await wait(300)
        push('the range is counted before saving',
          /6 hosts will be added/.test(summary()), summary())
        push('the button says how many it will add',
          /Add 6 hosts/.test(
            (document.querySelector('[data-testid="session-save"]') || {}).textContent || ''),
          (document.querySelector('[data-testid="session-save"]') || {}).textContent)

        step = 'a line that cannot be read'
        setText(area, '10.17.20.210' + NL + 'nonsense:99999')
        await wait(300)
        push('an unreadable line is reported with its text',
          /could not be read/.test(summary()) && /nonsense:99999/.test(summary()), summary())
        push('and the readable line is still going to be added',
          /1 host will be added/.test(summary()), summary())

        step = 'save the batch'
        setText(area, '10.17.20.210-215')
        setValue(document.querySelector('[aria-label="session-username"]'), 'batchuser')
        setValue(document.querySelector('[aria-label="session-port"]'), '2200')
        setValue(document.querySelector('[aria-label="session-password"]'), 'shared-secret')
        await wait(300)
        document.querySelector('[data-testid="session-save"]').click()
        await wait(1500)
        push('the drawer closes once the batch is saved',
          !document.querySelector('[data-testid="session-save"]'))

        const tree = await api.loadSessionTree()
        const added = tree.sessions.filter((s) => s.host.indexOf('10.17.20.21') === 0)
        push('every host in the range was saved', added.length === 6,
          'added=' + added.length + ' ' + added.map((s) => s.host).join(','))
        push('they are named after their address',
          added.length === 6 && added.every((s) => s.name === s.host),
          added.map((s) => s.name).join(','))
        push('the shared username and port came through',
          added.length === 6 && added.every((s) => s.username === 'batchuser' && s.port === 2200),
          added.map((s) => s.username + ':' + s.port).join(','))
        push('the shared password is stored for every one of them',
          added.length === 6 && added.every((s) => s.hasPassword === true),
          'withPassword=' + added.filter((s) => s.hasPassword).length)

        step = 'the same range again'
        await openEditor()
        await toBatchMode()
        /*
         * The same shared username and port as the first pass. "Already saved"
         * means the same host *and* the same login: a second login to one machine
         * is a legitimate pair of sessions, so host alone would be too loose.
         */
        setValue(document.querySelector('[aria-label="session-username"]'), 'batchuser')
        setValue(document.querySelector('[aria-label="session-port"]'), '2200')
        setText(document.querySelector('[aria-label="session-hosts"]'), '10.17.20.210-215')
        await wait(400)
        push('re-pasting the range adds nothing',
          /0 hosts will be added/.test(summary()) && /6 already saved/.test(summary()),
          summary())
        push('and the save button is off',
          document.querySelector('[data-testid="session-save"]').disabled === true)

        step = 'the same host as another user'
        setValue(document.querySelector('[aria-label="session-username"]'), 'otheruser')
        await wait(300)
        push('the same host with a different user is a new session, not a duplicate',
          /6 hosts will be added/.test(summary()), summary())
        setValue(document.querySelector('[aria-label="session-username"]'), 'batchuser')
        await wait(200)

        step = 'a new address in the same range'
        setText(document.querySelector('[aria-label="session-hosts"]'), '10.17.20.210-217')
        await wait(300)
        push('only the new addresses are counted',
          /2 hosts will be added/.test(summary()) && /already saved/.test(summary()), summary())

        step = 'back to one host'
        document.querySelector('[data-testid="session-mode-one"]').click()
        await wait(300)
        push('single mode brings the host field back',
          !!document.querySelector('[aria-label="session-host"]') &&
            !document.querySelector('[aria-label="session-hosts"]'))
        const cancel = [...document.querySelectorAll('[data-testid="session-form"] button')]
          .find((b) => (b.textContent || '').trim() === 'Cancel')
        if (cancel) cancel.click()
        await wait(400)

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
    report([{ name: 'batch probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('batch probe crashed:', err)
    app.exit(1)
  })
)
