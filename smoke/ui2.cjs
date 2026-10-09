/**
 * Verification for the second UI feature batch:
 *   1. connecting from the sidebar (single-click select, double-click connect)
 *      and, critically, that a failure is *visible* rather than silent
 *   2. right-click context menus on sessions, folders and empty tree space
 *   3. the connections window
 *   4. the bottom snippet bar (create/edit/delete/group/send)
 *
 *   npm run build && electron smoke/ui2.cjs --user-data-dir=...
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
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()

  // Start from empty stores. This suite counts open panes against listed rows,
  // asserts the exact text a snippet put into the terminal, and checks that an
  // edit renames in place — inheriting a session, a pane or a snippet from a
  // previous run makes all three wrong, so it only ever passed on a fresh machine.
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

  // Trust the test host so host-key policy never masks the flows under test.
  await win.webContents.executeJavaScript(
    `window.termdeck.loadSettings().then(s =>
       window.termdeck.saveSettings({ ...s, hostKeys: { policy: 'trust' } }))`
  )
  await sleep(300)

  // ---- 1. sidebar connect + visible failure ------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // A saved session with no credential must be refused up front with a
      // visible, actionable message rather than an opaque handshake failure.
      let tree = await api.saveSession({
        name: 'no-cred-session', host: '10.255.255.1', port: 22, username: 'ghost',
        authMethod: 'password', tags: []
      })
      const broken = tree.sessions.find((s) => s.name === 'no-cred-session')
      push('fixture session created', !!broken)

      await new Promise((r) => setTimeout(r, 600))

      const row = document.querySelector('.td-node[data-node-id="' + broken.id + '"]')
      push('row rendered', !!row)
      if (!row) return out

      // Single click selects but must not connect.
      ;(row.querySelector('.td-node-main')).click()
      await new Promise((r) => setTimeout(r, 500))
      push('single click selects the row', row.classList.contains('is-selected'),
        'classes=' + row.className)
      push('single click does not connect', !document.querySelector('[data-testid="connect-alert"]'))

      // Double click connects; with no credential this must ask for one.
      row.querySelector('.td-node-main').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
      let prompt = null
      // A saved session with password auth but no stored password now opens the
      // connect prompt rather than dead-ending on an alert.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        prompt = document.querySelector('[data-testid="password-prompt"]')
        if (prompt) break
      }
      push('missing password opens the connect prompt', !!prompt,
        prompt ? 'prompt shown' : 'no prompt')
      push('no pane opened before a password is supplied',
        ![...document.querySelectorAll('.dv-tab')].some((t) => t.textContent.includes('no-cred-session')),
        [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent.trim()).join(' | '))

      if (prompt) {
        push('prompt explains what is missing',
          /password/i.test(prompt.textContent || ''),
          (prompt.querySelector('.td-hint') || {}).textContent?.slice(0, 60) || 'n/a')
        const cancelPrompt = [...prompt.querySelectorAll('button')]
          .find((b) => /^Cancel$/.test((b.textContent || '').trim()))
        cancelPrompt.click()
        await new Promise((r) => setTimeout(r, 300))
        push('prompt is dismissible', !document.querySelector('[data-testid="password-prompt"]'))
      }

      // A real connect from the sidebar must open a pane.
      tree = await api.saveSession({
        name: 'real-session', host: ${JSON.stringify(SSH_HOST)}, port: 22, username: ${JSON.stringify(SSH_USER)},
        authMethod: 'key', privateKeyPath: ${JSON.stringify(SSH_KEY)}, tags: []
      })
      const real = tree.sessions.find((s) => s.name === 'real-session')
      await new Promise((r) => setTimeout(r, 600))
      const realRow = document.querySelector('.td-node[data-node-id="' + real.id + '"]')
      push('real session row rendered', !!realRow)
      if (realRow) {
        realRow.querySelector('.td-node-main').dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        )
        let tabs = []
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => setTimeout(r, 300))
          tabs = [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())
          if (tabs.some((t) => t.includes('real-session'))) break
        }
        push('double-click connects and opens a pane',
          tabs.some((t) => t.includes('real-session')), tabs.join(' | '))
      }

      return out
    })()`)
  )

  // ---- 2. context menus --------------------------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      const tree = await api.loadSessionTree()
      const session = tree.sessions.find((s) => s.name === 'no-cred-session')
      await new Promise((r) => setTimeout(r, 400))

      const row = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 200
      }))
      await new Promise((r) => setTimeout(r, 300))

      const menu = document.querySelector('[data-testid="context-menu"]')
      push('session context menu opens', !!menu)
      if (!menu) return out

      const items = [...menu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id'))
      push('session menu has the expected actions',
        ['connect', 'edit', 'duplicate', 'copyHost', 'delete'].every((id) => items.includes(id)),
        items.join(','))

      // Duplicate through the menu.
      menu.querySelector('[data-menu-id="duplicate"]').click()
      await new Promise((r) => setTimeout(r, 700))
      const afterDup = await api.loadSessionTree()
      push('duplicate created a copy',
        afterDup.sessions.some((s) => s.name === 'no-cred-session copy'),
        afterDup.sessions.length + ' sessions')

      // Menu closes after an action.
      push('menu closes after choosing an item',
        !document.querySelector('[data-testid="context-menu"]'))

      // Edit through the menu opens the session editor.
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 220 }))
      await new Promise((r) => setTimeout(r, 300))
      document.querySelector('[data-menu-id="edit"]').click()
      await new Promise((r) => setTimeout(r, 500))
      push('edit opens the session editor', !!document.querySelector('[data-testid="session-save"]'))
      const cancel = [...document.querySelectorAll('.td-drawer button')]
        .find((b) => /^Cancel$/.test((b.textContent || '').trim()))
      cancel.click()
      await new Promise((r) => setTimeout(r, 400))

      // Folder menu.
      const f = await api.saveFolder({ name: 'menu-folder' })
      const folder = f.folders.find((x) => x.name === 'menu-folder')
      await new Promise((r) => setTimeout(r, 500))
      const folderRow = document.querySelector('.td-node[data-node-id="' + folder.id + '"]')
      folderRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 260 }))
      await new Promise((r) => setTimeout(r, 300))
      const fmenu = document.querySelector('[data-testid="context-menu"]')
      const fitems = fmenu ? [...fmenu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id')) : []
      push('folder menu has the expected actions',
        ['newSessionHere', 'newFolderHere', 'renameFolder', 'deleteFolder'].every((id) => fitems.includes(id)),
        fitems.join(','))

      // "New session here" should preselect that folder.
      fmenu.querySelector('[data-menu-id="newSessionHere"]').click()
      await new Promise((r) => setTimeout(r, 700))
      const folderSelect = document.querySelector('[data-testid="session-form"] [aria-label="session-folder"]')
      push('folder is preselected for a new session',
        !!folderSelect && folderSelect.value === folder.id,
        folderSelect ? folderSelect.value : 'no select')
      const cancel2 = [...document.querySelectorAll('.td-drawer button')]
        .find((b) => /^Cancel$/.test((b.textContent || '').trim()))
      cancel2.click()
      await new Promise((r) => setTimeout(r, 400))

      // Right-clicking empty tree space offers root actions.
      const root = document.querySelector('.td-tree-root')
      root.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 240, clientY: 620
      }))
      await new Promise((r) => setTimeout(r, 300))
      const rmenu = document.querySelector('[data-testid="context-menu"]')
      const ritems = rmenu ? [...rmenu.querySelectorAll('[data-menu-id]')].map((b) => b.getAttribute('data-menu-id')) : []
      push('empty-area menu offers root actions',
        ritems.includes('newFolderRoot') && ritems.includes('newSessionRoot'), ritems.join(','))
      const newFolder = rmenu.querySelector('[data-menu-id="newFolderRoot"]')
      newFolder.click()
      await new Promise((r) => setTimeout(r, 700))
      const afterFolder = await api.loadSessionTree()
      push('root menu created a folder',
        afterFolder.folders.filter((f) => f.name === 'New folder').length > 0,
        afterFolder.folders.length + ' folders')

      return out
    })()`)
  )

  // ---- 3. connections window ---------------------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const btn = document.querySelector('[data-testid="open-connections"]')
      push('connections button present', !!btn)
      btn.click()
      await new Promise((r) => setTimeout(r, 500))

      const win2 = document.querySelector('[data-testid="connections-drawer"]')
      push('connections window opens', !!win2)
      if (!win2) return out

      const rows = [...win2.querySelectorAll('tbody tr')]
      push('window lists open connections', rows.length >= 1, rows.length + ' row(s)')

      const tabs = [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())
      push('listed rows match open panes', rows.length === tabs.length,
        rows.length + ' rows vs ' + tabs.length + ' tabs: ' + tabs.join(' | '))

      const first = rows[0]
      push('rows expose Focus and Close',
        !!first.querySelector('[data-action="focus"]') && !!first.querySelector('[data-action="close"]'))

      // Focus should activate that panel and dismiss the window.
      first.querySelector('[data-action="focus"]').click()
      await new Promise((r) => setTimeout(r, 600))
      push('focus dismisses the window', !document.querySelector('[data-testid="connections-drawer"]'))

      // Re-open and close a connection from the window.
      btn.click()
      await new Promise((r) => setTimeout(r, 400))
      const w2 = document.querySelector('[data-testid="connections-drawer"]')
      const before = w2.querySelectorAll('tbody tr').length
      w2.querySelector('tbody tr [data-action="close"]').click()
      await new Promise((r) => setTimeout(r, 900))
      const after = document.querySelectorAll('[data-testid="connections-drawer"] tbody tr').length
      push('close removes the connection', after === before - 1, before + ' -> ' + after)

      const dismiss = [...document.querySelectorAll('[data-testid="connections-drawer"] button')]
        .find((b) => /Close window/.test(b.textContent || ''))
      dismiss.click()
      await new Promise((r) => setTimeout(r, 300))

      return out
    })()`)
  )

  // ---- 4. snippet bar ----------------------------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      push('snippet bar rendered', !!document.querySelector('[data-testid="snippet-bar"]'))

      // Create through the UI.
      document.querySelector('[data-testid="snippet-new"]').click()
      await new Promise((r) => setTimeout(r, 500))
      const editor = document.querySelector('[data-testid="snippet-editor"]')
      push('snippet editor opens', !!editor)
      if (!editor) return out

      const f = (label) => document.querySelector('[aria-label="' + label + '"]')
      const setValue = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      setValue(f('snippet-label'), 'whoami-check')
      setValue(f('snippet-command'), 'whoami')
      setValue(f('snippet-new-group'), 'probe-group')
      await new Promise((r) => setTimeout(r, 300))

      document.querySelector('[data-testid="snippet-save"]').click()
      await new Promise((r) => setTimeout(r, 800))
      push('editor closed after save', !document.querySelector('[data-testid="snippet-editor"]'))

      const settings = await api.loadSettings()
      const saved = settings.snippets.find((s) => s.label === 'whoami-check')
      push('snippet persisted', !!saved,
        saved ? 'group=' + saved.group + ' sendEnter=' + saved.sendEnter : 'missing')
      push('snippet stored in the chosen group', saved && saved.group === 'probe-group')

      const groupTab = [...document.querySelectorAll('.td-snippet-group')]
        .find((b) => b.textContent.startsWith('probe-group'))
      push('group tab derived from snippets', !!groupTab,
        [...document.querySelectorAll('.td-snippet-group')].map((b) => b.textContent.trim()).join(' | '))

      const button = document.querySelector('[data-snippet-label="whoami-check"]')
      push('snippet button rendered', !!button)
      if (button) {
        groupTab.click()
        await new Promise((r) => setTimeout(r, 300))
        push('group filter keeps the snippet visible',
          !!document.querySelector('[data-snippet-label="whoami-check"]'))
      }

      return out
    })()`)
  )

  // Sending a snippet must reach the live terminal.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      // Make sure a local shell is the active terminal.
      const localBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      push('a local shell button is available', !!localBtn)
      if (!localBtn) return out
      localBtn.click()
      await new Promise((r) => setTimeout(r, 3500))

      // The pane this click activated, so every read below targets it rather than
      // whichever terminal happens to come first in the DOM. Clicking the button
      // can focus an existing local shell instead of opening one, so this cannot
      // rely on the session id being new — it picks by session kind.
      const localBtnSession = () => {
        const reg = window.__tdTerminals || {}
        const entries = Object.values(reg).filter((e) => e && e.term)
        const local = entries.filter((e) => e.session && e.session.kind === 'local')
        const entry = (local.length ? local : entries)[0]
        return entry ? { term: entry.term, element: entry.term.element } : null
      }

      // Start from a clean screen and read *this* pane. These two checks are about
      // what this run sent; a previous run's unexecuted line stays on the prompt
      // line, and a plain .xterm-rows query matches whichever pane comes first in
      // the DOM, so both the buffer and the target have to be pinned down here.
      const target = localBtnSession()
      if (target) target.term.reset()
      await new Promise((r) => setTimeout(r, 600))
      const screenText = () => (target && target.element
        ? (target.element.querySelector('.xterm-rows') || {}).textContent || ''
        : '')

      const marker = 'echo TD_SNIPPET_' + Date.now()
      await window.termdeck.saveSnippet({
        label: 'send-probe', command: marker, group: 'probe-group', sendEnter: true
      })
      await new Promise((r) => setTimeout(r, 700))

      const button = document.querySelector('[data-snippet-label="send-probe"]')
      push('new snippet button appears', !!button)
      if (!button) return out

      button.click()

      let rows = ''
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200))
        rows = screenText()
        if (rows.includes(marker)) break
      }
      push('clicking a snippet sends it to the terminal', rows.includes(marker),
        JSON.stringify(rows.trim().slice(-50)))

      // sendEnter = false must only type, not run.
      const typed = 'echo TD_TYPED_' + Date.now()
      await window.termdeck.saveSnippet({
        label: 'type-only', command: typed, group: 'probe-group', sendEnter: false
      })
      await new Promise((r) => setTimeout(r, 700))
      const typeBtn = document.querySelector('[data-snippet-label="type-only"]')
      push('type-only snippet rendered', !!typeBtn)
      if (typeBtn) {
        typeBtn.click()
        await new Promise((r) => setTimeout(r, 1500))
        const text = screenText()
        push('sendEnter=false types without running',
          text.includes(typed) && text.match(new RegExp(typed + '[^]*?TD_TYPED_\\\\d+\\\\s*\\\\n')) === null,
          JSON.stringify(text.trim().slice(-60)))
      }

      return out
    })()`)
  )

  // Edit and delete through the snippet popup menu.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      const button = document.querySelector('[data-snippet-label="whoami-check"]')
      push('target snippet present', !!button)
      if (!button) return out

      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 300))
      const menu = document.querySelector('[data-testid="snippet-menu"]')
      push('snippet menu opens', !!menu)
      if (!menu) return out

      const actions = [...menu.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'))
      push('snippet menu has send/edit/duplicate/delete',
        ['send', 'edit', 'duplicate', 'delete'].every((a) => actions.includes(a)), actions.join(','))

      // Edit prefills the existing values.
      menu.querySelector('[data-action="edit"]').click()
      await new Promise((r) => setTimeout(r, 500))
      const label = document.querySelector('[aria-label="snippet-label"]')
      const command = document.querySelector('[aria-label="snippet-command"]')
      push('edit prefills the snippet',
        !!label && label.value === 'whoami-check' && command.value === 'whoami',
        label ? label.value + ' / ' + command.value : 'no editor')

      const setValue = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setValue(label, 'whoami-renamed')
      await new Promise((r) => setTimeout(r, 200))
      document.querySelector('[data-testid="snippet-save"]').click()
      await new Promise((r) => setTimeout(r, 800))

      const after = await api.loadSettings()
      push('edit renames in place (no duplicate)',
        after.snippets.some((s) => s.label === 'whoami-renamed') &&
          !after.snippets.some((s) => s.label === 'whoami-check'),
        after.snippets.map((s) => s.label).join(','))

      // Delete through the menu.
      const renamed = document.querySelector('[data-snippet-label="whoami-renamed"]')
      push('renamed snippet rendered', !!renamed)
      if (renamed) {
        renamed.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 300))
        document.querySelector('[data-testid="snippet-menu"] [data-action="delete"]').click()
        await new Promise((r) => setTimeout(r, 800))
        const final = await api.loadSettings()
        push('delete removes the snippet',
          !final.snippets.some((s) => s.label === 'whoami-renamed'),
          final.snippets.map((s) => s.label).join(','))
      }

      return out
    })()`)
  )

  if (consoleErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of consoleErrors.slice(0, 12)) console.log('  ' + e)
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('ui2 probe crashed:', err)
    app.exit(1)
  })
)
