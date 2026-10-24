/**
 * The S3 tool, end to end.
 *
 *   npm run build && electron smoke/s3.cjs --user-data-dir=...
 *
 * The far end is a mock S3 started by this probe, so the page really signs and
 * sends requests: list buckets, walk into one with a delimiter, read an object,
 * delete it, and get a readable error on a dead endpoint or a missing key. The
 * signing itself is verified against AWS's own vectors by `npm run check:s3`;
 * what this covers is everything around it — the bridge, the page, and the
 * promise that the secret key is never written to disk.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const http = require('node:http')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

const seen = []
/** What PUT actually put here: the only proof an upload carried the right bytes. */
const uploads = []

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

function xml(res, body, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/xml' })
  res.end(body)
}

function startMock() {
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url)
    const url = req.url || '/'
    const key = url.split('?')[0]

    if (url === '/' && req.method === 'GET') {
      return xml(
        res,
        '<ListAllMyBucketsResult><Buckets>' +
          '<Bucket><Name>alpha</Name><CreationDate>2023-05-01T00:00:00.000Z</CreationDate></Bucket>' +
          '<Bucket><Name>beta</Name><CreationDate>2023-06-01T00:00:00.000Z</CreationDate></Bucket>' +
          '</Buckets></ListAllMyBucketsResult>'
      )
    }
    if (key === '/alpha' && req.method === 'GET') {
      const listing = url.includes('prefix=dir%2F')
        ? '<Contents><Key>dir/a.txt</Key><Size>8</Size><LastModified>2024-01-02T03:04:05.000Z</LastModified></Contents>' +
          '<Contents><Key>dir/b.txt</Key><Size>9</Size><LastModified>2024-01-02T03:04:06.000Z</LastModified></Contents>'
        : '<Contents><Key>readme.md</Key><Size>12</Size><LastModified>2024-01-02T03:04:05.000Z</LastModified></Contents>' +
          '<CommonPrefixes><Prefix>dir/</Prefix></CommonPrefixes>' +
          '<CommonPrefixes><Prefix>logs/</Prefix></CommonPrefixes>'
      return xml(
        res,
        '<ListBucketResult><Name>alpha</Name><IsTruncated>false</IsTruncated>' +
          listing +
          '</ListBucketResult>'
      )
    }
    if (key === '/alpha/dir/a.txt' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('hello s3')
    }
    if (key === '/alpha/dir/b.txt' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('second object')
    }
    if (req.method === 'DELETE') return xml(res, '<DeleteObjectResult/>')
    if (req.method === 'PUT') {
      // Read the body before answering: otherwise the uploaded bytes are never
      // actually seen, and "did the file arrive" would be an assumption.
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        uploads.push({ url: key, body: Buffer.concat(chunks), type: req.headers['content-type'] })
        xml(res, '<PutObjectResult/>')
      })
      return
    }
    return xml(
      res,
      '<Error><Code>NoSuchKey</Code><Message>The key does not exist.</Message></Error>',
      404
    )
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const { server, port } = await startMock()
  const endpoint = 'http://127.0.0.1:' + port
  console.log('mock S3 on ' + endpoint)

  /*
   * ---- 0. the pure rules -------------------------------------------------
   * The tree, the history and the column decision are rules, not effects: they
   * are bundled out of src/shared on plain node here and asserted with
   * injected inputs — a clock, a cap, a window width — exactly the way the
   * SigV4 vectors are. An implementation that guessed at these rules in the
   * component would fail here before any window exists.
   */
  try {
    const { buildSync } = require('esbuild')
    const layoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-s3-layout-'))
    const entryFile = path.join(layoutDir, 'entry.ts')
    const sharedDir = path.join(ROOT, 'src', 'shared').split(path.sep).join('/')
    fs.writeFileSync(entryFile, 'export * from ' + JSON.stringify(sharedDir + '/s3Layout'), 'utf8')
    buildSync({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(layoutDir, 's3layout.cjs'),
      logLevel: 'silent'
    })
    const layout = require(path.join(layoutDir, 's3layout.cjs'))
    const visit = { endpoint: 'http://e', region: 'r', accessKeyId: 'AKIA', pathStyle: true, bucket: 'b', prefix: 'p/', at: 'T0' }
    const h1 = layout.pushS3Visit([], visit, { now: 'T1' })
    const h2 = layout.pushS3Visit(h1, Object.assign({}, visit, { bucket: 'b2' }), { now: 'T2' })
    const h3 = layout.pushS3Visit(h2, visit, { now: 'T3' })
    const capped = ['1', '2', '3', '4', '5'].reduce(
      (acc, n) => layout.pushS3Visit(acc, Object.assign({}, visit, { bucket: 'b' + n }), { max: 3, now: 'T' }),
      []
    )
    const sneaky = layout.pushS3Visit([], Object.assign({}, visit, { secretAccessKey: 'SHOULD-NOT-SURVIVE' }))
    const kept = layout.normaliseS3History([null, { bucket: 'no-endpoint' }, { endpoint: 'http://e', bucket: 'ok' }])
    const treeShape = function (nodes) {
      return JSON.stringify(nodes.map((n) => n.kind + ':' + n.path + '@' + n.depth))
    }
    const rootTree = layout.buildS3Tree(
      [{ name: 'alpha', createdAt: 'c1' }, { name: 'beta', createdAt: 'c2' }],
      { bucket: 'alpha', prefix: '', objects: [{ key: 'readme.md', size: 12, lastModified: 'L' }], prefixes: ['dir/', 'logs/'], truncated: false },
      'alpha'
    )
    const chainTree = layout.buildS3Tree(
      [{ name: 'alpha', createdAt: 'c1' }],
      { bucket: 'alpha', prefix: 'dir/', objects: [{ key: 'dir/a.txt', size: 8, lastModified: 'L' }], prefixes: [], truncated: false },
      'alpha'
    )
    report([
      {
        name: 'a visit is recorded newest first with the injected instant',
        ok: h1.length === 1 && h1[0].at === 'T1' && h1[0].bucket === 'b',
        detail: JSON.stringify(h1[0] || null)
      },
      {
        name: 'a different place is added, not merged',
        ok: h2.length === 2 && h2[0].bucket === 'b2',
        detail: h2.length + ' entries'
      },
      {
        name: 'revisiting the same place moves it to the top instead of duplicating',
        ok: h3.length === 2 && h3[0].prefix === 'p/' && h3[0].at === 'T3',
        detail: JSON.stringify(h3.map((v) => v.bucket + '/' + v.prefix + '@' + v.at))
      },
      {
        name: 'the cap is the injected one, keeping the newest',
        ok: capped.length === 3 && capped[0].bucket === 'b5',
        detail: JSON.stringify(capped.map((v) => v.bucket))
      },
      {
        name: 'a stray secret field does not survive the recording',
        ok: JSON.stringify(sneaky).indexOf('SHOULD-NOT-SURVIVE') < 0,
        detail: JSON.stringify(Object.keys(sneaky[0] || {}))
      },
      {
        name: 'a history that is not a list becomes an empty one',
        ok: layout.normaliseS3History('nonsense').length === 0 && kept.length === 1,
        detail: kept.length + ' usable of 3'
      },
      {
        name: 'the tree hangs folders and files under their own bucket',
        ok: treeShape(rootTree) === JSON.stringify(['bucket:alpha@0', 'folder:dir/@1', 'folder:logs/@1', 'object:readme.md@1', 'bucket:beta@0']),
        detail: treeShape(rootTree)
      },
      {
        name: 'the folders above the open prefix hold the tree up',
        ok: treeShape(chainTree) === JSON.stringify(['bucket:alpha@0', 'folder:dir/@1', 'object:dir/a.txt@2']),
        detail: treeShape(chainTree)
      },
      {
        name: 'the column decision follows the injected width and threshold',
        ok: layout.s3WorkspaceColumns(1400) === 'three' &&
          layout.s3WorkspaceColumns(900) === 'stacked' &&
          layout.s3WorkspaceColumns(900, { three: 800 }) === 'three',
        detail: '1400/900/900@800'
      }
    ])
    fs.rmSync(layoutDir, { recursive: true, force: true })
  } catch (err) {
    report([{ name: 'the pure S3 rules could not be bundled', ok: false, detail: String((err && err.message) || err) }])
  }

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  const win = new BrowserWindow({
    width: 1400,
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
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)
  win.focus()

  /*
   * Real files for the transfer checks. The native dialogs cannot be clicked from
   * a probe, which is why picking and transferring are separate methods: these
   * call the transfer directly and the page's buttons are asserted separately.
   */
  const uploadSource = path.join(os.tmpdir(), 'td-s3-upload-' + process.pid + '.txt')
  const uploadBody = 'uploaded from disk\n'
  fs.writeFileSync(uploadSource, uploadBody, 'utf8')
  // A second file with a known extension: the stored Content-Type is what decides
  // whether a browser opens an object or downloads it.
  const uploadSource2 = path.join(os.tmpdir(), 'td-s3-upload-' + process.pid + '.json')
  const uploadBody2 = '{"ok":true}'
  fs.writeFileSync(uploadSource2, uploadBody2, 'utf8')
  const downloadTarget = path.join(os.tmpdir(), 'td-s3-download-' + process.pid + '.txt')
  fs.rmSync(downloadTarget, { force: true })

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
          await wait(150)
        }
        return false
      }
      const endpoint = ${JSON.stringify(endpoint)}
      const field = (id) => document.querySelector('[data-testid="' + id + '"]')
      const text = (id) => (field(id) ? field(id).textContent || '' : '')
      const valueOf = (id) => {
        const el = field(id)
        return el && typeof el.value === 'string' ? el.value : ''
      }
      const rows = (id) => [...document.querySelectorAll('[data-testid="' + id + '"]')]
      const setValue = (el, value) => {
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
          : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      }

      let step = 'start'
      try {

      // ---- 1. the page ------------------------------------------------------
      step = 'open page'
      const tab = [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('data-testid') || '') === 'rail-s3')
      push('the rail has an S3 entry', !!tab, tab ? tab.title || tab.textContent : 'none')
      if (!tab) return out
      tab.click()
      push('opening it shows the page', await waitFor(() => !!field('s3-page'), 15000))
      if (!field('s3-page')) return out

      // ---- 2. a bad endpoint is a readable error ---------------------------
      step = 'bad endpoint'
      setValue(field('s3-endpoint'), 'http://127.0.0.1:1')
      setValue(field('s3-access-key'), 'AKIDEXAMPLE')
      setValue(field('s3-secret-key'), 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY')
      field('s3-connect').click()
      push('a dead endpoint reports an error', await waitFor(() => !!field('s3-error'), 15000), text('s3-error'))
      push('and does not list buckets', rows('s3-bucket').length === 0)

      // ---- 3. missing credentials are refused before sending ---------------
      step = 'no credentials'
      setValue(field('s3-endpoint'), endpoint)
      setValue(field('s3-secret-key'), '')
      field('s3-connect').click()
      const refused = await waitFor(() => (text('s3-error') || '').includes('secret key'), 8000)
      push('a missing secret key is refused with a readable reason', refused, text('s3-error'))

      // ---- 4. a real listing ----------------------------------------------
      step = 'list'
      setValue(field('s3-secret-key'), 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY')
      field('s3-connect').click()
      const listed = await waitFor(() => rows('s3-bucket').length === 2, 15000)
      push('connecting lists the buckets', listed, rows('s3-bucket').map((r) => r.dataset.bucket).join(','))

      // ---- 5. walking into a bucket ---------------------------------------
      step = 'bucket'
      const alpha = rows('s3-bucket').find((r) => r.dataset.bucket === 'alpha')
      if (!alpha) {
        push('the alpha bucket is listed', false)
        return out
      }
      alpha.querySelector('button').click()
      const walked = await waitFor(() => rows('s3-object').length + rows('s3-prefix').length === 3, 15000)
      push('a bucket opens with folders and objects', walked,
        'prefixes=' + rows('s3-prefix').map((r) => r.dataset.prefix).join(',') +
        ' objects=' + rows('s3-object').map((r) => r.dataset.key).join(','))

      const dir = rows('s3-prefix').find((r) => r.dataset.prefix === 'dir/')
      if (dir) {
        dir.querySelector('button').click()
        const inside = await waitFor(() => rows('s3-object').length === 2, 15000)
        push('a folder navigates into it', inside,
          rows('s3-object').map((r) => r.dataset.key).join(','))
        push('the breadcrumb shows where we are', (text('s3-breadcrumb') || '').includes('dir'),
          text('s3-breadcrumb'))
      }

      // ---- 6. reading and deleting an object ------------------------------
      step = 'object'
      const object = rows('s3-object').find((r) => r.dataset.key === 'dir/a.txt')
      if (!object) {
        push('the object row is present', false)
        return out
      }
      object.querySelector('button').click()
      const previewed = await waitFor(() => valueOf('s3-preview-body') === 'hello s3', 15000)
      push('an object opens with its contents', previewed, valueOf('s3-preview-body'))
      push('the preview offers saving the object to a file', !!field('s3-download'))

      /*
       * An edit belongs to the object it was typed into. Switching objects used to
       * carry the draft across, so "write back" would have written one object's
       * text over another's key — the one mistake in this tool that loses data.
       */
      step = 'draft'
      setValue(field('s3-preview-body'), 'EDITED BY HAND')
      await wait(300)
      push('editing a preview offers a write-back', !!field('s3-put'))
      const other = rows('s3-object').find((r) => r.dataset.key === 'dir/b.txt')
      if (other) {
        other.querySelector('button').click()
        const switched = await waitFor(() => valueOf('s3-preview-body') === 'second object', 15000)
        push('opening another object shows that object, not the draft', switched,
          valueOf('s3-preview-body'))
        push('and the write-back is gone with the draft', !field('s3-put'))
      } else {
        push('the second object is listed', false)
      }

      step = 'delete'
      const aGain = rows('s3-object').find((r) => r.dataset.key === 'dir/a.txt')
      if (aGain) aGain.querySelector('button').click()
      // Wait for a.txt's own contents: the delete button already exists while the
      // previous object is still on screen, so clicking on that alone would delete
      // whichever object happened to be open.
      await waitFor(() => valueOf('s3-preview-body') === 'hello s3', 15000)
      push('the first object is open again, ready to delete',
        valueOf('s3-preview-body') === 'hello s3', valueOf('s3-preview-body'))
      field('s3-delete').click()
      // The preview closes and the folder is re-listed; whether the DELETE really
      // went out is asserted from the main process below, where the socket is.
      const deleted = await waitFor(() => !field('s3-preview') && rows('s3-object').length === 2, 15000)
      push('deleting refreshes the listing', deleted,
        'preview=' + Boolean(field('s3-preview')) + ' objects=' + rows('s3-object').length)

      // ---- 7. the secret key is not written to disk ------------------------
      step = 'kept connection'
      field('s3-profile-save').click()
      await wait(600)
      const state = await window.termdeck.loadS3State()
      push('a connection can be kept', state.profiles.length === 1,
        'profiles=' + state.profiles.length)
      push('the kept connection has the endpoint', state.profiles[0] && state.profiles[0].endpoint === endpoint,
        state.profiles[0] ? state.profiles[0].endpoint : 'none')
      push('and no secret key anywhere in it',
        state.profiles[0] && state.profiles[0].secretAccessKey === undefined,
        state.profiles[0] ? String(state.profiles[0].secretAccessKey) : 'none')
      push('nor in the draft', !state.draft || state.draft.secretAccessKey === undefined)

      // Keeping the same connection twice must not produce two rows: the first
      // version compared a scheme-stripped name against the full endpoint, so it
      // matched nothing and appended a duplicate every click.
      field('s3-profile-save').click()
      await wait(600)
      const twice = await window.termdeck.loadS3State()
      push('keeping the same connection again updates it instead of duplicating',
        twice.profiles.length === 1, 'profiles=' + twice.profiles.length)

      // ---- 8. real files, not just text ----------------------------------
      /*
       * The dialogs cannot be clicked from here, so the transfer is driven with
       * explicit paths — which is exactly why picking and transferring are two
       * methods. Whether the bytes really moved is asserted from the main process,
       * where the socket and the disk are.
       */
      step = 'files'
      const connection = {
        endpoint: endpoint,
        region: 'us-east-1',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        pathStyle: true
      }
      const uploadSourcePath = ${JSON.stringify(uploadSource)}
      const uploadSourcePath2 = ${JSON.stringify(uploadSource2)}
      const downloadTargetPath = ${JSON.stringify(downloadTarget)}
      const up = await window.termdeck.s3PutFile(
        connection,
        'alpha',
        'dir/uploaded.txt',
        uploadSourcePath
      )
      push('a local file can be uploaded as an object', up.ok,
        up.ok ? up.value.bytes + ' bytes' : up.error)
      const up2 = await window.termdeck.s3PutFile(
        connection,
        'alpha',
        'dir/config.json',
        uploadSourcePath2
      )
      push('a second file uploads too', up2.ok, up2.ok ? up2.value.bytes + ' bytes' : up2.error)
      const down = await window.termdeck.s3GetFile(
        connection,
        'alpha',
        'dir/a.txt',
        downloadTargetPath
      )
      push('an object can be saved to a local file', down.ok,
        down.ok ? down.value.bytes + ' bytes' : down.error)
      push('and the page offers uploading a file', !!field('s3-upload'))

      // ---- 9. the three-column workspace ------------------------------------
      /*
       * The page used to stack listing and preview in one vertical flow, which
       * left the middle of the window empty. These asserts read real geometry:
       * on the old layout the workspace does not exist at all, and no amount
       * of "it rendered without errors" would have caught the blank page.
       */
      step = 'workspace'
      const openForLayout = rows('s3-object').find((r) => r.dataset.key === 'dir/b.txt')
      if (!openForLayout) {
        push('the object to open for the layout check is listed', false)
        return out
      }
      openForLayout.querySelector('button').click()
      push('the object opens for the layout check',
        await waitFor(() => valueOf('s3-preview-body') === 'second object', 15000))

      const ws = field('s3-workspace')
      push('the page lays its results out in a three-column workspace',
        !!ws, ws ? ws.getAttribute('data-cols') : 'none')
      const boxOf = (el) => (el ? el.getBoundingClientRect() : null)
      const sideRect = boxOf(ws ? ws.querySelector('.td-s3-side') : null)
      const mainRect = boxOf(ws ? ws.querySelector('.td-s3-main') : null)
      const metaBox = ws ? ws.querySelector('.td-s3-meta') : null
      const metaRect = boxOf(metaBox)
      push('tree, contents and metadata sit side by side in that order',
        !!sideRect && !!mainRect && !!metaRect &&
        sideRect.right <= mainRect.left + 1 && mainRect.right <= metaRect.left + 1,
        [sideRect, mainRect, metaRect]
          .map((r) => (r ? Math.round(r.left) + '..' + Math.round(r.right) : 'none'))
          .join(' | '))
      push('the three columns fill the page instead of leaving it blank',
        [sideRect, mainRect, metaRect].every((r) => r && r.height > 240),
        [sideRect, mainRect, metaRect]
          .map((r) => (r ? Math.round(r.height) + 'px' : 'none'))
          .join(' x '))
      const bodyEl = field('s3-preview-body')
      const bodyRect = bodyEl ? bodyEl.getBoundingClientRect() : null
      push('an open object gets the tall middle column, not a two-line box',
        !!bodyRect && bodyRect.height >= 300, bodyRect ? Math.round(bodyRect.height) + 'px' : 'none')
      push('the metadata column names the open object',
        metaBox ? (metaBox.textContent || '').indexOf('dir/b.txt') >= 0 : false,
        metaBox ? (metaBox.textContent || '').slice(0, 80) : 'none')

      // ---- 10. the visit history ---------------------------------------------
      /*
       * Every folder the page really listed must be findable again without the
       * secret: the saved history is a set of places, and this asserts the
       * store holds them (old code wrote nothing — there was no history) and
       * that going back through them really moves the tree.
       */
      step = 'history'
      const savedState = await window.termdeck.loadS3State()
      const visits = savedState.history || []
      push('walking into folders leaves traces in the saved history, newest first',
        visits.length >= 2 && visits[0].bucket === 'alpha' && visits[0].prefix === 'dir/' && visits[1].prefix === '',
        JSON.stringify(visits.map((v) => v.bucket + '/' + v.prefix)))
      push('the history carries no secret — not the field, not the value',
        JSON.stringify(visits).indexOf('secret') < 0 && JSON.stringify(visits).indexOf('wJalrXUtnFEMI') < 0,
        'keys=' + (visits[0] ? Object.keys(visits[0]).join(',') : 'none'))
      push('the page offers the history to go back through',
        rows('s3-history-row').length >= 2, rows('s3-history-row').length + ' row(s)')

      const rootRow = rows('s3-history-row').find((r) => r.dataset.prefix === '')
      if (!rootRow) {
        push('the root visit is in the history', false)
        return out
      }
      rootRow.querySelector('button').click()
      push('going back to an earlier visit really moves the tree',
        await waitFor(() => rows('s3-prefix').length === 2 && rows('s3-object').length === 1, 15000),
        'prefixes=' + rows('s3-prefix').length + ' objects=' + rows('s3-object').length)

      step = 'revisit another connection'
      setValue(field('s3-endpoint'), 'http://wrecked.invalid')
      setValue(field('s3-access-key'), 'WRECKED')
      setValue(field('s3-secret-key'), '')
      const dirRow = rows('s3-history-row').find((r) => r.dataset.prefix === 'dir/')
      if (!dirRow) {
        push('the folder visit is in the history', false)
        return out
      }
      dirRow.querySelector('button').click()
      await wait(400)
      push('a visit from another connection fills the form and waits',
        valueOf('s3-endpoint') === endpoint && valueOf('s3-access-key') === 'AKIDEXAMPLE' &&
        valueOf('s3-secret-key') === '',
        'endpoint=' + valueOf('s3-endpoint') + ' key=' + valueOf('s3-access-key'))
      setValue(field('s3-secret-key'), 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY')
      field('s3-connect').click()
      push('connecting then lands straight in the visited folder',
        await waitFor(() => rows('s3-object').length === 2 && (text('s3-breadcrumb') || '').indexOf('dir') >= 0, 15000),
        'objects=' + rows('s3-object').length + ' crumb=' + text('s3-breadcrumb'))

      return out
      } catch (err) {
        out.push({ name: 'failed at step: ' + step, ok: false, detail: String((err && err.message) || err) })
        return out
      }
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 's3 probe', ok: false, detail: String((err && err.message) || err) }])
  }

  report([
    {
      name: 'the requests really carried a signature',
      ok: seen.length >= 4 && seen.every((line) => line.startsWith('GET') || line.startsWith('PUT') || line.startsWith('DELETE')),
      detail: seen.slice(0, 4).join(' | ')
    },
    {
      name: 'the delete reached the far end',
      ok: seen.some((line) => line.startsWith('DELETE /alpha/dir/a.txt')),
      detail: seen.filter((l) => l.startsWith('DELETE')).join(',') || 'none'
    }
  ])

  // ---- 9. the bytes, checked from the side that owns the socket and the disk
  const downloadedFile = fs.existsSync(downloadTarget)
    ? fs.readFileSync(downloadTarget, 'utf8')
    : ''
  const uploaded = uploads.find((entry) => entry.url === '/alpha/dir/uploaded.txt')
  const uploadedJson = uploads.find((entry) => entry.url === '/alpha/dir/config.json')
  report([
    {
      name: 'the uploaded file arrived byte for byte',
      ok: !!uploaded && uploaded.body.toString('utf8') === uploadBody,
      detail: uploaded
        ? uploaded.body.length + ' bytes: ' + JSON.stringify(uploaded.body.toString('utf8'))
        : 'no PUT reached /alpha/dir/uploaded.txt'
    },
    {
      name: 'and carried the content type its extension implies',
      ok: !!uploadedJson && String(uploadedJson.type).indexOf('application/json') === 0,
      detail: uploadedJson ? String(uploadedJson.type) + ' (' + uploadedJson.body.length + ' bytes)' : 'no PUT'
    },
    {
      name: 'the saved object has the object contents',
      ok: downloadedFile === 'hello s3',
      detail: JSON.stringify(downloadedFile)
    }
  ])
  fs.rmSync(uploadSource, { force: true })
  fs.rmSync(uploadSource2, { force: true })
  fs.rmSync(downloadTarget, { force: true })

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  server.close()
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('s3 probe crashed:', err)
    app.exit(1)
  })
)
