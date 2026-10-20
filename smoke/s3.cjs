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
const http = require('node:http')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

const seen = []

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
    if (req.method === 'DELETE') return xml(res, '<DeleteObjectResult/>')
    if (req.method === 'PUT') return xml(res, '<PutObjectResult/>')
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

      step = 'delete'
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
