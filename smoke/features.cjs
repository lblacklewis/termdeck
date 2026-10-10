/**
 * Feature verification for the vault, saved sessions, host-key policy and
 * clipboard behaviour.
 *
 *   npm run build && electron smoke/features.cjs
 *
 * Runs inside Electron against a throwaway `--user-data-dir`, so it never
 * touches the user's real settings, session tree or vault.
 */
const path = require('node:path')
const os = require('node:os')
const { app, BrowserWindow, clipboard } = require('electron')

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
  // Wipe the profile before anything constructs a store. The stores cache
  // their contents in memory, so deleting their files afterwards leaves the
  // previous run's data in place and the next write puts it back on disk.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  mod.registerIpc()

  // This suite asserts exact folder/session/tag counts and default settings, so
  // it has to start from empty stores — it used to inherit whatever the previous
  // run left behind (an edited font size, copy-on-select off, extra sessions)
  // and only ever passed on a fresh machine.
  const removed = require(path.join(__dirname, 'clearstore.cjs')).resetStores([
    'sessions',
    'settings'
  ])

  // The clipboard suite overwrites the OS clipboard; put the user's content
  // back on the way out so running the suite is not destructive.
  const savedClipboard = clipboard.readText()
  process.on('exit', () => {
    try {
      clipboard.writeText(savedClipboard)
    } catch {
      /* ignore */
    }
  })

  const stores = mod.storeAccess()
  console.log(`config dir: ${stores.configDir}`)
  if (removed.length) console.log(`cleared: ${removed.join(', ')}`)
  console.log('')

  // ---- 1. credential store -----------------------------------------------

  report(
    await (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const store = stores.credentials

      try {
        const status = store.status()
        push('credentials are encrypted by default', status.encrypted === true,
          `backend=${status.backend}`)
        push('no master password is involved',
          /no master password|not against full disk/i.test(status.detail),
          status.detail.slice(0, 60))
        push('backend is the OS keychain when available',
          status.backend === 'os' || status.backend === 'local', status.backend)

        const sessionId = 'cred-suite-' + Date.now()
        store.set(sessionId, { password: 'sup3r-s3cret!', passphrase: 'key-phrase' })
        push('password round-trips', store.get(sessionId).password === 'sup3r-s3cret!')
        push('passphrase round-trips', store.get(sessionId).passphrase === 'key-phrase')
        push('has() reports presence without the value',
          store.has(sessionId).password === true && store.has(sessionId).passphrase === true)

        // The file must not contain the plaintext, and must be a sealed payload.
        const raw = require('node:fs').readFileSync(
          require('node:path').join(stores.configDir, 'credentials.json'),
          'utf8'
        )
        push('plaintext is not on disk', !raw.includes('sup3r-s3cret!'), `${raw.length} bytes`)
        push('sealed fields carry iv and tag',
          /"iv":/.test(raw) && /"tag":/.test(raw) && /"data":/.test(raw),
          'AES-256-GCM iv/tag/data per field')

        // Tampering must be detected, not silently decrypted.
        const tampered = path.join(stores.configDir, 'tampered.json')
        const parsed = JSON.parse(raw)
        const firstKey = Object.keys(parsed.entries)[0]
        const sealed = parsed.entries[firstKey].password.data
        parsed.entries[firstKey].password.data =
          (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1)
        require('node:fs').writeFileSync(tampered, JSON.stringify(parsed))

        const StoreEarly = mod.CredentialStore
        const tamperedDir = path.join(app.getPath('temp'), 'td-cred-tamper-' + Date.now())
        require('node:fs').mkdirSync(tamperedDir, { recursive: true })
        require('node:fs').copyFileSync(tampered, path.join(tamperedDir, 'credentials.json'))
        for (const suffix of ['.credential-seed', '.credential-seed.os']) {
          const from = path.join(stores.configDir, suffix)
          if (require('node:fs').existsSync(from)) {
            require('node:fs').copyFileSync(from, path.join(tamperedDir, suffix))
          }
        }
        const tamperedStore = new StoreEarly(tamperedDir)
        push('tampered ciphertext is rejected, not decrypted',
          tamperedStore.get(firstKey).password === undefined,
          'authentication tag check failed as intended')
        require('node:fs').rmSync(tamperedDir, { recursive: true, force: true })
        require('node:fs').rmSync(tampered, { force: true })

        // A fresh store instance (same profile) must decrypt what was written.
        const Store = mod.CredentialStore
        const reopened = new Store(stores.configDir)
        push('persists across store instances',
          reopened.get(sessionId).password === 'sup3r-s3cret!' &&
            reopened.get(sessionId).passphrase === 'key-phrase')

        // Explicit reveal, and clearing.
        push('revealPassword returns the value',
          reopened.revealPassword(sessionId) === 'sup3r-s3cret!')
        reopened.remove(sessionId)
        push('remove drops the credential',
          !reopened.has(sessionId).password && new Store(stores.configDir).get(sessionId).password === undefined)

        // Clearing one field keeps the other.
        const two = 'cred-suite-two-' + Date.now()
        reopened.set(two, { password: 'pw-one', passphrase: 'pp-two' })
        push('both fields stored together',
          reopened.get(two).password === 'pw-one' && reopened.get(two).passphrase === 'pp-two')

        // A partial update must not drop the field it did not mention.
        reopened.set(two, { password: 'pw-updated' })
        push('partial update preserves the other field',
          reopened.get(two).password === 'pw-updated' && reopened.get(two).passphrase === 'pp-two',
          'merge semantics')

        // An empty string is how a caller clears a field explicitly.
        reopened.set(two, { passphrase: '' })
        push('empty string clears only that field',
          reopened.get(two).password === 'pw-updated' && reopened.get(two).passphrase === undefined)
        reopened.remove(two)
      } catch (err) {
        push('credential suite', false, err && err.message)
      }

      return out
    })()
  )

  // ---- 2. session tree: nesting + tags -----------------------------------

  report(
    await (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const store = stores.sessions

      try {
        // Three levels: prod -> web -> eu
        let tree = store.upsertFolder({ name: 'prod' })
        const prod = tree.folders.find((f) => f.name === 'prod')
        tree = store.upsertFolder({ name: 'web', parentId: prod.id })
        const web = tree.folders.find((f) => f.name === 'web')
        tree = store.upsertFolder({ name: 'eu', parentId: web.id })
        const eu = tree.folders.find((f) => f.name === 'eu')

        push('nested folders created', tree.folders.length === 3,
          tree.folders.map((f) => `${f.name}<-${f.parentId ? 'parent' : 'root'}`).join(', '))
        push('third level has correct parent', eu.parentId === web.id)
        push('second level has correct parent', web.parentId === prod.id)

        tree = store.upsertSession({
          name: 'eu-web-1',
          host: '10.0.0.5',
          port: 22,
          username: 'deploy',
          authMethod: 'key',
          privateKeyPath: '/home/me/.ssh/id_ed25519',
          tags: ['prod', 'eu', 'web'],
          parentId: eu.id
        })
        const session = tree.sessions[0]
        push('session saved with tags', session.tags.length === 3, session.tags.join(','))

        // Cycle protection: cannot move a folder into its own descendant.
        let cycleBlocked = false
        try {
          store.moveFolder(prod.id, eu.id)
        } catch (err) {
          cycleBlocked = /own subtree/.test(err.message)
        }
        push('folder cycle rejected', cycleBlocked)

        // Moving a session between folders.
        tree = store.moveSession(session.id, web.id)
        push('session moved to another folder',
          tree.sessions[0].parentId === web.id)

        // Deleting a folder removes its whole subtree and its sessions.
        tree = store.deleteFolder(prod.id)
        push('subtree delete cascades',
          tree.folders.length === 0 && tree.sessions.length === 0,
          `${tree.folders.length} folders, ${tree.sessions.length} sessions`)

        // Tags aggregate across sessions.
        store.upsertSession({ name: 'a', host: 'h1', username: 'u', tags: ['x', 'y'] })
        store.upsertSession({ name: 'b', host: 'h2', username: 'u', tags: ['y', 'z'] })
        const tags = store.allTags()
        push('allTags aggregates', tags.join(',') === 'x,y,z', tags.join(','))

        // Reject an unknown folder id rather than silently orphaning sessions.
        let badMove = false
        try {
          store.moveSession(tree.sessions[0].id, 'does-not-exist')
        } catch {
          badMove = true
        }
        push('move to missing folder rejected', badMove)
      } catch (err) {
        push('session tree suite', false, err && err.message)
      }

      return out
    })()
  )

  // ---- 3. settings persistence ------------------------------------------

  report(
    await (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const store = stores.settings

      try {
        const defaults = store.load()
        push('defaults: copy on select', defaults.clipboard.copyOnSelect === true)
        push('defaults: right-click paste', defaults.clipboard.pasteOnRightClick === true)
        push('defaults: builtin keybindings', defaults.keybindings.length >= 8,
          defaults.keybindings.map((b) => `${b.id}=${b.keys}`).join(' '))

        store.save({
          ...defaults,
          clipboard: { ...defaults.clipboard, copyOnSelect: false },
          terminal: { ...defaults.terminal, fontSize: 18 },
          keybindings: defaults.keybindings.map((b) =>
            b.id === 'newConnection' ? { ...b, keys: 'Ctrl+Alt+N' } : b
          )
        })

        // A fresh store instance must read the saved values back.
        const Store = mod.SettingsStore
        const reopened = new Store(stores.configDir).load()
        push('settings persisted: copyOnSelect', reopened.clipboard.copyOnSelect === false)
        push('settings persisted: fontSize', reopened.terminal.fontSize === 18)
        push('rebound shortcut persisted',
          reopened.keybindings.find((b) => b.id === 'newConnection').keys === 'Ctrl+Alt+N')

        // A binding the user deliberately cleared must stay cleared rather than
        // being restored from the defaults on the next load.
        const stripped = store.load()
        store.save({
          ...stripped,
          keybindings: stripped.keybindings.map((b) => (b.id === 'copy' ? { ...b, keys: '' } : b))
        })
        const afterClear = new Store(stores.configDir).load()
        push('a cleared binding stays cleared',
          afterClear.keybindings.find((b) => b.id === 'copy').keys === '',
          JSON.stringify(afterClear.keybindings.find((b) => b.id === 'copy').keys))

        // Reordering must survive a round-trip: the settings list is drag-sortable.
        const reversed = [...afterClear.keybindings].reverse()
        store.save({ ...afterClear, keybindings: reversed })
        const reordered = new Store(stores.configDir).load()
        push('keybinding order survives a round-trip',
          reordered.keybindings.map((b) => b.id).join(',') === reversed.map((b) => b.id).join(','),
          reordered.keybindings.map((b) => b.id).join(','))

        // A built-in that predates the file must still appear (app updates).
        const seen = new Set(reordered.keybindings.map((b) => b.id))
        const missing = defaults.keybindings.filter((b) => !seen.has(b.id))
        push('no builtin bindings lost', missing.length === 0, missing.map((b) => b.id).join(','))
      } catch (err) {
        push('settings suite', false, err && err.message)
      }

      return out
    })()
  )

  // ---- 4. host keys ------------------------------------------------------

  report(
    await (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const fs = require('node:fs')

      try {
        const tmp = path.join(app.getPath('temp'), `td-kh-${Date.now()}`)
        const khPath = path.join(tmp, 'known_hosts')
        const kh = new mod.KnownHosts({ paths: [khPath] })

        const keyBlob = Buffer.from('AAAAB3NzaC1yc2EAAAADAQABAAABgQC7test-key-material', 'base64')
        const presented = `ssh-ed25519 ${keyBlob.toString('base64')}`

        push('unknown host is unknown', kh.verify('example.com', 22, presented).status === 'unknown')

        kh.trust('example.com', 22, presented)
        push('trusted after trust()', kh.verify('example.com', 22, presented).status === 'trusted')

        const fp = mod.fingerprint(keyBlob)
        push('fingerprint is SHA256 form', /^SHA256:[A-Za-z0-9+/]+$/.test(fp), fp)

        // Hashed entries must still match, and must not leak the hostname.
        const written = fs.readFileSync(khPath, 'utf8').trim()
        push('entry written hashed', written.startsWith('|1|'), written.slice(0, 40))
        push('hostname not in known_hosts', !written.includes('example.com'))

        // A different key for the same host is a mismatch, never a silent pass.
        const otherBlob = Buffer.from('AAAAB3NzaC1yc2EAAAADAQABAAABgQC7OTHER-key', 'base64')
        const other = `ssh-ed25519 ${otherBlob.toString('base64')}`
        const verdict = kh.verify('example.com', 22, other)
        push('changed key reports mismatch', verdict.status === 'mismatch', verdict.status)
        push('mismatch carries old fingerprint',
          typeof verdict.prompt.previousFingerprint === 'string' &&
            verdict.prompt.previousFingerprint.startsWith('SHA256:'))

        // Ports are distinct entries.
        push('other port is still unknown',
          kh.verify('example.com', 2222, presented).status === 'unknown')

        // Re-trusting replaces the stale line rather than appending a second one.
        kh.trust('example.com', 22, other)
        const lines = fs.readFileSync(khPath, 'utf8').trim().split('\n')
        push('re-trust replaces the old key', lines.length === 1, `${lines.length} line(s)`)
        push('new key now trusted', kh.verify('example.com', 22, other).status === 'trusted')

        const removed = kh.forget('example.com', 22)
        push('forget removes the entry',
          removed === 1 && kh.verify('example.com', 22, other).status === 'unknown')

        fs.rmSync(tmp, { recursive: true, force: true })
      } catch (err) {
        push('host key suite', false, err && err.message)
      }

      return out
    })()
  )

  // ---- 5. live SSH with real known_hosts --------------------------------

  report(
    await (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const fs = require('node:fs')

      try {
        // The user's own known_hosts should already hold the test host, having
        // been used by the earlier smoke runs.
        const hosts = stores.knownHosts.find(SSH_HOST, 22)
        push('test host present in known_hosts', hosts.length > 0,
          hosts.map((h) => h.keyType).join(','))

        // Compare the fingerprint reported for the live key against the one
        // derived from the stored entry: they must be identical strings.
        const liveVerdict = await new Promise((resolve) => {
          const backend = new mod.SshShellBackend(
            { host: SSH_HOST, port: 22, username: SSH_USER, auth: { privateKeyPath: SSH_KEY }, hostKeyPolicy: 'ask' },
            80, 24,
            {
              knownHosts: new mod.KnownHosts({ paths: [path.join(app.getPath('temp'), 'td-nope-' + Date.now())] }),
              resolveSecret: () => null
            }
          )
          backend.on('error', (err) => resolve(err))
          backend.on('data', () => resolve(new Error('unexpectedly connected')))
          setTimeout(() => resolve(new Error('timeout')), 20000)
        })
        const liveFp = liveVerdict.prompt && liveVerdict.prompt.fingerprint
        const storedFp = mod.fingerprint(hosts[0] ? `${hosts[0].keyType} ${hosts[0].keyData}` : '')
        push('live fingerprint matches stored entry',
          !!liveFp && liveFp === storedFp,
          `live=${liveFp} stored=${storedFp}`)

        const session = await new Promise((resolve, reject) => {
          const backend = new mod.SshShellBackend(
            { host: SSH_HOST, port: 22, username: SSH_USER, auth: { privateKeyPath: SSH_KEY } },
            80,
            24,
            { knownHosts: stores.knownHosts, resolveSecret: () => null }
          )
          let buffer = ''
          const timer = setTimeout(() => reject(new Error('ssh timeout')), 25000)
          backend.on('data', (chunk) => (buffer += chunk))
          backend.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
          })
          // Ready once the prompt arrives.
          const check = setInterval(() => {
            if (/root@|#|\\$/.test(buffer)) {
              clearInterval(check)
              clearTimeout(timer)
              resolve({ backend, buffer })
            }
          }, 300)
        })

        push('trusted host connects without prompting', true,
          JSON.stringify(session.buffer.trim().slice(-40)))
        session.backend.close()
      } catch (err) {
        push('trusted host connects without prompting', false, err && err.message)
      }

      // An unknown host under the `ask` policy must refuse and surface a prompt.
      try {
        const unknown = new mod.KnownHosts({
          paths: [path.join(app.getPath('temp'), `td-kh-empty-${Date.now()}`, 'known_hosts')]
        })
        const err = await new Promise((resolve) => {
          const backend = new mod.SshShellBackend(
            { host: SSH_HOST, port: 22, username: SSH_USER, auth: { privateKeyPath: SSH_KEY }, hostKeyPolicy: 'ask' },
            80,
            24,
            { knownHosts: unknown, resolveSecret: () => null }
          )
          backend.on('error', resolve)
          setTimeout(() => resolve(new Error('no error emitted')), 20000)
        })

        push('unknown host under ask policy is refused',
          err.code === 'HOST_KEY_REQUIRED', `${err.code}: ${err.message}`)
        push('prompt carries a fingerprint',
          !!(err.prompt && /^SHA256:/.test(err.prompt.fingerprint)),
          err.prompt && err.prompt.fingerprint)
      } catch (err) {
        push('unknown host under ask policy is refused', false, err && err.message)
      }

      return out
    })()
  )

  // ---- 6. renderer UI ----------------------------------------------------

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

  const indexFile = path.join(ROOT, 'out', 'renderer', 'index.html')
  await win.loadFile(indexFile)
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)

  // Clipboard writes from the renderer only reach the OS clipboard when the
  // window is actually focused, so show and focus it before exercising them.
  win.show()
  win.focus()
  await sleep(800)

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      push('bridge exposes new APIs',
        typeof api.saveSession === 'function' && typeof api.credentialStatus === 'function' &&
        typeof api.trustHostKey === 'function' && typeof api.saveSettings === 'function',
        Object.keys(api).length + ' methods')

      const info = await api.appInfo()
      push('appInfo reports configDir', typeof info.configDir === 'string', info.configDir)

      // --- settings dialog: clipboard toggles round-trip ------------------
      const gear = document.querySelector('[data-testid="open-settings"]')
      push('settings button present', !!gear)
      gear.click()
      await new Promise((r) => setTimeout(r, 500))

      const tabs = [...document.querySelectorAll('.td-settings-tab')].map((t) => t.textContent)
      push('settings tabs rendered', tabs.length === 6, tabs.join(' | '))
      push('appearance tab is first', /Appearance/i.test(tabs[0] || ''), tabs[0])

      // The theme picker lists every built-in theme and marks the active one.
      const cards = [...document.querySelectorAll('[data-testid="theme-grid"] .td-theme-card')]
      push('theme picker lists themes', cards.length >= 8, cards.length + ' themes')
      const activeCards = cards.filter((c) => c.classList.contains('is-active'))
      push('exactly one theme is active', activeCards.length === 1,
        activeCards.map((c) => c.getAttribute('data-theme-id')).join(','))

      // Switching theme and saving must reach settings and the document.
      const target = cards.find((c) => c.getAttribute('data-theme-id') === 'dracula')
      push('dracula theme offered', !!target)
      if (target) {
        target.click()
        await new Promise((r) => setTimeout(r, 250))
        const saveBtn = [...document.querySelectorAll('.td-drawer-actions button')]
          .find((b) => /Save settings/i.test(b.textContent || ''))
        push('save enabled after picking a theme', !!saveBtn && !saveBtn.disabled)
        saveBtn.click()
        await new Promise((r) => setTimeout(r, 800))

        const after = await api.loadSettings()
        push('theme persisted', after.theme === 'dracula', after.theme)
        push('theme applied to the document',
          document.documentElement.dataset.themeId === 'dracula',
          'data-theme-id=' + document.documentElement.dataset.themeId)
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--td-bg').trim()
        push('theme variables written', bg.length > 0, '--td-bg=' + bg)
      }

      const clipTab = [...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Clipboard/i.test(t.textContent))
      clipTab.click()
      await new Promise((r) => setTimeout(r, 350))

      const copySel = document.querySelector('[aria-label="copy-on-select"]')
      const rightPaste = document.querySelector('[aria-label="paste-on-right-click"]')
      push('clipboard toggles present', !!copySel && !!rightPaste)
      // Defaults are on; verify the saved state matches the checkbox.
      const settingsNow = await api.loadSettings()
      push('checkbox reflects saved setting',
        copySel.checked === settingsNow.clipboard.copyOnSelect,
        'checkbox=' + copySel.checked + ' stored=' + settingsNow.clipboard.copyOnSelect)

      // --- shortcuts tab --------------------------------------------------
      const shortcutsTab = [...document.querySelectorAll('.td-settings-tab')]
        .find((t) => /Shortcuts/i.test(t.textContent))
      shortcutsTab.click()
      await new Promise((r) => setTimeout(r, 350))
      const keyBtns = document.querySelectorAll('.td-key-btn')
      push('shortcut rows rendered', keyBtns.length >= 8, keyBtns.length + ' rows')

      const closeBtn = [...document.querySelectorAll('.td-drawer button')]
        .find((b) => /^Close$/.test((b.textContent || '').trim()))
      closeBtn.click()
      await new Promise((r) => setTimeout(r, 300))
      push('settings closed', !document.querySelector('.td-settings'))

      return out
    })()`)
  )

  // Session editor + tree, driven with explicit selectors.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      const newBtn = document.querySelector('[data-testid="tree-new-session"]')
      push('new session button present', !!newBtn)
      newBtn.click()
      await new Promise((r) => setTimeout(r, 450))

      const f = (label) => document.querySelector('[data-testid="session-form"] [aria-label="' + label + '"]')
      push('editor fields present',
        !!(f('session-name') && f('session-host') && f('session-username') && f('session-tag-input')),
        [...document.querySelectorAll('[data-testid="session-form"] [aria-label]')].map((i) => i.getAttribute('aria-label')).join(','))

      const setValue = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      setValue(f('session-name'), 'probe-session')
      setValue(f('session-host'), '127.0.0.1')
      setValue(f('session-port'), '2200')
      setValue(f('session-username'), 'probe')
      await new Promise((r) => setTimeout(r, 250))

      // Tags are committed with Enter.
      const tagInput = f('session-tag-input')
      const press = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      for (const tag of ['probe', 'local']) {
        setValue(tagInput, tag)
        press(tagInput, 'Enter')
        await new Promise((r) => setTimeout(r, 200))
      }
      const shownTags = [...document.querySelectorAll('[data-testid="session-form"] .td-tag')].map((t) => t.textContent.replace('✕',''))
      push('tags added in editor', shownTags.includes('probe') && shownTags.includes('local'), shownTags.join(','))

      const save = document.querySelector('[data-testid="session-save"]')
      push('save enabled', !!save && !save.disabled)
      save.click()
      await new Promise((r) => setTimeout(r, 700))
      push('editor closed after save', !document.querySelector('[data-testid="session-save"]'))

      const tree = await api.loadSessionTree()
      const saved = tree.sessions.find((s) => s.name === 'probe-session')
      push('session persisted via UI', !!saved,
        saved ? saved.host + ':' + saved.port + ' tags=' + saved.tags.join(',') : 'missing')

      const node = [...document.querySelectorAll('.td-node-label')]
        .find((n) => n.textContent === 'probe-session')
      push('session node rendered in tree', !!node)
      const tagChips = [...document.querySelectorAll('.td-node-tags .td-tag')].map((t) => t.textContent)
      push('tag chips rendered on node',
        tagChips.includes('probe') && tagChips.includes('local'), tagChips.join(','))

      return out
    })()`)
  )

  // Folder nesting through the tree UI.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // The toolbar holds "new session" and "new folder"; target the latter by
      // its title rather than by position.
      const folderBtn = [...document.querySelectorAll('.td-tree-toolbar .td-mini')]
        .find((b) => /new folder/i.test(b.getAttribute('title') || ''))
      push('new folder button present', !!folderBtn)
      folderBtn.click()
      await new Promise((r) => setTimeout(r, 500))

      let tree = await api.loadSessionTree()
      const root = tree.folders.find((f) => f.name === 'New folder')
      push('root folder created via UI', !!root)
      if (!root) return out

      // Target nodes by their stable data attributes, not by text: nested
      // folders all start out named "New folder".
      const nodeById = (id) => document.querySelector('.td-node[data-node-id="' + id + '"]')
      const subfolderBtn = (id) =>
        [...nodeById(id).querySelectorAll('.td-mini')]
          .find((b) => b.getAttribute('title') === 'New subfolder')

      push('subfolder button present', !!subfolderBtn(root.id))
      subfolderBtn(root.id).click()
      await new Promise((r) => setTimeout(r, 500))

      tree = await api.loadSessionTree()
      const child = tree.folders.find((f) => f.parentId === root.id)
      push('subfolder has parent', !!child, child ? child.name : 'none')

      // Three levels deep.
      push('grandchild button present', !!child && !!subfolderBtn(child.id))
      subfolderBtn(child.id).click()
      await new Promise((r) => setTimeout(r, 500))

      tree = await api.loadSessionTree()
      const grandchild = tree.folders.find((f) => f.parentId === child.id)
      push('three levels of nesting', !!grandchild,
        tree.folders.length + ' folders, depth ' + (grandchild ? 3 : 2))
      push('grandchild is the deepest node in the DOM',
        !!grandchild && !!nodeById(grandchild.id))

      // Tag filter narrows the session list.
      const tagChip = [...document.querySelectorAll('.td-tag-filterable')]
        .find((t) => t.textContent === 'probe')
      push('tag filter chip present', !!tagChip)
      if (tagChip) {
        tagChip.click()
        await new Promise((r) => setTimeout(r, 300))
        push('tag filter applied', tagChip.classList.contains('is-on'))
        tagChip.click()
        await new Promise((r) => setTimeout(r, 300))
      }

      return out
    })()`)
  )

  // ---- 7. clipboard behaviour in a live terminal -------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      // --- settings actually drive behaviour ------------------------------
      const settings = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...settings,
        clipboard: { ...settings.clipboard, copyOnSelect: true, pasteOnRightClick: true }
      })

      const localBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Local shell/i.test(b.textContent || ''))
      localBtn.click()
      await new Promise((r) => setTimeout(r, 3500))

      const host = document.querySelector('.td-terminal-host')
      push('terminal container present', !!host)
      if (!host) return out

      const debug = window.__tdTerminals
      const ids = debug ? Object.keys(debug) : []
      push('terminal test hook available', ids.length > 0, ids.length + ' terminal(s)')
      if (ids.length === 0) return out

      const term = debug[ids[0]].term

      // --- copy on select -------------------------------------------------
      // Drive a real drag across the terminal rather than assuming which buffer
      // rows hold text: the shell output length varies between runs.
      const screen = document.querySelector('.xterm-screen')
      const rect = screen.getBoundingClientRect()
      const mouse = (type, x, y) => screen.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, detail: 1
      }))

      const clipBefore = await window.termdeck.readClipboard()
      mouse('mousedown', rect.left + 4, rect.top + 4)
      mouse('mousemove', rect.left + 200, rect.top + 4)
      mouse('mousemove', rect.left + 200, rect.top + 40)
      mouse('mouseup', rect.left + 200, rect.top + 40)

      const selected = term.getSelection()
      push('drag produced a selection', selected.trim().length > 0, JSON.stringify(selected.trim().slice(0, 30)))

      // The copy crosses IPC, so poll rather than assume a fixed delay.
      let clip = ''
      for (let i = 0; i < 30; i++) {
        clip = await window.termdeck.readClipboard()
        if (clip.trim().length > 0 && clip.trim() !== clipBefore.trim()) break
        await new Promise((r) => setTimeout(r, 120))
      }
      push('selection reached the OS clipboard',
        clip.trim().length > 0 && clip === selected,
        JSON.stringify(clip.slice(0, 30)))

      // --- paste on right click -------------------------------------------
      // A single-line payload, because multi-line text deliberately raises the
      // confirmation guard (covered separately below).
      const marker = 'TD_RIGHT_CLICK_' + Date.now()
      await window.termdeck.copyToClipboard('echo ' + marker)

      const beforeText = (document.querySelector('.xterm-rows') || {}).textContent || ''
      push('marker not yet on screen', !beforeText.includes(marker))

      // Dispatch a genuine mousedown with button=2 on the terminal container;
      // this is the exact event the hook listens for.
      host.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, buttons: 2
      }))
      // The pasted text must be handed to the terminal, which echoes it.
      let afterText = ''
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200))
        afterText = (document.querySelector('.xterm-rows') || {}).textContent || ''
        if (afterText.includes(marker)) break
      }
      push('right-click pasted into the terminal', afterText.includes(marker),
        JSON.stringify(afterText.trim().slice(-60)))

      return out
    })()`)
  )

  // The multi-line guard must intercept a newline-bearing paste.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const settings = await window.termdeck.loadSettings()
      push('multi-line confirmation is on by default',
        settings.clipboard.confirmMultilinePaste === true)

      const host = document.querySelector('.td-terminal-host')
      const marker = 'TD_MULTILINE_' + Date.now()
      // '\\\\n' here reaches the page as a literal backslash-n so the inner
      // template builds a two-line string with a real newline.
      await window.termdeck.copyToClipboard('echo ' + marker + '\\necho two')

      host.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, buttons: 2
      }))
      await new Promise((r) => setTimeout(r, 1200))

      const guard = document.querySelector('.td-paste-guard')
      push('paste guard appeared for multi-line text', !!guard,
        guard ? (guard.querySelector('.td-paste-guard-title') || {}).textContent : 'no guard')

      const rows = (document.querySelector('.xterm-rows') || {}).textContent || ''
      push('multi-line paste withheld until confirmed', !rows.includes(marker))

      if (guard) {
        const paste = [...guard.querySelectorAll('button')]
          .find((b) => /^Paste$/.test((b.textContent || '').trim()))
        push('guard offers a Paste action', !!paste)
        paste.click()
        let pasted = ''
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 200))
          pasted = (document.querySelector('.xterm-rows') || {}).textContent || ''
          if (pasted.includes(marker)) break
        }
        push('confirmed paste reaches the terminal', pasted.includes(marker),
          JSON.stringify(pasted.trim().slice(-50)))
      }

      return out
    })()`)
  )

  // Turning the setting off must actually disable the behaviour.
  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })

      const settings = await window.termdeck.loadSettings()
      const saved = await window.termdeck.saveSettings({
        ...settings,
        clipboard: { ...settings.clipboard, pasteOnRightClick: false }
      })
      push('disabled setting persisted', saved.clipboard.pasteOnRightClick === false,
        'pasteOnRightClick=' + saved.clipboard.pasteOnRightClick)
      // Let React deliver the new settings to the already-mounted panel.
      await new Promise((r) => setTimeout(r, 700))

      // Panels read settings live, so the change applies without reopening.
      const host = document.querySelector('.td-terminal-host')
      // A fresh marker: the buffer still contains text pasted by earlier checks,
      // so only this run's marker tells us whether the handler fired again.
      const marker = 'TD_DISABLED_' + Date.now()
      // Single line, so nothing else can intercept the paste.
      await window.termdeck.copyToClipboard('echo ' + marker)

      // Reset the diagnostic so we read the value this event produces.
      window.__tdClipboardSeen = null
      host.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 2, buttons: 2
      }))
      await new Promise((r) => setTimeout(r, 2200))

      const after = (document.querySelector('.xterm-rows') || {}).textContent || ''
      const seen = window.__tdClipboardSeen
      push('handler observed the disabled setting', seen && seen.pasteOnRightClick === false,
        JSON.stringify(seen))
      push('right-click ignored when disabled', !after.includes(marker),
        'marker ' + marker + ' absent from the buffer')

      // --- live settings application --------------------------------------
      // Font size is the same class of bug: dockview panels are built from a
      // factory, so a settings change must reach an already-open pane.
      const ids = Object.keys(window.__tdTerminals || {})
      const term = window.__tdTerminals[ids[0]].term
      const beforeFont = term.options.fontSize

      const current = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...current,
        terminal: { ...current.terminal, fontSize: beforeFont + 4 }
      })
      await new Promise((r) => setTimeout(r, 800))

      push('font size applied to an open pane', term.options.fontSize === beforeFont + 4,
        beforeFont + ' -> ' + term.options.fontSize)

      // Put the appearance back.
      await window.termdeck.saveSettings(current)
      await new Promise((r) => setTimeout(r, 400))

      // Restore the default for subsequent runs.
      await window.termdeck.saveSettings(settings)
      return out
    })()`)
  )

  if (consoleErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e)
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('features probe crashed:', err)
    app.exit(1)
  })
)
