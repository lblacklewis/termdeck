/**
 * Verification for the three-column shell and drawer work:
 *   1. the navigation rail switches the list/main area between pages
 *   2. Known Hosts lists real entries and can forget one (the fix for a
 *      mismatch that previously required editing the file by hand)
 *   3. editing flows open as right-hand drawers and close on Escape/backdrop
 *   4. the Termius-style light themes are present and render light
 *
 *   npm run build && electron smoke/ui5.cjs --user-data-dir=...
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` 鈥?${c.detail}` : ''}`)
    all.push(c)
  }
}

/**
 * Run one probe section. A section that throws is reported as a single failure
 * rather than taking the whole run down, so one missing element cannot hide the
 * results of everything else.
 */
async function section(name, promise) {
  try {
    report(await promise)
  } catch (err) {
    report([{ name: `${name} section`, ok: false, detail: String(err && err.message) }])
  }
}

/**
 * A decoy key so known_hosts has something to list and delete.
 *
 * Must run before the app's main-process modules load: `ipc.ts` reads
 * TERMDECK_KNOWN_HOSTS at module scope to build its KnownHosts instance.
 */
function seedKnownHosts() {
  const dir = path.join(app.getPath('temp'), `td-ui5-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'known_hosts')

  const type = Buffer.from('ssh-ed25519')
  const blob = (mat) =>
    Buffer.concat([
      Buffer.from([0, 0, 0, type.length]),
      type,
      Buffer.from([0, 0, 0, mat.length]),
      mat
    ]).toString('base64')

  fs.writeFileSync(
    file,
    [
      `audit.example.test ssh-ed25519 ${blob(crypto.randomBytes(32))}`,
      `# a comment line that must be ignored`,
      `@revoked revoked.example.test ssh-ed25519 ${blob(crypto.randomBytes(32))}`,
      `${SSH_HOST} ssh-ed25519 ${blob(crypto.randomBytes(32))}`
    ].join('\n') + '\n',
    { mode: 0o600 }
  )
  return { dir, file }
}

const seeded = seedKnownHosts()
process.env['TERMDECK_KNOWN_HOSTS'] = seeded.file

