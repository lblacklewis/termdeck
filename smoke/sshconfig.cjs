/**
 * Importing hosts from the machine's OpenSSH config.
 *
 *   npm run build && electron smoke/sshconfig.cjs --user-data-dir=...
 *
 * Two parts. First the parser on its own: bundled out of src/shared/sshConfig.ts
 * with esbuild, fed config text, and asserted on what it says a config means —
 * the first-obtained-value rule, wildcards, negation, Include, the Key=Value
 * spelling. Then the whole feature through the real app with TERMDECK_SSH_CONFIG
 * pointing at a fixture, which is what keeps the developer's own ~/.ssh/config
 * out of the test: peek, dialog, import, duplicates, folders, and the error when
 * there is no config file at all.
 */
const { buildSync } = require('esbuild')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)
const NL = String.fromCharCode(10)

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`)
    all.push(c)
  }
}

async function waitFor(makePromise, timeoutMs) {
  const limit = timeoutMs || 8000
  const started = Date.now()
  for (;;) {
    const value = await makePromise()
    if (value) return value
    if (Date.now() - started > limit) return value
    await sleep(200)
  }
}

// ---- part 1: the parser ---------------------------------------------------

function partA() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-sshconfig-'))
  const outfile = path.join(dir, 'sshconfig.cjs')
  const entry = path.join(dir, 'entry.ts')
  const src = path.join(ROOT, 'src', 'shared', 'sshConfig.ts').replace(/\\/g, '/')
  fs.writeFileSync(entry, "export * from '" + src + "'", 'utf8')
  try {
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent'
    })
  } catch (err) {
    // The parser is the feature; an implementation without it fails everything,
    // and saying so beats dying mid-run where a piped console shows nothing.
    report([
      {
        name: 'the parser module could be bundled out of src/shared',
        ok: false,
        detail: String(err && err.message ? err.message : err).slice(0, 200)
      }
    ])
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }
  const { parseSshConfig } = require(outfile)

  const home = '/home/probe'
  const fleet = [
    '# fleet config',
    'Host web1',
    '  HostName 10.17.20.211',
    '  Port 2200',
    '',
    'Host bastion',
    '  user deploy',
    '  IdentityFile ~/.ssh/id_ed25519_probe',
    '  ProxyJump web1',
    '',
    'Host db1 db2',
    '  User dbops',
    '',
    'Host *',
    '  User fleet',
    '  ServerAliveInterval 60',
    '',
    'Host web-*',
    '  Compression yes'
  ].join(NL)
  const result = parseSshConfig(fleet, { home })
  const byAlias = {}
  for (const host of result.hosts) byAlias[host.alias] = host

  report([
    {
      name: 'a concrete host keeps its HostName and Port',
      ok:
        !!byAlias['web1'] &&
        byAlias['web1'].host === '10.17.20.211' &&
        byAlias['web1'].port === 2200 &&
        byAlias['web1'].line === 2,
      detail: JSON.stringify(byAlias['web1'])
    },
    {
      name: 'the Host * trailer fills a User in but is not a host itself',
      ok:
        byAlias['web1'] &&
        byAlias['web1'].username === 'fleet' &&
        result.hosts.every((h) => h.alias !== '*') &&
        result.patternOnlyBlocks === 2,
      detail: 'patternOnlyBlocks=' + result.patternOnlyBlocks
    },
    {
      name: 'an explicit User beats the trailer, first value wins',
      ok: byAlias['bastion'] && byAlias['bastion'].username === 'deploy',
      detail: JSON.stringify(byAlias['bastion'])
    },
    {
      name: 'IdentityFile expands to the home that was handed in',
      ok:
        byAlias['bastion'] &&
        byAlias['bastion'].privateKeyPath === home + '/.ssh/id_ed25519_probe',
      detail: String(byAlias['bastion'] && byAlias['bastion'].privateKeyPath)
    },
    {
      name: 'a ProxyJump is kept for the notes, not dropped',
      ok: byAlias['bastion'] && byAlias['bastion'].proxy === 'web1',
      detail: String(byAlias['bastion'] && byAlias['bastion'].proxy)
    },
    {
      name: 'one Host line with two names offers two machines',
      ok:
        !!byAlias['db1'] &&
        !!byAlias['db2'] &&
        byAlias['db1'].username === 'dbops' &&
        byAlias['db1'].port === 22 &&
        byAlias['db2'].host === 'db2',
      detail: JSON.stringify([byAlias['db1'], byAlias['db2']])
    },
    {
      name: 'a host without a User imports as null, not an invented name',
      ok: (() => {
        const bare = parseSshConfig(['Host solo', '  HostName 10.0.0.1'].join(NL), { home })
        return bare.hosts.length === 1 && bare.hosts[0].username === null
      })(),
      detail: 'the session then falls back to the app default at creation'
    },
    {
      name: 'a wildcard block offers no host but does hand its options down',
      ok: (() => {
        const text = ['Host web-*', '  User webteam', '', 'Host web-7'].join(NL)
        const out = parseSshConfig(text, { home })
        return (
          out.hosts.length === 1 &&
          out.hosts[0].alias === 'web-7' &&
          out.hosts[0].username === 'webteam'
        )
      })(),
      detail: 'web-7 inherits from Host web-*'
    },
    {
      name: 'a negated pattern excludes a name from inherited options',
      ok: (() => {
        const text = [
          'Host * !bastion',
          '  User shared',
          '',
          'Host bastion',
          '  HostName 10.0.0.9',
          '',
          'Host web1'
        ].join(NL)
        const out = parseSshConfig(text, { home })
        const bastion = out.hosts.find((h) => h.alias === 'bastion')
        const web1 = out.hosts.find((h) => h.alias === 'web1')
        return out.hosts.length === 2 && bastion.username === null && web1.username === 'shared'
      })(),
      detail: 'bastion is excluded from the Host * !bastion block'
    },
    {
      name: 'options before the first Host apply to every host',
      ok: (() => {
        const text = ['User ops', '', 'Host web1', '  HostName 10.0.0.2'].join(NL)
        const out = parseSshConfig(text, { home })
        return out.hosts.length === 1 && out.hosts[0].username === 'ops'
      })(),
      detail: 'the implicit first block'
    },
    {
      name: 'the Key=Value spelling and lowercase keywords read the same',
      ok: (() => {
        const text = [
          'host web1',
          '  hostname=10.0.0.3',
          '  Port = 2222',
          '  IdentityFile "~/.ssh/my key"'
        ].join(NL)
        const out = parseSshConfig(text, { home })
        return (
          out.hosts.length === 1 &&
          out.hosts[0].host === '10.0.0.3' &&
          out.hosts[0].port === 2222 &&
          out.hosts[0].privateKeyPath === home + '/.ssh/my key'
        )
      })(),
      detail: 'Key=Value, Key = Value, quoted value with a space'
    },
    {
      name: 'a quoted value keeps its hash, a bare one starts a comment',
      ok: (() => {
        const text = ['Host q1', '  ProxyCommand "nc -x a=b" # jump through the proxy'].join(NL)
        const out = parseSshConfig(text, { home })
        return out.hosts.length === 1 && out.hosts[0].proxy === 'nc -x a=b'
      })(),
      detail: 'the comment after the value is gone, the value is whole'
    },
    {
      name: 'an unusable Port falls back to 22 instead of breaking the import',
      ok: (() => {
        const text = [
          'Host p1', '  Port 0', '  HostName h1',
          '',
          'Host p2', '  Port 99999',
          '',
          'Host p3', '  Port soon'
        ].join(NL)
        const out = parseSshConfig(text, { home })
        return out.hosts.length === 3 && out.hosts.every((h) => h.port === 22)
      })(),
      detail: '0, 99999 and a word all read as "no port"'
    }
  ])

  // ---- Include -------------------------------------------------------------
  const includeBody = ['Host inc1', '  HostName 10.9.9.9', '  User included'].join(NL)
  const includeFile = path.join(dir, 'included.conf')
  fs.writeFileSync(includeFile, includeBody, 'utf8')
  const withInclude = [
    'Include ' + includeFile,
    '',
    'Host web1',
    '  HostName 10.0.0.4'
  ].join(NL)
  const included = parseSshConfig(withInclude, {
    home,
    include: (raw) => {
      const target = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw
      if (!fs.existsSync(target)) return null
      return { text: fs.readFileSync(target, 'utf8'), path: target }
    }
  })
  const inc1 = included.hosts.find((h) => h.alias === 'inc1')

  report([
    {
      name: 'an Include is spliced in where the directive sits',
      ok:
        inc1 &&
        inc1.host === '10.9.9.9' &&
        inc1.username === 'included' &&
        included.includes.length === 1,
      detail: JSON.stringify({ includes: included.includes, inc1: inc1 || null })
    },
    {
      name: 'an Include of a missing file is skipped, not fatal',
      ok: (() => {
        const text = ['Include ' + path.join(dir, 'nope.conf'), '', 'Host web1'].join(NL)
        const out = parseSshConfig(text, {
          home,
          include: (raw) => (fs.existsSync(raw) ? { text: '', path: raw } : null)
        })
        return out.hosts.length === 1 && out.hosts[0].alias === 'web1'
      })(),
      detail: 'the rest of the config still imports'
    },
    {
      name: 'an Include cycle stops instead of hanging',
      ok: (() => {
        const self = path.join(dir, 'self.conf')
        const text = ['Include ' + self, '', 'Host web1'].join(NL)
        fs.writeFileSync(self, text, 'utf8')
        const out = parseSshConfig(text, {
          home,
          include: (raw) => ({ text: fs.readFileSync(raw, 'utf8'), path: raw })
        })
        return out.hosts.length === 1
      })(),
      detail: 'visited-set guards the recursion'
    },
    {
      name: 'a Match block is skipped, its options never applied',
      ok: (() => {
        const text = [
          'Match host evil',
          '  User eviluser',
          '',
          'Host web1',
          '  HostName 10.0.0.5'
        ].join(NL)
        const out = parseSshConfig(text, { home })
        return out.hosts.length === 1 && out.hosts[0].username === null
      })(),
      detail: 'conditional blocks cannot be evaluated offline'
    },
    {
      name: 'the first Host line naming a machine wins',
      ok: (() => {
        const text = [
          'Host web1',
          '  HostName 10.0.0.6',
          '',
          'Host web1',
          '  HostName 10.0.0.7'
        ].join(NL)
        const out = parseSshConfig(text, { home })
        return out.hosts.length === 1 && out.hosts[0].host === '10.0.0.6'
      })(),
      detail: 'a re-declared alias is not a second machine'
    }
  ])

  // Cleanup after all of part 1 has run.
  report([])
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---- part 2: the whole feature through the app -----------------------------

async function main() {
  partA()

  const workspace = path.join(os.tmpdir(), 'termdeck-sshconfig-probe')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  const fixture = path.join(workspace, 'config')
  const keyLine = '  IdentityFile ~/.ssh/id_ed25519_probe'
  fs.writeFileSync(
    fixture,
    [
      'Host web1',
      '  HostName 10.17.20.211',
      '  Port 2200',
      '',
      'Host bastion',
      '  User deploy',
      keyLine,
      '  ProxyJump web1',
      '',
      'Host db1',
      '  User dbops',
      '',
      'Host *',
      '  User fleet'
    ].join(NL),
    'utf8'
  )

  process.env['TERMDECK_SSH_CONFIG'] = fixture

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  const stores = mod.storeAccess()
  stores.layout.clear()

  const win = new BrowserWindow({
    width: 1300,
    height: 900,
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
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(2600)

  // An existing host that db1 collides with (same user, host and port), plus a
  // group to import into. Seed by name and read back by name: upserts return
  // the whole tree, never the object that was created.
  const seeded = await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    await api.saveFolder({ name: 'imported', parentId: null })
    const tree = await api.loadSessionTree()
    const folder = tree.folders.filter((f) => f.name === 'imported')[0]
    await api.saveSessions({
      sessions: [
        { name: 'db1', host: 'db1', port: 22, username: 'dbops', authMethod: 'password', parentId: folder.id }
      ]
    })
    const after = await api.loadSessionTree()
    const again = after.folders.filter((f) => f.name === 'imported')[0]
    return { folderId: again ? again.id : null, sessions: after.sessions.length }
  })()`)

  const peek = await win.webContents.executeJavaScript(
    '(async () => { return await window.termdeck.peekSshConfig() })()'
  )
  const peekHosts = peek && peek.ok ? peek.hosts : []
  const peekBy = {}
  for (const host of peekHosts) peekBy[host.alias] = host
  const expectedKey = path.join(os.homedir(), '.ssh', 'id_ed25519_probe')

  report([
    {
      name: 'the seed data and the group are there',
      ok: seeded.folderId !== null && seeded.sessions === 1,
      detail: JSON.stringify(seeded)
    },
    {
      name: 'a peek reads the config this machine was pointed at',
      ok: peek.ok === true && peek.path === fixture && peekHosts.length === 3,
      detail: JSON.stringify({ ok: peek.ok, path: peek.path, hosts: peekHosts.length })
    },
    {
      name: 'peeked fields survive the IPC round trip',
      ok:
        peekBy['web1'] &&
        peekBy['web1'].host === '10.17.20.211' &&
        peekBy['web1'].port === 2200 &&
        peekBy['web1'].username === 'fleet' &&
        peekBy['bastion'] &&
        peekBy['bastion'].privateKeyPath === expectedKey &&
        peekBy['bastion'].proxy === 'web1',
      detail: JSON.stringify({ web1: peekBy['web1'], bastion: peekBy['bastion'] })
    },
    {
      name: 'a host already saved here is marked duplicate',
      ok: !!peekBy['db1'] && peekBy['db1'].duplicate === true &&
        peekBy['web1'] && peekBy['web1'].duplicate === false,
      detail: JSON.stringify(peekHosts.map((h) => [h.alias, h.duplicate]))
    }
  ])

  // ---- the dialog ----------------------------------------------------------
  const page = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}
    document.querySelector('[data-testid="rail-hosts"]').click()
    await wait(800)
    const button = document.querySelector('[data-testid="hosts-import-config"]')
    out.hasButton = !!button
    if (!button) return out
    button.click()
    await wait(400)
    for (let i = 0; i < 40; i += 1) {
      if (document.querySelector('[data-testid="sshconfig-hosts"]')) break
      await wait(150)
    }
    const rows = [...document.querySelectorAll('[data-testid="sshconfig-host"]')]
    out.rowCount = rows.length
    out.aliases = rows.map((el) => el.getAttribute('data-alias'))
    out.checked = {}
    for (const el of rows) out.checked[el.getAttribute('data-alias')] = el.checked
    out.duplicateBadge = document.querySelectorAll('[data-testid="sshconfig-duplicate"]').length
    out.pathShown = (document.querySelector('[data-testid="sshconfig-path"]') || {}).textContent || ''
    out.submitDisabled = (document.querySelector('[data-testid="sshconfig-submit"]') || {}).disabled
    return out
  })()`)

  report([
    {
      name: 'the Hosts page offers the SSH config import',
      ok: page.hasButton === true,
      detail: JSON.stringify({ hasButton: page.hasButton })
    },
    {
      name: 'the dialog lists every importable host with its own row',
      ok:
        page.rowCount === 3 &&
        JSON.stringify(page.aliases) === JSON.stringify(['web1', 'bastion', 'db1']),
      detail: JSON.stringify({ rowCount: page.rowCount, aliases: page.aliases })
    },
    {
      name: 'duplicates start unticked, new hosts start ticked',
      ok:
        page.checked &&
        page.checked['db1'] === false &&
        page.checked['web1'] === true &&
        page.checked['bastion'] === true,
      detail: JSON.stringify(page.checked)
    },
    {
      name: 'the duplicate says so, and the file path is shown',
      ok: page.duplicateBadge === 1 && (page.pathShown || '').indexOf('config') >= 0,
      detail: JSON.stringify({ badges: page.duplicateBadge, path: page.pathShown })
    },
    {
      name: 'Import is armed while anything is ticked',
      ok: page.submitDisabled === false,
      detail: String(page.submitDisabled)
    }
  ])

  if (!page.hasButton) {
    report([
      { name: 'the import flow ran', ok: false, detail: 'no [data-testid=hosts-import-config] on the page' }
    ])
  } else {
    // Import the two ticked hosts into the seeded group.
    const importOutcome = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const tree = await window.termdeck.loadSessionTree()
      const folder = tree.folders.filter((f) => f.name === 'imported')[0]
      const select = document.querySelector('[data-testid="sshconfig-folder"]')
      if (!select) return { ok: false, why: 'no folder select' }
      select.value = folder.id
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(250)
      const submit = document.querySelector('[data-testid="sshconfig-submit"]')
      if (!submit) return { ok: false, why: 'no submit' }
      submit.click()
      let toast = ''
      for (let i = 0; i < 40; i += 1) {
        await wait(150)
        const el = document.querySelector('[data-testid="sshconfig-dialog"]')
        if (!el) break
      }
      for (let i = 0; i < 20; i += 1) {
        const el = document.querySelector('.td-toast')
        if (el) { toast = el.textContent || ''; break }
        await wait(150)
      }
      const after = await window.termdeck.loadSessionTree()
      return {
        ok: true,
        toast,
        sessions: after.sessions.map((s) => ({
          name: s.name,
          host: s.host,
          port: s.port,
          username: s.username,
          authMethod: s.authMethod,
          privateKeyPath: s.privateKeyPath,
          notes: s.notes,
          parentId: s.parentId,
          hasPassword: s.hasPassword
        })),
        folders: after.folders.length
      }
    })()`)

    const sessionByName = {}
    for (const session of importOutcome.sessions || []) sessionByName[session.name] = session
    const importedFolderId = seeded.folderId

    report([
      {
        name: 'the dialog closes and reports what it did',
        ok:
          importOutcome.ok === true &&
          /Imported 2/.test(importOutcome.toast || '') &&
          /skipped 0/.test(importOutcome.toast || ''),
        detail: importOutcome.toast || JSON.stringify(importOutcome).slice(0, 100)
      },
      {
        name: 'the imported hosts carry the config values',
        ok:
          !!sessionByName['web1'] &&
          sessionByName['web1'].host === '10.17.20.211' &&
          sessionByName['web1'].port === 2200 &&
          sessionByName['web1'].username === 'fleet' &&
          sessionByName['web1'].authMethod === 'password' &&
          sessionByName['web1'].hasPassword === false,
        detail: JSON.stringify(sessionByName['web1'])
      },
      {
        name: 'an IdentityFile becomes key auth',
        ok:
          !!sessionByName['bastion'] &&
          sessionByName['bastion'].authMethod === 'key' &&
          sessionByName['bastion'].privateKeyPath === expectedKey,
        detail: JSON.stringify(sessionByName['bastion'])
      },
      {
        name: 'the ProxyJump lands in the notes, marked as not applied',
        ok:
          !!sessionByName['bastion'] &&
          (sessionByName['bastion'].notes || '').indexOf('web1') >= 0 &&
          (sessionByName['bastion'].notes || '').toLowerCase().indexOf('not applied') >= 0,
        detail: String(sessionByName['bastion'] && sessionByName['bastion'].notes)
      },
      {
        name: 'the imports went into the chosen group',
        ok:
          !!sessionByName['web1'] &&
          sessionByName['web1'].parentId === importedFolderId &&
          !!sessionByName['bastion'] &&
          sessionByName['bastion'].parentId === importedFolderId,
        detail: 'parentId=' + importedFolderId
      },
      {
        name: 'the duplicate was not imported again',
        ok:
          importOutcome.sessions.length === 3 &&
          !!sessionByName['db1'],
        detail: 'sessions on disk: ' + importOutcome.sessions.length
      }
    ])

    // Importing the same hosts again plans nothing new, whatever the dialog says.
    const again = await win.webContents.executeJavaScript(
      '(async () => { const peek = await window.termdeck.peekSshConfig();' +
        ' if (!peek.ok) return { ok: false };' +
        ' const result = await window.termdeck.importSshConfig({ hosts: peek.hosts });' +
        ' if (!result.ok) return result;' +
        ' const tree = await window.termdeck.loadSessionTree();' +
        ' return { ok: true, summary: result.summary, sessions: tree.sessions.length } })()'
    )
    report([
      {
        name: 'importing everything a second time adds nothing',
        ok:
          again.ok === true &&
          again.summary.added === 0 &&
          again.summary.skipped === 3 &&
          again.sessions === 3,
        detail: JSON.stringify(again)
      }
    ])

    // A config that is not there explains itself, in the dialog and over IPC.
    const missing = path.join(workspace, 'no-such-config')
    process.env['TERMDECK_SSH_CONFIG'] = missing

    const missingPeek = await win.webContents.executeJavaScript(
      '(async () => { return await window.termdeck.peekSshConfig() })()'
    )

    const missingDialog = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const existing = document.querySelector('[data-testid="sshconfig-dialog"]')
      if (existing) {
        const cancel = [...document.querySelectorAll('[data-testid="sshconfig-dialog"] button')]
          .find((b) => (b.textContent || '').trim() === 'Cancel')
        if (cancel) cancel.click()
        await wait(400)
      }
      const button = document.querySelector('[data-testid="hosts-import-config"]')
      if (!button) return { ok: false, why: 'button gone' }
      button.click()
      for (let i = 0; i < 30; i += 1) {
        if (document.querySelector('[data-testid="sshconfig-error"]')) break
        await wait(150)
      }
      const error = document.querySelector('[data-testid="sshconfig-error"]')
      return {
        ok: true,
        error: error ? error.textContent || '' : '',
        submitDisabled: (document.querySelector('[data-testid="sshconfig-submit"]') || {}).disabled
      }
    })()`)

    process.env['TERMDECK_SSH_CONFIG'] = fixture

    report([
      {
        name: 'a peek at a missing config fails with a sentence',
        ok:
          missingPeek.ok === false &&
          (missingPeek.message || '').indexOf(missing) >= 0,
        detail: JSON.stringify(missingPeek)
      },
      {
        name: 'and the dialog shows that sentence instead of a list',
        ok:
          missingDialog.ok === true &&
          (missingDialog.error || '').indexOf('no-such-config') >= 0 &&
          missingDialog.submitDisabled === true,
        detail: JSON.stringify(missingDialog).slice(0, 160)
      }
    ])
  }

  const failed = all.filter((c) => !c.ok)
  console.log('')
  console.log(`${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('sshconfig probe crashed:', err)
    app.exit(1)
  })
)
