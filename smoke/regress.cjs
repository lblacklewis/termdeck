/**
 * Reproduction and verification for two reported defects:
 *
 *   A. "Replace key and connect" in the host-key dialog does nothing.
 *   B. Dragging a session onto a folder in the sidebar does not move it.
 *
 * Both are driven through the real UI. Host keys are redirected to a temp file
 * via TERMDECK_KNOWN_HOSTS so the developer's ~/.ssh/known_hosts is untouched.
 *
 *   npm run build && node smoke/regress.cjs        (sets up the temp file itself)
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const SSH_HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const SSH_USER = process.env.TD_SSH_USER || 'root'
const SSH_KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')
const CHILD = process.env.TD_REGRESS_CHILD === '1'

/** A syntactically valid but wrong ed25519 key, to force a mismatch. */
function decoyEd25519() {
  const keyMat = crypto.randomBytes(32)
  const type = Buffer.from('ssh-ed25519')
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, keyMat.length]), keyMat
  ])
  return { type: 'ssh-ed25519', data: blob.toString('base64') }
}

// ---------------------------------------------------------------------------
// Parent: plant a mismatching entry, then re-run this script inside Electron.
// ---------------------------------------------------------------------------
if (!CHILD) {
  const tmpDir = path.join(os.tmpdir(), `td-regress-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const knownHosts = path.join(tmpDir, 'known_hosts')

  const decoy = decoyEd25519()
  fs.writeFileSync(knownHosts, `${SSH_HOST} ${decoy.type} ${decoy.data}\n`, { mode: 0o600 })

  console.log(`planted a decoy key for ${SSH_HOST} in ${knownHosts}`)
  console.log(`  expected live fingerprint differs -> dialog should warn "changed"\n`)

  const electron = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'electron')

  const result = spawnSync(
    electron,
    ['smoke/regress.cjs', `--user-data-dir=${path.join(tmpDir, 'profile')}`],
    {
      stdio: 'inherit',
      env: { ...process.env, TD_REGRESS_CHILD: '1', TERMDECK_KNOWN_HOSTS: knownHosts },
      shell: process.platform === 'win32'
    }
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(result.status === null ? 1 : result.status)
}

// ---------------------------------------------------------------------------
// Child: run inside Electron.
// ---------------------------------------------------------------------------
const { app, BrowserWindow } = require('electron')

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

  const knownHostsPath = process.env.TERMDECK_KNOWN_HOSTS
  console.log(`child using known_hosts: ${knownHostsPath}\n`)

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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

  // ---- A. host-key mismatch -> replace -> connect ------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // Force the strict-ish policy the reported scenario used.
      const s = await api.loadSettings()
      await api.saveSettings({ ...s, hostKeys: { policy: 'ask' } })

      const connectBtn = [...document.querySelectorAll('.td-sidebar .td-btn')]
        .find((b) => /Connect/i.test(b.textContent || ''))
      connectBtn.click()
      // Quick connect renders in a drawer, which mounts a frame later.
      let field = null
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 120))
        field = document.querySelector('[data-testid="drawer"] [aria-label="ssh-host"]')
        if (field) break
      }
      push('quick connect drawer opened', !!field)

      const f = (label) => document.querySelector('[data-testid="drawer"] [aria-label="' + label + '"]')
      const setValue = (el, v) => {
        if (!el) return
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setValue(f('ssh-host'), ${JSON.stringify(SSH_HOST)})
      setValue(f('ssh-port'), '22')
      setValue(f('ssh-username'), ${JSON.stringify(SSH_USER)})

      const keyTab = [...document.querySelectorAll('.td-segmented button')]
        .find((b) => /Private key/i.test(b.textContent || ''))
      keyTab.click()
      await new Promise((r) => setTimeout(r, 400))
      setValue(f('private-key-path'), ${JSON.stringify(SSH_KEY)})
      await new Promise((r) => setTimeout(r, 400))

      document.querySelector('[data-testid="connect-submit"]').click()

      // The mismatch dialog must appear.
      let dialog = null
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250))
        dialog = document.querySelector('[data-testid="hostkey-dialog"]')
        if (dialog) break
      }
      push('changed-key dialog appeared', !!dialog,
        dialog ? (dialog.querySelector('h2') || {}).textContent : 'no dialog')

      if (!dialog) return out

      push('dialog warns about a changed key',
        /changed/i.test((dialog.querySelector('h2') || {}).textContent || ''))
      const fp = (dialog.querySelector('[data-testid="hostkey-fingerprint"]') || {}).textContent
      push('dialog shows a fingerprint', /^SHA256:/.test((fp || '').trim()), fp)

      // The exact click the user reported as doing nothing.
      const trust = dialog.querySelector('[data-testid="hostkey-trust"]')
      push('replace button present', !!trust, trust ? trust.textContent.trim() : 'missing')
      trust.click()
      await new Promise((r) => setTimeout(r, 2000))

      push('dialog dismissed after clicking replace',
        !document.querySelector('[data-testid="hostkey-dialog"]'))

      // And the retry must actually connect.
      let tabs = []
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 300))
        tabs = [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())
        if (tabs.some((t) => t.includes(${JSON.stringify(SSH_HOST)}))) break
      }
      push('session opened after replacing the key',
        tabs.some((t) => t.includes(${JSON.stringify(SSH_HOST)})), tabs.join(' | '))

      const err = document.querySelector('[data-testid="drawer"] .td-form-error')
      push('no error left behind', !err, err ? err.textContent.trim() : 'none')

      return out
    })()`)
  )

  // ---- B. drag a session onto a folder -----------------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      // Build a folder and a root-level session to move into it.
      let tree = await api.loadSessionTree()
      push('tree loads', !!tree, 'folders=' + tree.folders.length + ' sessions=' + tree.sessions.length)

      let saveError = null
      try {
        tree = await api.saveFolder({ name: 'drag-target' })
      } catch (err) {
        saveError = 'saveFolder: ' + (err && err.message)
      }
      const folder = tree.folders.find((f) => f.name === 'drag-target')

      try {
        tree = await api.saveSession({ name: 'drag-source', host: '10.9.9.9', username: 'u' })
      } catch (err) {
        saveError = (saveError ? saveError + ' | ' : '') + 'saveSession: ' + (err && err.message)
      }
      const session = tree.sessions.find((s) => s.name === 'drag-source')

      push('fixture created', !!folder && !!session,
        'folder=' + !!folder + ' session=' + !!session +
        ' folders=' + tree.folders.length + ' sessions=' + tree.sessions.length +
        (saveError ? ' error=' + saveError : ''))

      const reloaded = await api.loadSessionTree()
      push('fixture persisted', reloaded.folders.length === tree.folders.length,
        'reloaded folders=' + reloaded.folders.length + ' sessions=' + reloaded.sessions.length)

      await new Promise((r) => setTimeout(r, 600))

      const src = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      const dst = document.querySelector('.td-node[data-node-id="' + folder.id + '"]')
      if (!src || !dst) {
        const nodes = [...document.querySelectorAll('.td-node')].map(
          (n) => n.getAttribute('data-node-kind') + ':' + (n.querySelector('.td-node-label') || {}).textContent
        )
        const sidebar = document.querySelector('.td-sidebar')
        push('source and target rendered in the tree', false,
          'src=' + !!src + ' dst=' + !!dst + ' nodes=[' + nodes.join(', ') + ']' +
          ' treeView=' + !!document.querySelector('.td-tree') +
          ' treeRoot=' + !!document.querySelector('.td-tree-root') +
          ' treeText=' + JSON.stringify(((document.querySelector('.td-tree') || {}).textContent || '').slice(0, 90)) +
          ' sidebarText=' + JSON.stringify(((sidebar || {}).textContent || '').slice(0, 120)))
        return out
      }
      push('source and target rendered in the tree', true)

      // A genuine HTML5 drag: dragstart on the row, then the events a browser
      // fires over the drop target. Each drag gets its own DataTransfer, because
      // reusing one leaks payloads between drags.
      const fire = (el, type, dt) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      )

      const dtDrag = new DataTransfer()
      fire(src, 'dragstart', dtDrag)
      fire(dst, 'dragenter', dtDrag)
      const overAllowed = fire(dst, 'dragover', dtDrag)
      push('target accepts dragover (preventDefault called)',
        overAllowed === false, 'dispatchEvent returned ' + overAllowed)

      fire(dst, 'drop', dtDrag)
      fire(src, 'dragend', dtDrag)

      await new Promise((r) => setTimeout(r, 900))

      tree = await api.loadSessionTree()
      const moved = tree.sessions.find((s) => s.name === 'drag-source')
      push('session moved into the folder', moved && moved.parentId === folder.id,
        'parentId=' + (moved && moved.parentId) + ' expected=' + folder.id)

      // The tree must reflect the move without a reload.
      const row = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      push('tree re-rendered with the session nested',
        !!row && !!row.closest('.td-node-children'), row ? 'nested' : 'row missing')

      return out
    })()`)
  )

  // ---- C. drag onto the tree root (move back out) ------------------------

  report(
    await win.webContents.executeJavaScript(`(async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok, detail: d || '' })
      const api = window.termdeck

      const tree = await api.loadSessionTree()
      const session = tree.sessions.find((s) => s.name === 'drag-source')
      const folder = tree.folders.find((f) => f.name === 'drag-target')
      push('session currently nested', session.parentId === folder.id)

      const src = document.querySelector('.td-node[data-node-id="' + session.id + '"]')
      const root = document.querySelector('.td-tree-root')
      if (!src || !root) { push('drag source and root present', false); return out }

      // The dataTransfer must carry what we think we are dragging.
      push('drag source is the session row',
        src.getAttribute('data-node-kind') === 'session' &&
          src.getAttribute('data-node-id') === session.id,
        'kind=' + src.getAttribute('data-node-kind') + ' id=' + src.getAttribute('data-node-id') +
          ' expected=' + session.id)

      const dtBack = new DataTransfer()
      const fire = (el, type) => el.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dtBack })
      )
      // Drop first, then dragend: a real browser fires the drop before the drag
      // ends, and the handlers rely on that ordering.
      fire(src, 'dragstart')
      push('datatransfer carries the session',
        dtBack.getData('text/plain').startsWith('session:'),
        JSON.stringify(dtBack.getData('text/plain')))
      fire(root, 'dragenter')
      fire(root, 'dragover')
      fire(root, 'drop')
      fire(src, 'dragend')
      await new Promise((r) => setTimeout(r, 900))

      const after = await api.loadSessionTree()
      const moved = after.sessions.find((s) => s.name === 'drag-source')
      push('dropping on the tree root un-nests the session', moved.parentId === null,
        'parentId=' + moved.parentId +
        ' dropLog=' + JSON.stringify(window.__tdDropLog || []))

      return out
    })()`)
  )

  if (consoleErrors.length) {
    console.log('\nconsole errors (level >= warning):')
    for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e)
  }

  // Show what the trust step actually persisted.
  try {
    const written = require('node:fs').readFileSync(knownHostsPath, 'utf8')
    console.log('\nknown_hosts after trust:')
    for (const line of written.trim().split('\n')) {
      const parts = line.trim().split(/\s+/)
      const prefix = parts[0] && parts[0].startsWith('|1|') ? '<hashed>' : parts[0]
      console.log(`  ${prefix} ${parts[1] || '?'} keyLen=${(parts[2] || '').length}`)
      console.log(`    ${(parts[2] || '').slice(0, 60)}`)
    }
  } catch (err) {
    console.log('\ncould not read known_hosts:', err.message)
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('regress crashed:', err)
    app.exit(1)
  })
)