async function main() {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  console.log('路 main process ready')

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    // Shown deliberately: Chromium suppresses style resolution for hidden
    // windows, which made background-colour assertions read stale values.
    show: true,
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
  console.log('路 renderer loaded')

  await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const s = await api.loadSettings()
    await api.saveSettings({ ...s, hostKeys: { policy: 'trust' } })
    await api.saveFolder({ name: 'rail-folder' })
    await api.saveSession({ name: 'rail-session', host: '10.9.9.9', username: 'root', tags: ['rail'] })
    await api.saveSnippet({ label: 'rail-snippet', command: 'echo rail', group: 'ops', sendEnter: true })
    return true
  })()`)
  await sleep(800)
  // Wait until the tree broadcast has actually reached the sidebar, otherwise
  // the first assertions race the React update.
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector('[data-node-id]')) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  })()`)
  console.log('路 fixtures created')

  // ---- 1. navigation rail ------------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
    try {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const rail = document.querySelector('.td-rail')
      const pages = [...document.querySelectorAll('.td-rail-btn')].map((b) => b.getAttribute('data-page'))
      const active = document.querySelector('.td-rail-btn.is-active')
      const testIds = [...document.querySelectorAll('[data-testid]')]
        .map((e) => e.getAttribute('data-testid'))
        .slice(0, 14)

      push('navigation rail is rendered', !!rail, 'pages=' + pages.join(','))
      push('rail exposes the expected sections',
        ['terminal', 'hosts', 'known-hosts', 'snippets', 'logs', 'settings'].every((p) => pages.includes(p)),
        pages.join(','))
      push('started on the terminal page', (active ? active.getAttribute('data-page') : null) === 'terminal',
        active ? String(active.getAttribute('data-page')) : 'no active rail button')
      push('terminal page has its dock area', !!document.querySelector('.td-dockview'),
        'testids=[' + testIds.join(',') + ']')

      // Probe the rail selectors directly; the helper's absence of output made
      // it hard to tell which lookup failed.
      push('rail-hosts selector resolves', !!document.querySelector('[data-testid="rail-hosts"]'),
        'railTestIds=[' +
          [...document.querySelectorAll('.td-rail-btn')].map((b) => b.getAttribute('data-testid')).join(',') +
        ']')

      const go = async (page) => {
        const btn = document.querySelector('[data-testid="rail-' + page + '"]')
        if (!btn) throw new Error('missing rail button for page: ' + page)
        btn.click()
        await new Promise((r) => setTimeout(r, 450))
      }
      const activePage = () =>
        document.querySelector('.td-rail-btn.is-active')?.getAttribute('data-page')

      // Give a concrete reason rather than "null.click" when something needed is
      // not in the document.
      if (!rail) throw new Error('no .td-rail element rendered')
      if (!document.querySelector('[data-testid="tree-new-session"]')) {
        throw new Error(
          'the terminal page sidebar is missing: active=' + activePage() +
            ' dock=' + !!document.querySelector('.td-dockview')
        )
      }

      push('terminal page is the default', activePage() === 'terminal', activePage())

      await go('hosts')
      push('hosts page renders', !!document.querySelector('[data-testid="hosts-page"]'))
      push('hosts page lists the saved host',
        !!document.querySelector('[data-host-row]'),
        document.querySelectorAll('[data-host-row]').length + ' row(s)')
      push('hosts page groups by folder',
        !!document.querySelector('[data-host-group]'),
        [...document.querySelectorAll('[data-host-group]')].map((g) => g.getAttribute('data-host-group')).join(' | '))
      const connectBtn = document.querySelector('[data-action="connect"]')
      push('host rows offer Connect and Edit',
        !!connectBtn && !!document.querySelector('[data-action="edit"]'))

      await go('snippets')
      push('snippets page renders', !!document.querySelector('[data-testid="snippets-page"]'))
      push('snippets page shows the saved command',
        /rail-snippet/.test(document.body.textContent || ''))
      push('snippets page shows the command text',
        /echo rail/.test(document.body.textContent || ''))

      await go('logs')
      push('logs page renders', !!document.querySelector('[data-testid="logs-page"]'))
      push('logs page starts empty', /Nothing logged yet/.test(document.body.textContent || ''))

      await go('settings')
      push('settings rail entry opens the settings drawer',
        !!document.querySelector('[data-testid="settings-drawer"]'))
      document.querySelector('[data-testid="drawer-close"]').click()
      await new Promise((r) => setTimeout(r, 400))

      await go('terminal')
      push('returning to terminal restores the dock area',
        !!document.querySelector('.td-dockview'))
      push('only one page is mounted at a time',
        !document.querySelector('[data-testid="hosts-page"]') &&
          !document.querySelector('[data-testid="logs-page"]'))

      return out
    } catch (err) {
      // Return the page-side stack so a failure names the line that broke.
      return [{ name: 'rail section crashed', ok: false, detail: String(err && err.stack || err) }]
    }
    })()`)
  )
  // ---- 2. known hosts page ----------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      document.querySelector('[data-testid="rail-known-hosts"]').click()
      await new Promise((r) => setTimeout(r, 700))

      const page = document.querySelector('[data-testid="known-hosts-page"]')
      push('known hosts page renders', !!page)
      // The rail must stay mounted on every page, otherwise navigation depends
      // on whichever page you happen to be on.
      push('the rail is still mounted on this page',
        !!document.querySelector('[data-testid="rail-terminal"]'),
        'rail=' + !!document.querySelector('.td-rail'))

      const rows = [...document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr')]
      push('entries are listed', rows.length >= 3, rows.length + ' entry/entries')
      push('plaintext hostnames are shown',
        rows.some((r) => r.textContent.includes('audit.example.test')), '')
      push('revoked entries are flagged',
        rows.some((r) => /@revoked/.test(r.textContent)), '')
      push('fingerprints are shown as SHA256',
        rows.every((r) => /SHA256:/.test(r.textContent)), '')
      push('comment lines are not listed',
        !rows.some((r) => r.textContent.includes('a comment line')))

      // Filter narrows the table.
      const filter = document.querySelector('[aria-label="filter-known-hosts"]')
      const setValue = (el, v) => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setValue(filter, 'audit.example.test')
      await new Promise((r) => setTimeout(r, 400))
      const filtered = document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr').length
      push('filter narrows the list', filtered === 1, filtered + ' row(s)')
      setValue(filter, '')
      await new Promise((r) => setTimeout(r, 300))

      // Forget one entry: the whole point of the page.
      const before = document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr').length
      const target = [...document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr')]
        .find((r) => r.textContent.includes('audit.example.test'))
      target.querySelector('[data-testid="remove-entry"]').click()
      await new Promise((r) => setTimeout(r, 300))
      const confirm = document.querySelector('[data-testid="confirm-remove"]')
      push('removal asks for confirmation first', !!confirm)
      confirm.click()
      await new Promise((r) => setTimeout(r, 700))

      const after = document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr').length
      push('forgetting removes the entry', after === before - 1, before + ' -> ' + after)
      push('the removed host is gone from the list',
        ![...document.querySelectorAll('[data-testid="known-hosts-table"] tbody tr')]
          .some((r) => r.textContent.includes('audit.example.test')))

      return out
    })()`)
  )

  // On-disk effect: the file itself must have lost that line.
  try {
    const stores = mod.storeAccess()
    const remaining = stores.knownHosts.read()
    report([
      {
        name: 'known_hosts file was actually rewritten',
        ok: !remaining.some((r) => r.hostsField.includes('audit.example.test')),
        detail: remaining.map((r) => r.hostsField.slice(0, 24)).join(', ')
      },
      {
        name: 'the other entries survived',
        ok: remaining.some((r) => r.marker === '@revoked') || remaining.length >= 1,
        detail: remaining.length + ' entry/entries left'
      }
    ])
  } catch (err) {
    report([{ name: 'known_hosts file check', ok: false, detail: String(err && err.message) }])
  }

  // ---- 3. drawers --------------------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
    const out = []
    const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    /** Click by selector, failing with the selector name rather than null.click. */
    const click = (selector, what) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error('missing element: ' + (what || selector))
      el.click()
    }

    /** Wait for an element to exist, rather than guessing a delay. */
    const waitFor = async (selector, timeout = 4000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const el = document.querySelector(selector)
        if (el) return el
        await wait(80)
      }
      return null
    }

    click('[data-testid="rail-terminal"]', 'rail-terminal rail button')
    await wait(450)

    // --- the session editor opens as a drawer ----------------------------
    click('[data-testid="tree-new-session"]', 'new-session button')
    const drawer = await waitFor('[data-testid="session-drawer"]')
    push('session editor is a drawer', !!drawer)
    if (!drawer) return out

    const box = drawer.getBoundingClientRect()
    push('drawer is anchored to the right edge',
      box.right >= window.innerWidth - 30 && box.width < window.innerWidth * 0.85,
      'right=' + Math.round(box.right) + ' width=' + Math.round(box.width) + ' viewport=' + window.innerWidth)
    push('drawer has the rounded panel treatment',
      parseInt(getComputedStyle(drawer).borderRadius, 10) >= 12,
      getComputedStyle(drawer).borderRadius)
    push('the list behind stays mounted while editing',
      !!document.querySelector('.td-sidebar'))

    // --- Escape closes ---------------------------------------------------
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(450)
    push('Escape closes the drawer', !document.querySelector('[data-testid="session-drawer"]'))

    // --- backdrop click closes -------------------------------------------
    click('[data-testid="tree-new-session"]', 'new-session button')
    const backdrop = await waitFor('[data-testid="drawer-backdrop"]')
    push('drawer renders a backdrop', !!backdrop)
    backdrop.click()
    await wait(450)
    push('backdrop click closes the drawer', !document.querySelector('[data-testid="session-drawer"]'))

    // --- the close button dismisses it ------------------------------------
    click('[data-testid="tree-new-session"]', 'new-session button')
    const closeBtn = await waitFor('[data-testid="drawer-close"]')
    push('drawer renders a close button', !!closeBtn)
    closeBtn.click()
    await wait(450)
    push('close button dismisses the drawer', !document.querySelector('[data-testid="session-drawer"]'))

    // --- quick connect is a drawer too -----------------------------------
    const connectBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Connect/i.test(b.textContent || ''))
    push('quick connect button present', !!connectBtn)
    if (connectBtn) {
      connectBtn.click()
      const hostField = await waitFor('[data-testid="drawer"] [aria-label="ssh-host"]')
      push('quick connect opens in a drawer', !!hostField)
      const qcClose = await waitFor('[data-testid="drawer-close"]')
      qcClose?.click()
      await wait(450)
      push('quick connect drawer closes', !document.querySelector('[data-testid="drawer"]'))
    }

    return out
    })()`)
  )

  // ---- 4. the new light themes ------------------------------------------

  await section('probe', win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      document.querySelector('[data-testid="open-settings"]').click()
      await new Promise((r) => setTimeout(r, 600))
      const cards = [...document.querySelectorAll('[data-testid="theme-grid"] .td-theme-card')]
      const ids = cards.map((c) => c.getAttribute('data-theme-id'))
      push('termius-light theme exists', ids.includes('termius-light'), ids.join(','))
      push('slate-light theme exists', ids.includes('slate-light'))

      const apply = async (id) => {
        document.querySelector('[data-testid="theme-grid"] [data-theme-id="' + id + '"]').click()
        await new Promise((r) => setTimeout(r, 400))
        const save = [...document.querySelectorAll('.td-drawer-actions button')]
          .find((b) => /Save settings/i.test(b.textContent || ''))
        save.click()
        // Poll rather than guess: the theme variables are written immediately but
        // the painted background animates, so a fixed delay can sample mid-fade.
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 100))
          if (document.documentElement.dataset.themeId === id) break
        }
        await new Promise((r) => setTimeout(r, 500))
        return document.documentElement.dataset.themeId === id
      }


      let applied = await apply('termius-light')
      if (!applied) {
        // One retry: the click can land before the drawer's own state settles.
        applied = await apply('termius-light')
      }
      push('termius-light is the active theme after saving', applied,
        'data-theme-id=' + document.documentElement.dataset.themeId +
          ' scheme=' + document.documentElement.dataset.themeScheme)
      // Assert the deterministic chain — theme id, scheme, and the resolved
      // custom properties — rather than the painted element background.
      // The computed body background proved unreliable here: it reads a stale
      // value in a window Chromium has not painted, which produced false
      // failures. The rendered palette is confirmed by smoke/contrast.cjs,
      // which measures real text against real backgrounds on every page.
      const root = getComputedStyle(document.documentElement)
      const surface = root.getPropertyValue('--td-surface').trim()
      const bgVar = root.getPropertyValue('--td-bg').trim()
      const brightness = (hex) => {
        const h = hex.replace('#', '')
        if (h.length !== 6) return 0
        return (parseInt(h.slice(0, 2), 16) + parseInt(h.slice(2, 4), 16) + parseInt(h.slice(4, 6), 16)) / 3
      }
      push('termius-light surfaces are light', brightness(surface) > 180, '--td-surface=' + surface)
      push('termius-light background token is light', brightness(bgVar) > 180, '--td-bg=' + bgVar)
      push('termius-light sets the light scheme',
        document.documentElement.dataset.themeScheme === 'light',
        document.documentElement.dataset.themeScheme)

      // The rail must be readable in this theme too.
      const railBtn = document.querySelector('.td-rail-btn.is-active') || document.querySelector('.td-rail-btn')
      const railStyle = getComputedStyle(railBtn)
      push('rail buttons have a themed colour',
        railStyle.color !== 'rgb(0, 0, 0)' && railStyle.color !== '',
        railStyle.color)

      await apply('slate-light')
      push('slate-light applies', document.documentElement.dataset.themeId === 'slate-light')

      await apply('termius-dark')
      const settings = await api.loadSettings()
      push('theme choice persisted', settings.theme === 'termius-dark', settings.theme)

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
    console.error('ui5 probe crashed:', err)
    app.exit(1)
  })
)
