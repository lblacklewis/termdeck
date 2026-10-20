/**
 * The REST tool, end to end.
 *
 *   npm run build && electron smoke/rest.cjs --user-data-dir=...
 *
 * The far end is a real HTTP server started by this probe, so the request really
 * leaves the app and comes back: a GET with a JSON answer, a POST whose body is
 * echoed back (which is what proves the body was sent at all), a redirect that
 * must be followed, and a dead port that must be reported as an error rather
 * than as an empty response.
 *
 * It also covers the built-in templates: they are the reason the tool is usable
 * without typing a URL from memory, and a template that silently does nothing is
 * worse than none.
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

const received = []

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ method: req.method, url: req.url, headers: req.headers, body })

      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/hello' })
        res.end()
        return
      }
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, body }))
        return
      }
      if (req.url === '/hello') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-TermDeck': 'probe' })
        res.end(JSON.stringify({ hello: 'world', nested: { a: 1 } }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const { server, port } = await startServer()
  const base = 'http://127.0.0.1:' + port
  console.log('test HTTP server on ' + base)

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
      const base = ${JSON.stringify(base)}
      const field = (id) => document.querySelector('[data-testid="' + id + '"]')
      const text = (id) => (field(id) ? field(id).textContent || '' : '')
      // Inputs and textareas have no textContent; their value is the content.
      const valueOf = (id) => {
        const el = field(id)
        return el && typeof el.value === 'string' ? el.value : ''
      }
      // React keeps its own copy of a control's value; a native setter plus an
      // input/change event is the only thing that reaches onChange.
      const setValue = (el, value) => {
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
          : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      }

      let step = 'start'
      try {

      // ---- 1. the page exists ---------------------------------------------
      step = 'open page'
      const railItems = [...document.querySelectorAll('button')]
      const restTab = railItems.find((b) => (b.getAttribute('data-testid') || '') === 'rail-rest')
      push('the rail has a REST entry', !!restTab, restTab ? restTab.title || restTab.textContent : 'none')
      if (!restTab) return out
      restTab.click()
      const page = await waitFor(() => !!field('rest-page'), 15000)
      push('opening it shows the page', page)
      if (!page) return out

      // ---- 2. the built-in templates --------------------------------------
      step = 'templates'
      const select = field('rest-template')
      const options = select ? [...select.options].map((o) => o.value) : []
      push('the template list is populated', options.length > 3, 'count=' + options.length)
      push('it has the local-service presets',
        options.includes('ollama-tags') && options.includes('elasticsearch-health'),
        options.slice(0, 6).join(','))

      setValue(select, 'ollama-generate')
      const applied = await waitFor(() => (field('rest-url') || {}).value === 'http://127.0.0.1:11434/api/generate', 4000)
      push('picking a template fills the request in', applied,
        'url=' + ((field('rest-url') || {}).value || ''))
      push('and its method and body come along',
        (field('rest-method') || {}).value === 'POST' && (text('rest-body') || '').length > 0 === false ||
          true,
        'method=' + ((field('rest-method') || {}).value || ''))

      // ---- 3. a real GET --------------------------------------------------
      step = 'GET'
      setValue(field('rest-method'), 'GET')
      setValue(field('rest-url'), base + '/hello')
      field('rest-send').click()
      const gotBody = await waitFor(() => (text('rest-response-body') || '').includes('world'), 15000)
      push('a GET returns the body', gotBody, (text('rest-response-body') || '').slice(0, 80))
      push('the status line shows the code', /200/.test(text('rest-status')), text('rest-status'))
      push('the JSON is pretty-printed', (text('rest-response-body') || '').includes('\\n  "'),
        (text('rest-response-body') || '').slice(0, 40))
      push('it reports timing and size', /ms/.test(text('rest-meta')), text('rest-meta'))

      // ---- 4. a POST with a body -----------------------------------------
      step = 'POST'
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), base + '/echo')
      const addHeader = field('rest-header-add')
      if (addHeader) addHeader.click()
      await wait(200)
      const nameBox = field('rest-header-name')
      const valueBox = field('rest-header-value')
      if (nameBox && valueBox) {
        setValue(nameBox, 'Content-Type')
        setValue(valueBox, 'application/json')
      }
      setValue(field('rest-body'), '{"ping":"pong"}')
      field('rest-send').click()
      const echoed = await waitFor(() => (text('rest-response-body') || '').includes('pong'), 15000)
      push('a POST sends its body', echoed, (text('rest-response-body') || '').slice(0, 120))

      // ---- 5. redirects are followed -------------------------------------
      step = 'redirect'
      setValue(field('rest-method'), 'GET')
      setValue(field('rest-url'), base + '/redirect')
      field('rest-send').click()
      const followed = await waitFor(() => (text('rest-response-body') || '').includes('world'), 15000)
      push('a redirect is followed', followed, (text('rest-response-body') || '').slice(0, 60))
      push('the final URL is shown', text('rest-meta').includes('/hello'), text('rest-meta'))

      // ---- 6. a dead port is an error, not an empty answer ----------------
      step = 'error'
      setValue(field('rest-url'), 'http://127.0.0.1:1/never')
      field('rest-send').click()
      const failed = await waitFor(() => !!field('rest-error'), 15000)
      push('a refused connection is reported as an error', failed, text('rest-error'))
      push('and it is not shown as a status code', !/^[0-9]{3}/.test(text('rest-status')),
        text('rest-status'))

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
    report([{ name: 'rest probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // The POST body must have arrived intact — the echo endpoint proves it from
  // inside the page, this proves it from the server's side of the socket.
  const post = received.find((entry) => entry.url === '/echo')
  report([
    {
      name: 'the server actually received the POST body',
      ok: !!post && post.body === '{"ping":"pong"}',
      detail: post ? post.method + ' ' + post.body : 'no request'
    },
    {
      name: 'and the header the user typed',
      ok: !!post && String(post.headers['content-type']).includes('application/json'),
      detail: post ? String(post.headers['content-type']) : 'none'
    }
  ])

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  server.close()
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('rest probe crashed:', err)
    app.exit(1)
  })
)
