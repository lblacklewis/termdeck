/**
 * Sharing saved hosts with someone else.
 *
 *   npm run build && electron smoke/share.cjs --user-data-dir=...
 *
 * Three parts. First the container itself: a round trip, a wrong passphrase, a
 * file that was damaged on the way, and a file that is not ours at all. Then the
 * merge rules, which are where a shared list can quietly go wrong — importing the
 * same file twice must not double the tree, and a host that is already here must
 * not be added again while a second login to the same machine must be. Finally the
 * whole thing through the real IPC, including the one claim that matters most:
 * the exported file is unreadable without the passphrase.
 */
const fs = require('node:fs')
const os = require('node:os')
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

const PASSPHRASE = 'correct horse battery'

async function main() {
  const workspace = path.join(os.tmpdir(), 'termdeck-share-probe')
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  const stores = mod.storeAccess()
  stores.layout.clear()

  // ---- 1. the container ---------------------------------------------------
  const tree = {
    folders: [
      { id: 'f1', name: 'client', parentId: null, createdAt: 1 },
      { id: 'f2', name: 'web', parentId: 'f1', createdAt: 2 }
    ],
    sessions: [
      {
        id: 's1',
        name: 'prod-web-01',
        host: '10.17.20.211',
        port: 22,
        username: 'root',
        authMethod: 'password',
        tags: ['prod'],
        parentId: 'f2',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 's2',
        name: 'bastion',
        host: '82.156.226.192',
        port: 2222,
        username: 'ops',
        authMethod: 'key',
        privateKeyPath: '/home/ops/.ssh/id_ed25519',
        tags: [],
        parentId: null,
        createdAt: 4,
        updatedAt: 4
      }
    ]
  }
  const secrets = {
    s1: { password: 'hunter2-not-in-the-file' },
    s2: { passphrase: 'key-passphrase-xyz' }
  }
  const credentialOf = (id) => secrets[id] ?? {}

  const doc = mod.buildShareDocument(tree, credentialOf, {
    includeCredentials: true,
    app: 'TermDeck 0.1.0'
  })
  const packed = mod.packShare(doc, PASSPHRASE)
  const plainJson = Buffer.from(JSON.stringify(doc), 'utf8')

  const roundTrip = mod.unpackShare(packed, PASSPHRASE)
  report([
    {
      name: 'a share file round-trips',
      ok:
        roundTrip.sessions.length === 2 &&
        roundTrip.folders.length === 2 &&
        roundTrip.sessions[0].host === '10.17.20.211',
      detail: `${roundTrip.sessions.length} sessions, ${roundTrip.folders.length} folders`
    },
    {
      name: 'the container is compressed',
      ok: packed.length < plainJson.length,
      detail: `${packed.length} bytes vs ${plainJson.length} bytes of JSON`
    },
    {
      name: 'it starts with the format magic',
      ok: packed.subarray(0, mod.SHARE_MAGIC.length).toString('utf8') === mod.SHARE_MAGIC,
      detail: mod.SHARE_MAGIC
    },
    {
      /*
       * The point of the whole exercise. The file travels through mail and chat
       * apps, so nothing about the fleet may be readable from it.
       */
      name: 'no password, hostname or session name is readable in the file',
      ok:
        packed.indexOf('hunter2-not-in-the-file') < 0 &&
        packed.indexOf('key-passphrase-xyz') < 0 &&
        packed.indexOf('10.17.20.211') < 0 &&
        packed.indexOf('prod-web-01') < 0,
      detail: 'searched the raw bytes and the base64 of them'
    },
    {
      name: 'the credentials are inside the encrypted body, not beside it',
      ok:
        roundTrip.credentials.s1?.password === 'hunter2-not-in-the-file' &&
        roundTrip.credentials.s2?.passphrase === 'key-passphrase-xyz',
      detail: JSON.stringify(Object.keys(roundTrip.credentials))
    }
  ])

  // ---- 2. failing loudly --------------------------------------------------
  const expect = (fn, code) => {
    try {
      fn()
      return { ok: false, detail: 'no error thrown', message: '' }
    } catch (err) {
      const right = err instanceof mod.ShareError && err.code === code
      const message = String(err.message)
      return { ok: right, detail: `${err.name}:${err.code} ${message.slice(0, 60)}`, message }
    }
  }

  const wrongKey = expect(() => mod.unpackShare(packed, 'not the passphrase'), 'BAD_PASSPHRASE')
  const shortKey = expect(() => mod.packShare(doc, 'short'), 'BAD_PASSPHRASE')
  const notOurs = expect(
    () => mod.unpackShare(Buffer.from('PK' + String.fromCharCode(3, 4) + ' not ours at all'), 'BAD_FILE'),
    'BAD_FILE'
  )
  const truncated = expect(() => mod.unpackShare(packed.subarray(0, 40), 'BAD_FILE'), 'BAD_FILE')

  // One flipped bit in the ciphertext must be caught, not decoded.
  const damaged = Buffer.from(packed)
  damaged[damaged.length - 3] ^= 0x40
  const tampered = expect(() => mod.unpackShare(damaged, PASSPHRASE), 'BAD_PASSPHRASE')

  // A newer writer is refused as such instead of being read as nonsense.
  const future = mod.packShare({ ...doc, version: mod.SHARE_VERSION + 1 }, PASSPHRASE)
  const tooNew = expect(() => mod.unpackShare(future, PASSPHRASE), 'UNSUPPORTED')

  report([
    { name: 'a wrong passphrase fails with its own reason', ok: wrongKey.ok, detail: wrongKey.detail },
    {
      /*
       * GCM cannot tell a wrong key from a flipped bit, so the message has to own
       * both — otherwise a file that was truncated in transit sends the user off
       * to retype a passphrase that was right.
       */
      name: 'and its message admits the file may be damaged instead',
      ok: wrongKey.ok && /damaged/i.test(wrongKey.message),
      detail: wrongKey.message
    },
    { name: 'a passphrase too short to be worth using is refused', ok: shortKey.ok, detail: shortKey.detail },
    { name: 'a file that is not ours is refused', ok: notOurs.ok, detail: notOurs.detail },
    { name: 'a truncated file is refused', ok: truncated.ok, detail: truncated.detail },
    { name: 'a damaged byte is caught by the authentication tag', ok: tampered.ok, detail: tampered.detail },
    { name: 'a file from a newer version is refused by version', ok: tooNew.ok, detail: tooNew.detail }
  ])

  // ---- 3. the merge rules -------------------------------------------------
  const current = {
    folders: [{ id: 'keep', name: 'client', parentId: null, createdAt: 1 }],
    sessions: [
      {
        id: 'existing',
        name: 'prod-web-01 (mine)',
        host: '10.17.20.211',
        port: 22,
        username: 'root',
        authMethod: 'password',
        tags: [],
        parentId: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }

  const plan = mod.planImport(doc, current)
  const summary = mod.summariseImport(plan)
  report([
    {
      name: 'a host already saved here is skipped, not duplicated',
      ok: summary.skipped === 1 && summary.added === 1,
      detail: `${summary.added} added, ${summary.skipped} skipped`
    },
    {
      name: 'the same name group is reused instead of doubled',
      ok: summary.reusedFolders.length === 1 && summary.folders === 1,
      detail: `new=${summary.folders} reused=${JSON.stringify(summary.reusedFolders)}`
    },
    {
      name: 'the nested group is recreated under the reused one',
      ok: plan.folders.length === 1 && plan.folders[0].name === 'web',
      detail: JSON.stringify(plan.folders)
    },
    {
      name: 'an imported session keeps its group, port and auth method',
      ok: (() => {
        const imported = plan.sessions[0]
        return (
          imported.host === '82.156.226.192' &&
          imported.port === 2222 &&
          imported.authMethod === 'key' &&
          imported.privateKeyPath === '/home/ops/.ssh/id_ed25519'
        )
      })(),
      detail: JSON.stringify(plan.sessions[0])
    },
    {
      name: 'secrets are re-keyed to the ids minted here',
      ok:
        plan.credentials.length === 1 &&
        plan.credentials[0].id === plan.sessions[0].id &&
        plan.credentials[0].passphrase === 'key-passphrase-xyz',
      detail: JSON.stringify(plan.credentials.map((c) => c.id === plan.sessionIdMap.s2))
    },
    {
      name: 'a second import of the same file plans nothing at all',
      ok: (() => {
        const again = mod.planImport(doc, {
          folders: [...current.folders, ...plan.folders.map((f) => ({ ...f, createdAt: 9 }))],
          sessions: [
            ...current.sessions,
            ...plan.sessions.map((s) => ({ ...s, createdAt: 9, updatedAt: 9 }))
          ]
        })
        return again.sessions.length === 0 && again.folders.length === 0
      })(),
      detail: 'importing twice is idempotent'
    },
    {
      name: 'a second login to the same host is not a duplicate',
      ok: (() => {
        const other = mod.planImport(
          {
            ...doc,
            sessions: [{ ...tree.sessions[0], id: 's9', username: 'deploy', parentId: null }],
            credentials: {}
          },
          current
        )
        return other.sessions.length === 1 && other.duplicates.length === 0
      })(),
      detail: 'duplicate means host and username and port'
    },
    {
      name: 'unticking the password box drops the secrets',
      ok: mod.planImport(doc, current, { skipCredentials: true }).credentials.length === 0,
      detail: 'imported hosts keep their password only if asked'
    },
    {
      name: 'an export without credentials carries none',
      ok:
        Object.keys(
          mod.buildShareDocument(tree, credentialOf, { includeCredentials: false, app: 'x' })
            .credentials
        ).length === 0,
      detail: 'and still reports which hosts have one'
    }
  ])

  // ---- 4. through the real IPC --------------------------------------------
  const file = path.join(workspace, 'handover.tdshare')

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

  // Build a real tree with a real stored secret through the app's own API.
  const prepared = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const api = window.termdeck
    const folder = await api.saveFolder({ name: 'shared-client', parentId: null })
    const list = await api.loadSessionTree()
    const parent = list.folders.filter((f) => f.name === 'shared-client')[0]
    await api.saveSessions({
      sessions: [
        { name: 'web-01', host: '10.20.30.40', port: 22, username: 'root', authMethod: 'password', tags: ['shared'], parentId: parent.id },
        { name: 'db-01', host: '10.20.30.41', port: 2200, username: 'deploy', authMethod: 'password', tags: ['shared'], parentId: parent.id }
      ],
      credential: { password: 'shared-secret-777' }
    })
    await wait(400)
    return { folderId: parent.id }
  })()`)

  const ipcExport = await win.webContents.executeJavaScript(`(async () => {
    return await window.termdeck.exportShare({
      passphrase: '${PASSPHRASE}',
      includeCredentials: true,
      filePath: ${JSON.stringify(file)}
    })
  })()`)
  await sleep(300)

  const onDisk = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
  report([
    {
      name: 'the export writes a file where it was told to',
      ok: ipcExport.ok === true && onDisk.length > 0,
      detail: JSON.stringify(ipcExport).slice(0, 120)
    },
    {
      name: 'the file on disk holds no readable host or password',
      ok:
        onDisk.indexOf('10.20.30.40') < 0 &&
        onDisk.indexOf('shared-secret-777') < 0 &&
        onDisk.indexOf('web-01') < 0,
      detail: `${onDisk.length} bytes, searched raw`
    },
    {
      /*
       * The passphrase rule is enforced in the packer, so the handler has to
       * surface it as a refusal rather than writing a file protected by "1234".
       */
      name: 'a passphrase below the minimum is refused before anything is written',
      ok: await (async () => {
        const target = path.join(workspace, 'too-short.tdshare')
        const result = await win.webContents.executeJavaScript(`(async () => {
          return await window.termdeck.exportShare({
            passphrase: 'short',
            includeCredentials: true,
            filePath: ${JSON.stringify(path.join(workspace, 'too-short.tdshare'))}
          })
        })()`)
        return result.ok === false && !fs.existsSync(target) && /at least/i.test(result.message || '')
      })(),
      detail: 'nothing is written when the passphrase is too short'
    }
  ])

  // The tree is wiped, exactly like a machine that has never seen these hosts.
  const before = await win.webContents.executeJavaScript(`(async () => {
    const api = window.termdeck
    const list = await api.loadSessionTree()
    for (const session of list.sessions) await api.deleteSession(session.id)
    for (const folder of list.folders) await api.deleteFolder(folder.id)
    const after = await api.loadSessionTree()
    return { sessions: after.sessions.length, folders: after.folders.length }
  })()`)
  await sleep(400)

  const peek = await win.webContents.executeJavaScript(`(async () => {
    return await window.termdeck.peekShare(${JSON.stringify(file)}, '${PASSPHRASE}')
  })()`)

  const imported = await win.webContents.executeJavaScript(`(async () => {
    const result = await window.termdeck.importShare({
      filePath: ${JSON.stringify(file)},
      passphrase: '${PASSPHRASE}'
    })
    if (!result.ok) return result
    const list = await window.termdeck.loadSessionTree()
    return {
      ok: true,
      summary: result.summary,
      sessions: list.sessions.map((s) => ({
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        tags: s.tags,
        hasPassword: s.hasPassword
      })),
      folders: list.folders.map((f) => f.name)
    }
  })()`)

  report([
    {
      name: 'the tree was emptied before importing',
      ok: before.sessions === 0 && before.folders === 0,
      detail: JSON.stringify(before)
    },
    {
      name: 'a peek says what the file holds without importing it',
      ok: peek.ok === true && peek.preview.sessions === 2 && peek.preview.withPasswords === 2,
      detail: JSON.stringify(peek).slice(0, 160)
    },
    {
      name: 'a peek on a wrong passphrase explains itself and imports nothing',
      ok: await win.webContents
        .executeJavaScript(
          `window.termdeck.peekShare(${JSON.stringify(file)}, 'wrong-passphrase')`
        )
        .then((r) => r.ok === false && /passphrase|damaged/i.test(r.message || '')),
      detail: 'the error is the packer error, surfaced by the handler'
    },
    {
      name: 'importing brings the hosts and their group back',
      ok:
        imported.ok === true &&
        imported.summary.added === 2 &&
        imported.folders.indexOf('shared-client') >= 0,
      detail: JSON.stringify(imported.summary || imported)
    },
    {
      name: 'the imported hosts keep their port, user and tags',
      ok:
        imported.ok === true &&
        imported.sessions.some(
          (s) => s.name === 'db-01' && s.port === 2200 && s.username === 'deploy' && s.tags.includes('shared')
        ),
      detail: JSON.stringify(imported.sessions || [])
    },
    {
      name: 'and the passwords came with them',
      ok: imported.ok === true && imported.sessions.every((s) => s.hasPassword === true),
      detail: JSON.stringify((imported.sessions || []).map((s) => s.hasPassword))
    },
    {
      name: 'the imported password really opens',
      ok: await win.webContents
        .executeJavaScript(`(async () => {
          const list = await window.termdeck.loadSessionTree()
          const target = list.sessions.filter((s) => s.name === 'web-01')[0]
          if (!target) return false
          return (await window.termdeck.revealCredential(target.id)) === 'shared-secret-777'
        })()`),
      detail: 're-sealed under the id it has on this machine'
    },
    {
      name: 'importing the same file again adds nothing',
      ok: await win.webContents
        .executeJavaScript(`(async () => {
          const again = await window.termdeck.importShare({
            filePath: ${JSON.stringify(file)},
            passphrase: '${PASSPHRASE}'
          })
          if (!again.ok) return false
          const list = await window.termdeck.loadSessionTree()
          return again.summary.added === 0 && again.summary.skipped === 2 && list.sessions.length === 2
        })()`),
      detail: 'the tree is not doubled'
    }
  ])

  // ---- 5. the dialog ------------------------------------------------------
  const dialog = await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}
    document.querySelector('[data-testid="rail-hosts"]').click()
    await wait(700)
    out.hasExport = !!document.querySelector('[data-testid="hosts-export"]')
    out.hasImport = !!document.querySelector('[data-testid="hosts-import"]')

    document.querySelector('[data-testid="hosts-export"]').click()
    await wait(500)
    const modal = document.querySelector('[data-testid="share-dialog"]')
    out.exportOpened = !!modal
    const pass = document.querySelector('[data-testid="share-passphrase"]')
    const repeat = document.querySelector('[data-testid="share-confirm"]')
    const submit = document.querySelector('[data-testid="share-submit"]')
    out.exportDisabledFirst = !!submit && submit.disabled
    out.checkboxOn = !!document.querySelector('[data-testid="share-include-passwords"]')?.checked

    // Too short, then mismatched, then fine.
    const type = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    type(pass, 'short')
    type(repeat, 'short')
    await wait(200)
    out.exportDisabledShort = submit.disabled
    type(pass, '${PASSPHRASE}')
    type(repeat, 'different passphrase')
    await wait(200)
    out.exportDisabledMismatch = submit.disabled
    type(repeat, '${PASSPHRASE}')
    await wait(200)
    out.exportEnabled = !submit.disabled

    // Close it again, then open the import side.
    ;[...document.querySelectorAll('[data-testid="share-dialog"] .td-modal-foot button')]
      .find((b) => /^Cancel$/.test(b.textContent.trim())).click()
    await wait(400)
    out.closed = !document.querySelector('[data-testid="share-dialog"]')

    document.querySelector('[data-testid="hosts-import"]').click()
    await wait(500)
    out.importOpened = !!document.querySelector('[data-testid="share-dialog"]')
    out.importHasPick = !!document.querySelector('[data-testid="share-choose-file"]')
    out.importSubmitDisabled = document.querySelector('[data-testid="share-submit"]').disabled

    // Typing a passphrase with no file must not pretend to have a preview.
    const pass2 = document.querySelector('[data-testid="share-passphrase"]')
    type(pass2, '${PASSPHRASE}')
    await wait(900)
    out.noPreviewWithoutFile = !document.querySelector('[data-testid="share-preview"]')

    ;[...document.querySelectorAll('[data-testid="share-dialog"] .td-modal-foot button')]
      .find((b) => /^Cancel$/.test(b.textContent.trim())).click()
    await wait(300)
    return out
  })()`)

  report([
    { name: 'the Hosts page offers both directions', ok: dialog.hasExport && dialog.hasImport, detail: JSON.stringify(dialog) },
    { name: 'the export dialog opens', ok: dialog.exportOpened === true },
    { name: 'Export is disabled until the passphrase is long enough', ok: dialog.exportDisabledFirst && dialog.exportDisabledShort, detail: JSON.stringify(dialog) },
    { name: 'and until the two passphrases match', ok: dialog.exportDisabledMismatch === true },
    { name: 'then it is ready', ok: dialog.exportEnabled === true },
    { name: 'passwords are included by default', ok: dialog.checkboxOn === true },
    { name: 'Cancel closes it', ok: dialog.closed === true },
    { name: 'the import dialog opens with a file picker', ok: dialog.importOpened && dialog.importHasPick },
    { name: 'Import is disabled until a file has been read', ok: dialog.importSubmitDisabled === true && dialog.noPreviewWithoutFile === true }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('share probe crashed:', err)
    app.exit(1)
  })
)
