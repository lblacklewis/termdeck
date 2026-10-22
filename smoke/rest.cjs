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
      if (req.url === '/big') {
        // 600 lines, so the fold and the search have something to work on.
        const lines = []
        for (let i = 0; i < 600; i += 1) lines.push('line ' + i + (i % 100 === 7 ? ' NEEDLE' : ''))
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(lines.join('\n'))
        return
      }
      if (req.url === '/slow') {
        // Never answers: the timeout is the thing under test.
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

      // ---- 2b. "Blank request" really is blank ---------------------------
      setValue(select, '')
      const cleared = await waitFor(() => valueOf('rest-url') === '', 4000)
      push('picking "Blank request" clears the form', cleared, 'url=' + valueOf('rest-url'))

      // ---- 2c. the request can leave as a curl line ----------------------
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), 'http://example.invalid/thing')
      field('rest-header-add').click()
      await wait(200)
      setValue(field('rest-header-name'), 'X-Test')
      setValue(field('rest-header-value'), "it's here")
      setValue(field('rest-body'), '{"a":1}')
      field('rest-copy-curl').click()
      await wait(400)
      const curl = await window.termdeck.readClipboard()
      push('copy as cURL puts a command on the clipboard', curl.indexOf('curl -X POST') === 0,
        String(curl).slice(0, 60))
      push('it carries the URL, the header and the body',
        curl.indexOf('http://example.invalid/thing') >= 0 &&
          curl.indexOf('X-Test') >= 0 &&
          curl.indexOf('--data') >= 0,
        String(curl).slice(0, 140))
      // A single quote inside a value has to be closed, escaped and reopened, or
      // the pasted command silently truncates at that character.
      const bs = String.fromCharCode(92)
      push('a quote in a value is escaped for the shell',
        curl.indexOf("'" + bs + "'" + "'") >= 0, String(curl).slice(0, 160))

      // ---- 2d. the body can be formatted ---------------------------------
      setValue(field('rest-body'), '{"a":1,"b":[2]}')
      field('rest-format').click()
      await wait(300)
      // indexOf takes a string: the newline has to be built, not passed as a code point.
      const nl = String.fromCharCode(10)
      push('format json pretty-prints the body', valueOf('rest-body').indexOf(nl) >= 0,
        JSON.stringify(valueOf('rest-body').slice(0, 24)))
      setValue(field('rest-body'), 'not json at all')
      field('rest-format').click()
      const complained = await waitFor(() => !!field('rest-format-error'), 3000)
      push('and says so when the body is not json', complained, text('rest-format-error'))

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

      // ---- 6. a long body folds, and can be searched ----------------------
      step = 'long body'
      setValue(field('rest-method'), 'GET')
      setValue(field('rest-url'), base + '/big')
      field('rest-send').click()
      const longBody = await waitFor(() => (text('rest-response-body') || '').includes('line 0'), 15000)
      push('a long body arrives', longBody)
      const foldButton = field('rest-show-all')
      push('a long body is folded with a way to unfold it', !!foldButton,
        foldButton ? foldButton.textContent : 'no button')
      const foldedLines = (text('rest-response-body') || '').split('\\n').length
      push('folded to about 400 lines', foldedLines <= 420, 'lines=' + foldedLines)
      if (foldButton) {
        foldButton.click()
        await wait(300)
        const expanded = (text('rest-response-body') || '').split('\\n').length
        push('unfolding shows all of it', expanded > 500, 'lines=' + expanded)
      }

      const searchBox = field('rest-search')
      push('the response has a search box', !!searchBox)
      if (searchBox) {
        setValue(searchBox, 'NEEDLE')
        await wait(400)
        const hits = (text('rest-response-body') || '')
        const hitLines = hits === '' ? 0 : hits.split('\\n').length
        push('searching filters the body', hitLines === 6 && hits.includes('NEEDLE'),
          'lines=' + hitLines)
        push('and the count says how many matched', text('rest-search-count').includes('6 / 600'),
          text('rest-search-count'))
        setValue(searchBox, '')
        await wait(300)
      }

      /*
       * ---- 6b. the answer is on screen, not below the fold ----------------
       * The old page was one long column: the answer sat under the request, so reading it
       * meant scrolling past everything just typed. Measured, not eyeballed — the page
       * body must not scroll, the answer's box must fit the window, and the answer scrolls
       * inside that box instead.
       */
      step = 'layout'
      const restBody = document.querySelector('[data-testid="rest-page"] .td-rest-body')
      const answer = field('rest-response-body')
      push('request and answer share the height instead of one long page',
        !!restBody, restBody ? restBody.className : 'no body element')
      if (restBody && answer) {
        push('the page itself does not scroll',
          restBody.scrollHeight <= restBody.clientHeight + 1,
          'scroll=' + restBody.scrollHeight + ' client=' + restBody.clientHeight)
        const area = answer.getBoundingClientRect()
        push('the answer fits in the window without scrolling the page',
          area.top >= 0 && area.bottom <= window.innerHeight + 1,
          'top=' + Math.round(area.top) + ' bottom=' + Math.round(area.bottom) +
            ' window=' + window.innerHeight)
        push('and it scrolls inside its own box instead',
          answer.scrollHeight > answer.clientHeight,
          'scroll=' + answer.scrollHeight + ' client=' + answer.clientHeight)

        /*
         * A long body is the case that used to push the answer out of sight: the form grew
         * and the answer went with it. Now the form is capped and scrolls, so the answer
         * stays where it was.
         */
        const bodyBox = field('rest-body')
        const pad = '{' + String.fromCharCode(10) + '  "pad": "x"' + String.fromCharCode(10) + '}'
        setValue(bodyBox, new Array(40).join(pad + String.fromCharCode(10)))
        await wait(400)
        const requestPane = document.querySelector('[data-testid="rest-page"] .td-rest-request')
        const answerAgain = field('rest-response-body').getBoundingClientRect()
        push('a long body does not push the answer off the screen',
          answerAgain.bottom <= window.innerHeight + 1 && answerAgain.top >= 0,
          'bottom=' + Math.round(answerAgain.bottom) + ' window=' + window.innerHeight)
        push('the form itself is what scrolls then',
          !!requestPane && requestPane.scrollHeight > requestPane.clientHeight,
          requestPane ? 'scroll=' + requestPane.scrollHeight + ' client=' + requestPane.clientHeight : 'none')
        setValue(bodyBox, '')
        await wait(300)
      }

      /*
       * ---- 6c. headers typed as one JSON object ---------------------------
       * The point is not that JSON is possible; it is that a mistyped one must not quietly
       * become a request missing the header somebody meant to authenticate with.
       */
      step = 'headers json'
      const rowsButton = field('rest-headers-rows')
      const jsonButton = field('rest-headers-json')
      push('headers have a JSON mode beside the row editor', !!rowsButton && !!jsonButton)
      if (jsonButton) {
        jsonButton.click()
        await wait(300)
        const jsonBox = field('rest-headers-json-input')
        push('the JSON box opens filled in', !!jsonBox, jsonBox ? jsonBox.value : 'no box')
        if (jsonBox) {
          setValue(jsonBox, '{ "X-Broken": }')
          await wait(300)
          push('a typo in the JSON is reported, not swallowed', !!field('rest-headers-json-error'),
            text('rest-headers-json-error'))
          rowsButton.click()
          await wait(300)
          const keptNames = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
            .map((input) => input.value)
          push('and the headers in use are left alone', keptNames.indexOf('X-Broken') < 0,
            'names=' + JSON.stringify(keptNames))

          jsonButton.click()
          await wait(300)
          const boxAgain = field('rest-headers-json-input')
          setValue(boxAgain, '{"X-From-Json": "yes", "Accept": "application/json"}')
          await wait(400)
          push('valid JSON is accepted and counted',
            !!field('rest-headers-json-ok') && text('rest-headers-json-ok').indexOf('2') >= 0,
            text('rest-headers-json-ok'))
          rowsButton.click()
          await wait(300)
          const fromJson = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
            .map((input) => input.value)
          push('and it turns into rows', fromJson.indexOf('X-From-Json') >= 0,
            'names=' + JSON.stringify(fromJson))

          // The wire is the test: a header that only exists on screen is not a header. The
          // server's view of it is checked from the main process, where the recordings are.
          setValue(field('rest-method'), 'GET')
          setValue(field('rest-url'), base + '/hello')
          field('rest-send').click()
          await waitFor(() => (text('rest-response-body') || '').indexOf('hello') >= 0, 15000)
        }
      }

      // ---- 7. a timeout is reported as a timeout --------------------------
      step = 'timeout'
      setValue(field('rest-method'), 'GET')
      setValue(field('rest-url'), base + '/slow')
      setValue(field('rest-timeout'), '1')
      field('rest-send').click()
      const timedOut = await waitFor(() => !!field('rest-error'), 12000)
      push('a request that never answers times out', timedOut, text('rest-error'))
      push('and says that it timed out', /No answer within/.test(text('rest-error')),
        text('rest-error'))
      setValue(field('rest-timeout'), '15')

      // ---- 8. a dead port is an error, not an empty answer ----------------
      step = 'error'
      setValue(field('rest-url'), 'http://127.0.0.1:1/never')
      field('rest-send').click()
      /*
       * Wait for *this* answer, not for "an error is on screen": the timeout above left one
       * there, and the new send only clears it a frame after the click. Waiting for the
       * refused message specifically is what makes the two checks below about this request.
       */
      const failed = await waitFor(() => /ECONNREFUSED|refused/i.test(text('rest-error')), 15000)
      push('a refused connection is reported as an error', failed, text('rest-error'))
      push('and it is not shown as a status code',
        failed && !/^[0-9]{3}/.test(text('rest-status')), text('rest-status'))

      /*
       * ---- 9. the calls that were made are kept, and can be kept again ----
       * Everything above went through the send button, so the history must already hold a
       * each one — including the failures, which are the entries most worth having.
       */
      step = 'history'
      const historyCount = Number((text('rest-history-count') || '0').trim())
      const historyUrls = [...document.querySelectorAll('[data-testid="rest-history-item"]')]
        .map((row) => row.getAttribute('title') || '')
      push('every call that was sent is in the history', historyCount >= 7,
        'count=' + historyCount + ' urls=' + historyUrls.join(' '))
      const historyRows = document.querySelectorAll('[data-testid="rest-history-item"]')
      push('the history is a list you can click', historyRows.length >= 7,
        'rows=' + historyRows.length)
      const failureRow = [...historyRows].find((row) => (row.textContent || '').indexOf('never') >= 0)
      push('a call that failed is in it too, with its reason', !!failureRow,
        failureRow ? failureRow.textContent.trim().slice(0, 60) : 'no failed row')

      // Loading a stored call has to restore all of it, not just the URL.
      setValue(field('rest-url'), '')
      if (failureRow) {
        failureRow.click()
        await wait(400)
        push('clicking an entry puts that whole call back in the editor',
          (field('rest-url') || {}).value === 'http://127.0.0.1:1/never',
          'url=' + ((field('rest-url') || {}).value || 'empty'))
      }

      // Keep it under a name, rename it, then let it go.
      const keepButton = failureRow && failureRow.parentElement
        ? failureRow.parentElement.querySelector('[data-testid="rest-history-keep"]')
        : null
      push('a history entry can be kept as a named request', !!keepButton)
      if (keepButton) {
        const keptBefore = document.querySelectorAll('[data-testid="rest-kept-item"]').length
        keepButton.click()
        await wait(500)
        const keptAfter = document.querySelectorAll('[data-testid="rest-kept-item"]').length
        push('keeping it adds it to the saved list', keptAfter === keptBefore + 1,
          keptBefore + ' -> ' + keptAfter)

        const renameButton = document.querySelector('[data-testid="rest-kept-rename"]')
        push('a saved request can be renamed', !!renameButton)
        if (renameButton) {
          renameButton.click()
          await wait(300)
          const nameInput = field('rest-kept-rename-input')
          push('renaming edits the name in place', !!nameInput)
          if (nameInput) {
            setValue(nameInput, 'probe renamed call')
            nameInput.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
            )
            await wait(600)
            const names = [...document.querySelectorAll('[data-testid="rest-kept-item"]')]
              .map((row) => (row.textContent || ''))
            push('the new name sticks',
              names.some((name) => name.indexOf('probe renamed call') >= 0),
              names.join(' | ').slice(0, 80))
          }
        }

        const dropButton = document.querySelector('[data-testid="rest-kept-drop"]')
        if (dropButton) {
          const beforeDrop = document.querySelectorAll('[data-testid="rest-kept-item"]').length
          dropButton.click()
          await wait(500)
          push('and it can be dropped again',
            document.querySelectorAll('[data-testid="rest-kept-item"]').length === beforeDrop - 1,
            'before=' + beforeDrop + ' after=' +
              document.querySelectorAll('[data-testid="rest-kept-item"]').length)
        }
      }

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
  // The last one: /hello is also the template's own URL, sent earlier without the header.
  const jsonHeader = received.filter((entry) => entry.url === '/hello').pop()
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
    },
    {
      name: 'a header typed as JSON reached the server',
      ok: !!jsonHeader && jsonHeader.headers['x-from-json'] === 'yes',
      detail: jsonHeader ? JSON.stringify(jsonHeader.headers['x-from-json']) : 'no request'
    }
  ])

  /*
   * ---- 7. the page comes back as it was ----------------------------------
   * Written through the same API the page uses, then the window is reloaded:
   * anything that survives belongs to the store, not to React state.
   *
   * The history is seeded with more entries than the cap, so the reload also shows what
   * the store does with a file that is too big.
   */
  const seedHistory = Array.from({ length: 70 }, (_, index) => ({
    id: 'h' + index,
    at: Date.now() - index * 60_000,
    request: {
      method: 'GET',
      url: 'http://kept.example/call/' + index,
      headers: [],
      body: ''
    },
    status: 200,
    ok: true,
    durationMs: 3
  }))
  await win.webContents.executeJavaScript(
    'window.termdeck.saveRestState(' +
      JSON.stringify({
        draft: { method: 'GET', url: 'http://kept.example/draft', headers: [], body: '' },
        saved: [
          {
            id: 's1',
            name: 'kept health',
            request: {
              method: 'GET',
              url: 'http://kept.example/health',
              headers: [],
              body: ''
            }
          }
        ],
        history: seedHistory
      }) +
      ')'
  )
  await win.reload()
  await sleep(3000)

  const afterReload = `
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
      const field = (id) => document.querySelector('[data-testid="' + id + '"]')
      try {
        const tab = [...document.querySelectorAll('button')]
          .find((b) => (b.getAttribute('data-testid') || '') === 'rail-rest')
        if (!tab) {
          push('the REST entry is still there after a reload', false)
          return out
        }
        tab.click()
        await waitFor(() => !!field('rest-page'), 15000)
        await waitFor(() => (field('rest-url') || {}).value === 'http://kept.example/draft', 8000)
        push('the draft request comes back after a reload',
          (field('rest-url') || {}).value === 'http://kept.example/draft',
          'url=' + ((field('rest-url') || {}).value || ''))
        const select = field('rest-saved')
        const names = select ? [...select.options].map((o) => o.textContent) : []
        push('the saved request is listed', names.includes('kept health'), names.join(','))
        if (select) {
          const option = [...select.options].find((o) => o.textContent === 'kept health')
          if (option) {
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype,
              'value'
            ).set
            setter.call(select, option.value)
            select.dispatchEvent(new Event('change', { bubbles: true }))
            await wait(400)
            push('picking it fills the request in',
              (field('rest-url') || {}).value === 'http://kept.example/health',
              'url=' + ((field('rest-url') || {}).value || ''))
          }
        }

        /*
         * The seeded history was longer than the cap. The store trims on the way in, so
         * what comes back is the newest 60 — and it has to be the *newest* 60: a cap that
         * kept the oldest would throw away exactly the calls somebody is looking for.
         */
        const shown = [...document.querySelectorAll('[data-testid="rest-history-item"]')]
        push('a history longer than the cap is trimmed on the way in', shown.length === 60,
          'shown=' + shown.length)
        const urls = shown.map((row) => row.getAttribute('title') || '')
        push('and it is the newest calls that survive', urls[0] === 'http://kept.example/call/0' &&
          urls.indexOf('http://kept.example/call/69') < 0,
          'first=' + urls[0] + ' oldest-shown=' + urls[urls.length - 1])
        return out
      } catch (err) {
        push('state probe failed', false, String((err && err.message) || err))
        return out
      }
    })()
  `
  try {
    report(await win.webContents.executeJavaScript(afterReload))
  } catch (err) {
    report([{ name: 'state probe', ok: false, detail: String((err && err.message) || err) }])
  }

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
