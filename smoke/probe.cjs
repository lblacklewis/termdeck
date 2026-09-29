/**
 * UI verification harness, run inside Electron.
 *
 *   npm run build && electron smoke/probe.cjs
 *
 * Loads the built renderer exactly like the shipped app does, then asserts on
 * the real DOM. Covers, in order:
 *   1. preload bridge + dockview mount + welcome pane
 *   2. local shell end-to-end (IPC -> ConPTY -> xterm -> rendered text)
 *   3. real SSH session through the App's own connection dialog
 *   4. dockview split and tab-grouping, the primitives behind drag-to-split
 *
 * Exits non-zero if any check fails.
 */
const path = require('node:path')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const SSH_USER = process.env.TD_SSH_USER || 'root'
const SSH_KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    all.push(c)
  }
}

async function main() {
  require(path.join(ROOT, 'out', 'main', 'smokeEntry.js')).registerIpc()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const rendererErrors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) rendererErrors.push(message)
  })
  win.webContents.on('render-process-gone', (_e, d) =>
    rendererErrors.push(`render process gone: ${d.reason}`)
  )

  const indexFile = path.join(ROOT, 'out', 'renderer', 'index.html')
  await win.loadFile(indexFile)

  // Enable the App's dockview test hook, then reload so the effect sees it.
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)

  // This harness exercises layout and terminal plumbing; host-key policy has its
  // own suite, so trust the test host here to keep the run independent of the
  // developer's known_hosts state.
  await win.webContents.executeJavaScript(
    `window.termdeck.loadSettings().then(s =>
       window.termdeck.saveSettings({ ...s, hostKeys: { policy: 'trust' } }))`
  )
  await sleep(300)

  // ---- 1. shell + local session ------------------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      push('bridge exposed', typeof window.termdeck === 'object',
        Object.keys(window.termdeck || {}).length + ' methods')

      const info = await window.termdeck.appInfo()
      push('appInfo', !!info, info.platform + ' pty=' + info.localShellAvailable)
      push('dockview mounted', !!document.querySelector('.td-dockview'))
      push('welcome pane shown', !!document.querySelector('.td-welcome'))
      push('dock api test hook', !!window.__tdDockApi)

      const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      push('local shell button', !!btn)
      btn.click()
      await new Promise((r) => setTimeout(r, 3000))

      const rows = document.querySelectorAll('.xterm-rows > div').length
      push('local: xterm rendered', rows > 0, rows + ' rows')

      const text = (document.querySelector('.xterm-rows') || {}).textContent || ''
      push('local: shell output', text.trim().length > 0, JSON.stringify(text.trim().slice(0, 50)))

      const groups = document.querySelectorAll('.dv-groupview').length
      push('one session -> one pane', groups === 1, groups + ' group(s)')

      return out
    })()`)
  )

  // ---- 2. real SSH through the App's dialog ------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const newBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Connect/i.test(b.textContent || ''))
      push('quick-connect button present', !!newBtn,
        [...document.querySelectorAll('.td-sidebar .td-btn')].map((b) => b.textContent.trim()).join(' | '))
      if (!newBtn) return out
      newBtn.click()
      await new Promise((r) => setTimeout(r, 400))

      const inputs = document.querySelectorAll('[data-testid="drawer"] input')
      push('connection dialog opened', inputs.length >= 3, inputs.length + ' inputs')

      const setValue = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const field = (label) => document.querySelector('[data-testid="drawer"] [aria-label="' + label + '"]')

      push('dialog fields present',
        !!(field('ssh-host') && field('ssh-port') && field('ssh-username')),
        [...document.querySelectorAll('[data-testid="drawer"] [aria-label]')].map((i) => i.getAttribute('aria-label')).join(','))

      setValue(field('ssh-host'), ${JSON.stringify(SSH_HOST)})
      setValue(field('ssh-port'), '22')
      setValue(field('ssh-username'), ${JSON.stringify(SSH_USER)})

      const keyTab = [...document.querySelectorAll('.td-segmented button')]
        .find((b) => /Private key/i.test(b.textContent || ''))
      push('private-key auth option', !!keyTab)
      keyTab.click()
      await new Promise((r) => setTimeout(r, 400))

      const keyInput = field('private-key-path')
      push('key path field shown', !!keyInput)
      setValue(keyInput, ${JSON.stringify(SSH_KEY)})
      await new Promise((r) => setTimeout(r, 400))

      const connect = document.querySelector('[data-testid="connect-submit"]')
      push('connect button located', !!connect)
      push('key path accepted by form', keyInput.value === ${JSON.stringify(SSH_KEY)},
        JSON.stringify(keyInput.value))
      push('connect button enabled', !!connect && !connect.disabled,
        connect ? 'disabled=' + connect.disabled : 'no button')

      if (!connect || connect.disabled) {
        const allInputs = [...document.querySelectorAll('[data-testid="drawer"] input')]
        push('dialog inputs', false, allInputs.map((i) => i.type + ':' + i.value).join(' | '))
        return out
      }
      connect.click()

      const deadline = Date.now() + 40000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
        const err = document.querySelector('.td-form-error')
        if (err) { push('ssh connect', false, err.textContent.trim()); return out }
        if (!document.querySelector('[data-testid="drawer"]')) break
      }
      push('ssh connected (drawer closed)', !document.querySelector('[data-testid="drawer"]'))

      await new Promise((r) => setTimeout(r, 5000))

      const tabs = [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())
      push('ssh session tab', tabs.some((t) => t.includes(${JSON.stringify(SSH_HOST)})),
        tabs.join(' | '))

      // Both sessions start in the same group, so dockview keeps only the
      // active panel's element in the DOM — one .xterm, two tabs.
      const terms = document.querySelectorAll('.xterm').length
      push('one active terminal for stacked tabs', terms === 1, terms + ' xterm(s), ' + tabs.length + ' tabs')
      push('two session tabs', tabs.length >= 2, tabs.length + ' tab(s)')

      // Right after connecting, the SSH panel is the active one: its buffer
      // must already hold the remote shell's banner/prompt.
      const survey = [...document.querySelectorAll('.xterm-rows')].map((el) => ({
        visible: el.offsetParent !== null,
        rows: el.children.length,
        tail: (el.textContent || '').trim().slice(-60)
      }))
      push('ssh terminal streams on connect',
        survey.some((t) => /root@|#|\\$|Welcome|Ubuntu/i.test(t.tail)), JSON.stringify(survey))

      return out
    })()`)
  )

  // ---- 3. tab activation switches the live terminal ----------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const tabEls = [...document.querySelectorAll('.dv-tab')]
      const localTab = tabEls.find((t) => /Local Shell/i.test(t.textContent || ''))
      const sshTab = tabEls.find((t) => t.textContent.includes(${JSON.stringify(SSH_HOST)}))
      push('both tabs located', !!localTab && !!sshTab)

      const dock = window.__tdDockApi
      const sshPanel = dock.panels.find((p) => (p.title || '').includes(${JSON.stringify(SSH_HOST)}))
      const localPanel = dock.panels.find((p) => /Local Shell/i.test(p.title || ''))
      push('panels identified in dockview', !!sshPanel && !!localPanel,
        dock.panels.map((p) => p.title).join(' | '))

      const survey = () => {
        const els = [...document.querySelectorAll('.xterm-rows')]
        return els.map((el) => ({
          visible: el.offsetParent !== null,
          rows: el.children.length,
          tail: (el.textContent || '').trim().slice(-45)
        }))
      }

      sshPanel.api.setActive()
      await new Promise((r) => setTimeout(r, 3000))
      const afterSsh = survey()
      push('ssh terminal renders a prompt',
        afterSsh.some((t) => /root@/.test(t.tail)), JSON.stringify(afterSsh))

      localPanel.api.setActive()
      await new Promise((r) => setTimeout(r, 3000))
      const afterLocal = survey()
      push('local terminal keeps its buffer',
        afterLocal.some((t) => /Microsoft|>/.test(t.tail)), JSON.stringify(afterLocal))

      push('terminals stay independent',
        JSON.stringify(afterSsh) !== JSON.stringify(afterLocal),
        afterSsh.length + ' vs ' + afterLocal.length + ' rows elements')

      return out
    })()`)
  )

  // ---- 4. split + grouping via dockview's own API ------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const dock = window.__tdDockApi
      if (!dock) { push('dock api available', false, 'test hook missing'); return out }

      const groupsBefore = document.querySelectorAll('.dv-groupview').length
      push('starts as a single pane', groupsBefore === 1, groupsBefore + ' group(s)')

      // Split the SSH panel out; the welcome probe panel has no terminal, so
      // the check looks for the *pre-existing* terminals staying mounted.
      const beforeSplit = document.querySelectorAll('.xterm').length
      const target = dock.panels.find((p) => p.title && p.title.includes(${JSON.stringify(SSH_HOST)}))
        || dock.panels[0]
      dock.addPanel({
        id: 'split-probe',
        component: 'welcome',
        title: 'Split probe',
        position: { referencePanel: target.id, direction: 'right' }
      })
      await new Promise((r) => setTimeout(r, 1500))

      const groupsAfter = document.querySelectorAll('.dv-groupview').length
      push('drag-to-edge splits the pane', groupsAfter === 2, groupsBefore + ' -> ' + groupsAfter)

      // Both existing tabs now sit in the same group, so at least one terminal
      // must still be mounted and rendering.
      const termsAfterSplit = document.querySelectorAll('.xterm').length
      push('terminals survive the split', termsAfterSplit >= beforeSplit && termsAfterSplit >= 1,
        beforeSplit + ' -> ' + termsAfterSplit + ' xterm(s)')

      // Group: what dropping a tab on a pane's centre does.
      const probe = dock.panels.find((p) => p.id === 'split-probe')
      dock.addPanel({
        id: 'group-probe',
        component: 'welcome',
        title: 'Group probe',
        position: { referencePanel: target.id, direction: 'within' }
      })
      await new Promise((r) => setTimeout(r, 1200))

      const groupCount = dock.groups.length
      push('drag-to-centre groups tabs', groupCount === 2, groupCount + ' group(s)')

      const nested = dock.panels.filter((p) => p.group.id === target.group.id).length
      push('panels share one tab group', nested >= 2, nested + ' panels in group')

      // Layout serialisation is the basis for session restore.
      const json = dock.toJSON()
      push('layout serialises', !!json && !!json.panels,
        Object.keys(json.panels || {}).length + ' panels')

      // Tidy the probe panels so the layout matches what the user sees.
      for (const id of ['split-probe', 'group-probe']) {
        const p = dock.panels.find((x) => x.id === id)
        if (p) dock.removePanel(p)
      }
      await new Promise((r) => setTimeout(r, 500))
      push('probe panels cleaned up', !dock.panels.some((p) => p.id.endsWith('-probe')),
        dock.panels.length + ' panels remain')

      return out
    })()`)
  )

  if (rendererErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of rendererErrors.slice(0, 10)) console.log('  ' + e)
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('probe crashed:', err)
    app.exit(1)
  })
)
