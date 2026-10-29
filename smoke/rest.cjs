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
      if (req.url === '/cookie') {
        // Two cookies in one answer: the case that shows why the header list is kept
        // one row per header rather than as a joined value.
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Path=/; Max-Age=3600']
        })
        res.end(JSON.stringify({ ok: true }))
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

  /*
   * ---- 0. 请求头的解析规则（纯函数） --------------------------------------
   * 用户报的是两件事，其中一件在这里：从控制台 / Python 复制出来的对象字面量是
   * 单引号的（{'Content-Type': 'application/json'}），它不是 JSON —— 但它是人们
   * 真正粘进来的形状。规则放宽到读得懂它，同时真正的笔误必须继续报错（变成一条
   * 少了的认证头是最危险的失败方式）。用注入的文本逐条断言，不靠点界面。
   */
  try {
    const { buildSync } = require('esbuild')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rest-headers-'))
    const entry = path.join(dir, 'entry.ts')
    const modulePath = path.join(ROOT, 'src', 'shared', 'restHeaders.ts').split(path.sep).join('/')
    fs.writeFileSync(entry, 'export * from ' + JSON.stringify(modulePath), 'utf8')
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(dir, 'restHeaders.cjs'),
      logLevel: 'silent'
    })
    const rules = require(path.join(dir, 'restHeaders.cjs'))
    const NL = String.fromCharCode(10)
    const shape = (result) =>
      result.ok
        ? result.headers.map((h) => h.name + '=' + h.value).join(',')
        : 'ERR:' + result.problem.code
    const single = rules.parseHeadersJson("{'Content-Type': 'application/json'}")
    const mixed = rules.parseHeadersJson("{\"Accept\": 'application/json'}")
    const apostrophe = rules.parseHeadersJson("{\"note\": \"it's fine\"}")
    const escaped = rules.parseHeadersJson("{'note': 'it\\'s'}")
    const innerDouble = rules.parseHeadersJson("{'X-Q': 'say \"hi\"'}")
    const singleArray = rules.parseHeadersJson("['A: 1', 'B: 2']")
    const typo = rules.parseHeadersJson("{ 'X-Broken': }")
    const lines = rules.parseHeadersJson('X-A: 1' + NL + 'X-B: 2')
    const untouched = rules.requoteSingleQuoted('{"a": 1}')
    const jsonOf = rules.headersJsonOf([
      { name: 'A', value: '1' },
      { name: '', value: 'ignored' }
    ])
    report([
      {
        name: 'a single-quoted object literal is read as headers',
        ok: single.ok && single.headers.length === 1 &&
          single.headers[0].name === 'Content-Type' &&
          single.headers[0].value === 'application/json',
        detail: shape(single)
      },
      {
        name: 'one quote style on each side is fine too',
        ok: mixed.ok && mixed.headers[0].name === 'Accept',
        detail: shape(mixed)
      },
      {
        name: 'an apostrophe inside a double-quoted value is left alone',
        ok: apostrophe.ok && apostrophe.headers[0].value === "it's fine",
        detail: shape(apostrophe)
      },
      {
        name: 'an escaped single quote inside a single-quoted value survives',
        ok: escaped.ok && escaped.headers[0].value === "it's",
        detail: shape(escaped)
      },
      {
        name: 'a double quote inside a single-quoted value is carried, not truncated',
        ok: innerDouble.ok && innerDouble.headers[0].value === 'say "hi"',
        detail: shape(innerDouble)
      },
      {
        name: 'a single-quoted array of lines reads like the double-quoted one',
        ok: singleArray.ok && singleArray.headers.length === 2,
        detail: shape(singleArray)
      },
      {
        name: 'a real typo is still refused, not read as a header name',
        ok: !typo.ok && typo.problem.code === 'not-json',
        detail: shape(typo)
      },
      {
        name: 'the line-based shape still works',
        ok: lines.ok && lines.headers.length === 2,
        detail: shape(lines)
      },
      {
        name: 'text that is already JSON is not rewritten',
        ok: untouched === '{"a": 1}',
        detail: untouched
      },
      {
        name: 'the JSON box form drops nameless rows and is stable',
        ok: jsonOf === '{' + NL + '  "A": "1"' + NL + '}',
        detail: JSON.stringify(jsonOf)
      }
    ])
    const layoutPath = path.join(ROOT, 'src', 'shared', 'restLayout.ts').split(path.sep).join('/')
    const layoutEntry = path.join(dir, 'layout.ts')
    fs.writeFileSync(layoutEntry, 'export * from ' + JSON.stringify(layoutPath), 'utf8')
    buildSync({
      entryPoints: [layoutEntry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(dir, 'restLayout.cjs'),
      logLevel: 'silent'
    })
    const sized = require(path.join(dir, 'restLayout.cjs'))
    report([
      {
        name: 'a dragged height is kept as it is',
        ok: sized.clampRestBodyHeight(320) === 320,
        detail: String(sized.clampRestBodyHeight(320))
      },
      {
        name: 'a drag that went nowhere is clamped up to a usable box',
        ok: sized.clampRestBodyHeight(10) === 80,
        detail: String(sized.clampRestBodyHeight(10))
      },
      {
        name: 'a height that would eat the answer pane is clamped down',
        ok: sized.clampRestBodyHeight(5000) === 900,
        detail: String(sized.clampRestBodyHeight(5000))
      },
      {
        name: 'a number written as text by a hand-edited file still reads',
        ok: sized.clampRestBodyHeight('420') === 420,
        detail: String(sized.clampRestBodyHeight('420'))
      },
      {
        name: 'nonsense reads as "never resized" rather than as a size',
        ok: sized.clampRestBodyHeight('abc') === undefined &&
          sized.clampRestBodyHeight(0) === undefined &&
          sized.clampRestBodyHeight(-5) === undefined &&
          sized.clampRestBodyHeight(null) === undefined,
        detail: 'abc / 0 / -5 / null'
      },
      {
        name: 'the bounds can be injected',
        ok: sized.clampRestBodyHeight(50, { min: 100, max: 200 }) === 100 &&
          sized.clampRestBodyHeight(500, { min: 100, max: 200 }) === 200,
        detail: '50 -> 100, 500 -> 200'
      }
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    report([{ name: '请求头规则模块没能打包', ok: false, detail: String((err && err.message) || err) }])
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
      /*
       * The request editor is in tabs now (parameters, headers, body, auth), so anything
       * below that touches a control inside one of them has to open it first.
       */
      const openTab = async (id) => {
        const button = field('rest-tab-' + id)
        if (!button) return false
        button.click()
        await wait(300)
        return true
      }
      const treeItems = () => [...document.querySelectorAll('[data-testid="rest-tree-item"]')]
      const itemNamed = (name) =>
        treeItems().find((row) => (row.textContent || '').indexOf(name) >= 0)
      const openNamed = async (name) => {
        const row = itemNamed(name)
        if (!row) return false
        const open = row.querySelector('[data-testid="rest-tree-open"]')
        if (!open) return false
        open.click()
        await wait(400)
        return true
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
      const templateMethod = (field('rest-method') || {}).value
      await openTab('body')
      const templateBody = valueOf('rest-body')
      push('and its method and body come along',
        templateMethod === 'POST' && templateBody.length > 0,
        'method=' + templateMethod + ' body=' + JSON.stringify(templateBody.slice(0, 40)))

      // ---- 2b. "Blank request" really is blank ---------------------------
      setValue(select, '')
      const cleared = await waitFor(() => valueOf('rest-url') === '', 4000)
      push('picking "Blank request" clears the form', cleared, 'url=' + valueOf('rest-url'))

      // ---- 2c. the request can leave as a curl line ----------------------
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), 'http://example.invalid/thing')
      await openTab('headers')
      field('rest-header-add').click()
      await wait(200)
      setValue(field('rest-header-name'), 'X-Test')
      setValue(field('rest-header-value'), "it's here")
      await openTab('body')
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
      await openTab('body')
      setValue(field('rest-body'), '{"a":1,"b":[2]}')
      field('rest-format').click()
      await wait(300)
      // indexOf takes a string: the newline has to be built, not passed as a code point.
      const nl = String.fromCharCode(10)
      push('format json pretty-prints the body', valueOf('rest-body').indexOf(nl) >= 0,
        JSON.stringify(valueOf('rest-body').slice(0, 24)))
      /*
       * Format is a JSON affordance, so it is only offered in JSON mode. Typing a body
       * that is not JSON switches the mode automatically — so the mode is set back to
       * JSON here, which is exactly the path someone takes to pretty-print text that
       * turns out not to parse.
       */
      setValue(field('rest-body'), 'not json at all')
      const modeJson = field('rest-body-mode-json')
      push('the body mode is offered as tabs', !!modeJson && !!field('rest-body-mode-form'))
      if (modeJson) modeJson.click()
      await wait(250)
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

      /*
       * ---- 3b. 参数表与 URL 是同一件事的两个视图 --------------------------
       * 往 URL 里敲查询串要填进表里；改表要改写 URL；关掉一行只是"这次不发"，不能把行
       * 删掉 —— 这三条合起来才是"双向同步"，少一条都会让人以为自己改丢了东西。
       */
      step = 'params'
      push('the request has a parameters tab', await openTab('params'))
      setValue(field('rest-url'), base + '/hello?a=1&b=two')
      await wait(400)
      const paramNames = () =>
        [...document.querySelectorAll('[data-testid="rest-param-name"]')].map((input) => input.value)
      const paramValues = () =>
        [...document.querySelectorAll('[data-testid="rest-param-value"]')].map((input) => input.value)
      push('a query typed into the URL fills the table',
        paramNames().join(',') === 'a,b' && paramValues().join(',') === '1,two',
        'names=' + JSON.stringify(paramNames()) + ' values=' + JSON.stringify(paramValues()))
      const paramValueBoxes = [...document.querySelectorAll('[data-testid="rest-param-value"]')]
      if (paramValueBoxes[0]) setValue(paramValueBoxes[0], '9')
      await wait(300)
      push('editing a row rewrites the URL',
        valueOf('rest-url') === base + '/hello?a=9&b=two', 'url=' + valueOf('rest-url'))
      const paramEnabled = [...document.querySelectorAll('[data-testid="rest-param-enabled"]')]
      if (paramEnabled[1]) paramEnabled[1].click()
      await wait(300)
      push('switching a row off takes it out of the URL, not out of the table',
        valueOf('rest-url') === base + '/hello?a=9' && paramNames().length === 2,
        'url=' + valueOf('rest-url') + ' rows=' + paramNames().length)
      if (paramEnabled[1]) paramEnabled[1].click()
      await wait(250)
      field('rest-param-add').click()
      await wait(300)
      // The empty line has to still be there: a blank row is data being typed, not junk.
      push('adding a parameter adds an empty line to type into',
        paramNames().length === 3, 'rows=' + paramNames().length)
      const addedName = [...document.querySelectorAll('[data-testid="rest-param-name"]')].pop()
      const addedValue = [...document.querySelectorAll('[data-testid="rest-param-value"]')].pop()
      if (addedName && addedValue) {
        setValue(addedName, 'c')
        setValue(addedValue, 'three')
      }
      await wait(400)
      push('a row added by hand lands in the URL too',
        valueOf('rest-url').indexOf('c=three') >= 0, 'url=' + valueOf('rest-url'))
      // The wire is the test: a parameter table that only exists on screen is not a query.
      setValue(field('rest-url'), base + '/hello?probe=param')
      await wait(400)
      field('rest-send').click()
      await waitFor(() => (text('rest-response-body') || '').indexOf('world') >= 0, 15000)

      // ---- 4. a POST with a body -----------------------------------------
      step = 'POST'
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), base + '/echo')
      await openTab('headers')
      const addHeader = field('rest-header-add')
      if (addHeader) addHeader.click()
      await wait(200)
      const nameBox = field('rest-header-name')
      const valueBox = field('rest-header-value')
      if (nameBox && valueBox) {
        setValue(nameBox, 'Content-Type')
        setValue(valueBox, 'application/json')
      }
      await openTab('body')
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
      push('the final URL is shown', text('rest-final-url').includes('/hello'), text('rest-final-url'))

      /*
       * ---- 5b. 响应分页：正文 / 响应头 / Cookie --------------------------
       * 一次响应可以带多个 set-cookie，而 Node 自己会把重复的头用逗号拼成一条 —— 拼接
       * 之后 Expires 里的逗号会让 Cookie 解析出鬼来，所以这里断言两条 cookie 各自成行。
       */
      step = 'response tabs'
      setValue(field('rest-method'), 'GET')
      setValue(field('rest-url'), base + '/cookie')
      field('rest-send').click()
      await waitFor(() => (text('rest-response-body') || '').indexOf('ok') >= 0, 15000)
      const headersTab = field('rest-response-tab-headers')
      const cookiesTab = field('rest-response-tab-cookies')
      push('the answer has headers and cookies tabs', !!headersTab && !!cookiesTab)
      if (headersTab) {
        headersTab.click()
        await wait(350)
        const headerText = text('rest-response-headers')
        push('the headers tab lists the response headers',
          headerText.toLowerCase().indexOf('content-type') >= 0, headerText.slice(0, 70))
        const cookieHeaders = headerText.match(/set-cookie/gi) || []
        push('both set-cookie headers are kept apart, not joined by a comma',
          cookieHeaders.length === 2, 'count=' + cookieHeaders.length)
      }
      if (cookiesTab) {
        cookiesTab.click()
        await wait(350)
        const cookieRows = [...document.querySelectorAll('[data-testid="rest-cookie-row"]')]
        const cookieNames = cookieRows.map((row) => {
          const name = row.querySelector('[data-testid="rest-cookie-name"]')
          return name ? name.textContent : ''
        })
        push('the cookies tab lists each cookie with its own value',
          cookieRows.length === 2 && cookieNames.join(',') === 'sid,theme',
          'rows=' + cookieRows.length + ' names=' + cookieNames.join(','))
        const attrs = cookieRows.length
          ? ((cookieRows[0].querySelector('[data-testid="rest-cookie-attrs"]') || {}).textContent || '')
          : ''
        push('and their attributes', attrs.indexOf('Path=/') >= 0 && attrs.indexOf('HttpOnly') >= 0, attrs)
      }
      const backToBody = field('rest-response-tab-body')
      if (backToBody) {
        backToBody.click()
        await wait(300)
      }

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
        // Locale-agnostic: the count is checked for its numbers, not for its wording.
        const countText = text('rest-search-count')
        push('and the count says how many matched',
          countText.indexOf('6') >= 0 && countText.indexOf('600') >= 0, countText)
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
        /*
         * Where the overflow goes is the box's business: the body editor has its own
         * scrollbar, so a long body may never make the form taller at all. What must not
         * happen is the answer leaving the screen (asserted just above); this checks that
         * *something* absorbed the text rather than it being clipped.
         */
        const formScrolls = !!requestPane && requestPane.scrollHeight > requestPane.clientHeight
        const boxScrolls = bodyBox.scrollHeight > bodyBox.clientHeight
        push('and the overflow is scrolled rather than clipped',
          formScrolls || boxScrolls,
          'form=' + (requestPane ? requestPane.scrollHeight + '/' + requestPane.clientHeight : 'none') +
            ' box=' + bodyBox.scrollHeight + '/' + bodyBox.clientHeight)
        setValue(bodyBox, '')
        await wait(300)
      }

      /*
       * ---- 6c. headers typed as one JSON object ---------------------------
       * The point is not that JSON is possible; it is that a mistyped one must not quietly
       * become a request missing the header somebody meant to authenticate with.
       */
      step = 'headers json'
      await openTab('headers')
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

          /*
           * ---- 6d. 两个页签之间带着数据切换 --------------------------------
           * 用户原话："逐条 或者 json 页签切换的时候 带着数据切换，现在是切换之后之前
           * 写的就没有了"。这里三件事：单引号粘进来的能被读懂；行里改的切到 JSON 能看
           * 见；还没解析成功的文本（唯一的一份）切走再切回来必须还在。
           */
          step = 'header tabs'
          jsonButton.click()
          await wait(350)
          setValue(field('rest-headers-json-input'), "{'X-Single': 'quoted'}")
          await wait(400)
          const singleRead = !!field('rest-headers-json-ok') && !field('rest-headers-json-error')
          push('a single-quoted paste is read, not refused as "not JSON"', singleRead,
            singleRead ? text('rest-headers-json-ok') : text('rest-headers-json-error'))

          rowsButton.click()
          await wait(300)
          const rowsAfterSingle = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
          push('and it becomes a real header row',
            rowsAfterSingle.map((input) => input.value).indexOf('X-Single') >= 0,
            'names=' + JSON.stringify(rowsAfterSingle.map((input) => input.value)))

          // An edit made in the rows has to be visible from the JSON side.
          const nameBoxes = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
          const valueBoxes = [...document.querySelectorAll('[data-testid="rest-header-value"]')]
          const atSingle = nameBoxes.findIndex((input) => input.value === 'X-Single')
          if (atSingle >= 0) {
            setValue(nameBoxes[atSingle], 'X-Carried')
            setValue(valueBoxes[atSingle], 'yes')
          }
          await wait(300)
          jsonButton.click()
          await wait(350)
          const carriedBox = field('rest-headers-json-input')
          push('an edit made in the rows shows up in the JSON box',
            !!carriedBox && carriedBox.value.indexOf('X-Carried') >= 0,
            carriedBox ? JSON.stringify(carriedBox.value.slice(0, 60)) : 'no box')

          // Text that does not parse yet is the only copy of that edit: switching
          // tabs must not overwrite it with the rows.
          setValue(field('rest-headers-json-input'), '{"X-Half": ')
          await wait(350)
          push('text that is not JSON yet is still reported', !!field('rest-headers-json-error'),
            text('rest-headers-json-error'))
          rowsButton.click()
          await wait(300)
          jsonButton.click()
          await wait(350)
          const keptBox = field('rest-headers-json-input')
          push('switching away and back keeps the text that was being typed',
            !!keptBox && keptBox.value === '{"X-Half": ',
            keptBox ? JSON.stringify(keptBox.value) : 'no box')
        }
      }

      /*
       * ---- 6e. 请求体窗口的大小要固定住 ------------------------------------
       * 用户原话："请求体 窗口 调整过大小以后 切个页面回来 又变了，不固定，希望固定一下"。
       * 原生 resize 手柄做的事就是把高度写进元素的**内联样式**，而工具页离开即卸载，
       * 内联样式随之消失 —— 所以这里模拟一次拖拽（浏览器做的就是这一步），再验证三件事：
       * 写进了页内状态、切页回来还在、重载之后还在。
       */
      step = 'body height'
      await openTab('body')
      const bodyBox = field('rest-body')
      push('the request body box is there to resize', !!bodyBox)
      if (bodyBox) {
        bodyBox.style.height = '420px'
        await waitFor(() => Math.round(bodyBox.getBoundingClientRect().height) === 420, 4000)
        // The write is debounced like the draft (400ms).
        await wait(900)
        const stored = await window.termdeck.loadRestState()
        push('a dragged height is written into the page state', stored.bodyHeight === 420,
          'bodyHeight=' + JSON.stringify(stored.bodyHeight))

        // Away to another tool page and back: the page unmounts, which is the bug.
        const awayTab = [...document.querySelectorAll('button')]
          .find((b) => (b.getAttribute('data-testid') || '') === 'rail-s3')
        if (awayTab) awayTab.click()
        await waitFor(() => !field('rest-body'), 8000)
        const restTab = [...document.querySelectorAll('button')]
          .find((b) => (b.getAttribute('data-testid') || '') === 'rail-rest')
        if (restTab) restTab.click()
        await waitFor(() => !!field('rest-page'), 10000)
        // Coming back remounts the page, so the editor is on its first tab again: the
        // body box has to be opened before its size can mean anything.
        await openTab('body')
        const keptSize = await waitFor(() => {
          const box = field('rest-body')
          return !!box && Math.round(box.getBoundingClientRect().height) === 420
        }, 10000)
        const backBox = field('rest-body')
        push('and coming back from another page keeps the size', keptSize,
          'height=' + (backBox ? Math.round(backBox.getBoundingClientRect().height) : -1))
      }

      /*
       * ---- 6f. 环境与 {{变量}} ---------------------------------------------
       * 环境是这次重做的核心之一：请求里写 {{base}}，发出去的必须是当前环境的值；环境里
       * 没有的名字必须**拒绝发送**并说出来，而不是把 {{nope}} 当路径发出去换来一个 404。
       */
      step = 'environments'
      const envRows = () => [...document.querySelectorAll('[data-testid="rest-env-item"]')]
      field('rest-env-manage').click()
      const envDialog = await waitFor(() => !!field('rest-env-dialog'), 6000)
      push('the environment manager opens', envDialog)
      field('rest-env-add').click()
      await wait(500)
      push('a new environment is created and picked', envRows().length === 1,
        'count=' + envRows().length)
      const envVarNames = () =>
        [...document.querySelectorAll('[data-testid="rest-env-var-name"]')].map((input) => input.value)
      push('it starts with one variable to fill in', envVarNames().length === 1,
        JSON.stringify(envVarNames()))
      const varNameBoxes = [...document.querySelectorAll('[data-testid="rest-env-var-name"]')]
      const varValueBoxes = [...document.querySelectorAll('[data-testid="rest-env-var-value"]')]
      if (varNameBoxes[0] && varValueBoxes[0]) {
        setValue(varNameBoxes[0], 'base')
        setValue(varValueBoxes[0], base)
      }
      if (field('rest-env-name')) setValue(field('rest-env-name'), 'probe env')
      await wait(400)
      // A switched-off variable has to read as undefined, or "off" means nothing.
      field('rest-env-var-add').click()
      await wait(350)
      push('adding a variable adds an empty line that stays there',
        envVarNames().length === 2, 'rows=' + envVarNames().length)
      const offNameBox = [...document.querySelectorAll('[data-testid="rest-env-var-name"]')].pop()
      const offValueBox = [...document.querySelectorAll('[data-testid="rest-env-var-value"]')].pop()
      if (offNameBox && offValueBox) {
        setValue(offNameBox, 'off')
        setValue(offValueBox, 'x')
      }
      await wait(250)
      const offEnabled = [...document.querySelectorAll('[data-testid="rest-env-var-enabled"]')].pop()
      if (offEnabled) offEnabled.click()
      await wait(400)
      field('rest-env-close').click()
      await wait(500)
      const envSelect = field('rest-env-select')
      const envOptions = envSelect ? [...envSelect.options].map((option) => option.textContent) : []
      push('the environment is in the selector',
        envOptions.some((name) => String(name).indexOf('probe env') >= 0), envOptions.join(','))
      setValue(field('rest-url'), '{{base}}/hello')
      await wait(500)
      const envStateNow = await window.termdeck.loadRestState()
      push('a variable the environment defines is not reported as missing',
        !field('rest-vars-undefined'),
        text('rest-vars-undefined') + ' active=' +
          ((field('rest-env-select') || {}).value || 'none') +
          ' environments=' + JSON.stringify(envStateNow.environments))
      field('rest-send').click()
      const viaVar = await waitFor(() => (text('rest-response-body') || '').indexOf('world') >= 0, 15000)
      push('a request written as a variable goes out with it resolved', viaVar,
        'status=' + text('rest-status'))
      setValue(field('rest-url'), '{{nope}}/hello')
      await wait(400)
      push('an undefined variable is pointed out while typing', !!field('rest-vars-undefined'),
        text('rest-vars-undefined'))
      field('rest-send').click()
      const refusedSend = await waitFor(() => !!field('rest-missing-vars'), 5000)
      push('and sending it is refused, naming what is missing', refusedSend,
        text('rest-missing-vars'))
      // A switched-off variable counts as undefined too: the same refusal, for the off one.
      setValue(field('rest-url'), '{{off}}/hello')
      await wait(400)
      field('rest-send').click()
      const refusedOff = await waitFor(() => !!field('rest-missing-vars'), 5000)
      push('a variable that is switched off counts as missing too', refusedOff,
        text('rest-missing-vars'))

      /*
       * ---- 6g. 认证分页 ----------------------------------------------------
       * 认证不是"多发一个头"那么简单：它必须真的到达服务端，而且用户手打的同名头不能被
       * 它悄悄覆盖掉（那条规则在共享层里，这里验的是走出去的那一份）。
       */
      step = 'auth'
      await openTab('auth')
      const authType = field('rest-auth-type')
      push('the auth tab offers the kinds that matter',
        !!authType &&
          [...authType.options].map((option) => option.value).join(',') === 'none,bearer,basic,apikey',
        authType ? [...authType.options].map((option) => option.value).join(',') : 'no select')
      if (authType) {
        setValue(authType, 'bearer')
        await wait(350)
        if (field('rest-auth-token')) setValue(field('rest-auth-token'), 'probe-token')
        await wait(300)
      }
      setValue(field('rest-url'), base + '/hello')
      await wait(300)
      field('rest-send').click()
      await waitFor(() => (text('rest-response-body') || '').indexOf('world') >= 0, 15000)

      /*
       * ---- 6h. 正文的三种模式 ----------------------------------------------
       * 表单模式发出去的必须是 urlencoded、并带上它自己的 Content-Type；JSON 模式只在
       * 用户没写 Content-Type 时才补。
       */
      step = 'body modes'
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), base + '/echo')
      /*
       * The JSON content type typed back in section 4 is still in the header table, and an
       * explicit content type is deliberately never overwritten — so it is removed here,
       * which is the only way form mode's own content type can be the one under test.
       */
      await openTab('headers')
      for (const remove of [...document.querySelectorAll('[data-testid="rest-header-remove"]')]) {
        remove.click()
        await wait(200)
      }
      await openTab('body')
      const formMode = field('rest-body-mode-form')
      push('the body mode is offered as tabs',
        !!formMode && !!field('rest-body-mode-none') && !!field('rest-body-mode-raw'))
      if (formMode) {
        formMode.click()
        await wait(350)
      }
      push('form mode shows a field table', !!field('rest-form-rows'))
      field('rest-form-add').click()
      await wait(350)
      const formNameBox = field('rest-form-name')
      const formValueBox = field('rest-form-value')
      if (formNameBox && formValueBox) {
        setValue(formNameBox, 'a')
        setValue(formValueBox, '1')
      }
      await wait(400)
      field('rest-send').click()
      const formEchoed = await waitFor(
        () => (text('rest-response-body') || '').indexOf('a=1') >= 0,
        15000
      )
      push('a form body is sent urlencoded', formEchoed,
        (text('rest-response-body') || '').slice(0, 90))

      /*
       * ---- 6i. cURL 导入 ---------------------------------------------------
       * 文档里的 curl 行是大多数人拿到接口的第一份说明书；导入要落到位，读不懂的那一行
       * 必须说清楚原因（尤其是 -F：文件上传在这里没有落点，不能装作导入成功）。
       */
      step = 'curl import'
      field('rest-curl-open').click()
      const curlDialog = await waitFor(() => !!field('rest-curl-dialog'), 6000)
      push('the cURL importer opens', curlDialog)
      /*
       * Quotes are built, never typed: this string is inside a template literal in the
       * probe file, and an escaped quote there is interpreted before the page ever sees it.
       */
      const dq = String.fromCharCode(34)
      const sq = String.fromCharCode(39)
      const importBody = '{' + dq + 'i' + dq + ':1}'
      const importCommand = [
        'curl',
        '-X',
        'PUT',
        sq + base + '/thing' + sq,
        '-H',
        sq + 'X-Imported: yes' + sq,
        '-d',
        sq + importBody + sq
      ].join(' ')
      setValue(field('rest-curl-text'), importCommand)
      await wait(300)
      field('rest-curl-apply').click()
      await wait(700)
      push('the imported method and URL land in the editor',
        valueOf('rest-url') === base + '/thing' &&
          (field('rest-method') || {}).value === 'PUT',
        'url=' + valueOf('rest-url') + ' method=' + ((field('rest-method') || {}).value || ''))
      await openTab('headers')
      // The header editor may still be on its JSON side from the sections above.
      if (field('rest-headers-rows')) {
        field('rest-headers-rows').click()
        await wait(350)
      }
      const importedNames = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
        .map((input) => input.value)
      push('and its headers', importedNames.indexOf('X-Imported') >= 0,
        JSON.stringify(importedNames))
      await openTab('body')
      push('and its body', valueOf('rest-body') === importBody, JSON.stringify(valueOf('rest-body')))
      field('rest-curl-open').click()
      await wait(500)
      setValue(field('rest-curl-text'), 'curl -F "file=@a.txt" http://127.0.0.1:1/upload')
      await wait(300)
      field('rest-curl-apply').click()
      const importRefused = await waitFor(() => !!field('rest-curl-error'), 4000)
      push('a multipart command is refused with a reason', importRefused, text('rest-curl-error'))
      push('and a refused import leaves the editor alone',
        valueOf('rest-url') === base + '/thing', 'url=' + valueOf('rest-url'))
      if (field('rest-curl-cancel')) {
        field('rest-curl-cancel').click()
        await wait(300)
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
      const failureOpen = failureRow
        ? failureRow.querySelector('[data-testid="rest-history-open"]')
        : null
      push('a history entry is a button that opens it', !!failureOpen)
      if (failureOpen) {
        failureOpen.click()
        await wait(500)
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
        const keptBefore = treeItems().length
        keepButton.click()
        await wait(700)
        push('keeping it files it in the collection tree',
          treeItems().length === keptBefore + 1,
          keptBefore + ' -> ' + treeItems().length)

        const renameButton = document.querySelector('[data-testid="rest-tree-rename"]')
        push('a saved request can be renamed', !!renameButton)
        if (renameButton) {
          renameButton.click()
          await wait(350)
          const nameInput = field('rest-tree-rename-input')
          push('renaming edits the name in place', !!nameInput)
          if (nameInput) {
            setValue(nameInput, 'probe renamed call')
            nameInput.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
            )
            await wait(700)
            push('the new name sticks', !!itemNamed('probe renamed call'),
              treeItems().map((row) => row.textContent).join(' | ').slice(0, 90))
          }
        }

        const renamedRow = itemNamed('probe renamed call')
        const dropButton = renamedRow
          ? renamedRow.querySelector('[data-testid="rest-tree-delete"]')
          : null
        push('a saved request can be deleted from the tree', !!dropButton)
        if (dropButton) {
          const beforeDrop = treeItems().length
          dropButton.click()
          await wait(700)
          push('and it is gone afterwards', treeItems().length === beforeDrop - 1,
            'before=' + beforeDrop + ' after=' + treeItems().length)
        }
      }

      /*
       * ---- 9b. 文件夹：建、归档、删夹不删请求 --------------------------------
       * 删掉一个文件夹却把它里面的请求一起删了，是没人会接受的交易，所以这里明确断言：
       * 夹子没了，请求回到上一层还在。
       */
      step = 'folders'
      /*
       * The tree is empty again at this point — the entry kept above was deliberately
       * deleted — so one is saved first: filing a request into a folder needs a request.
       */
      field('rest-save-saved').click()
      await wait(800)
      push('the editor can be saved straight into the collection', treeItems().length >= 1,
        'items=' + treeItems().length)
      field('rest-tree-add-folder').click()
      await wait(350)
      const folderInput = field('rest-tree-new-folder-input')
      push('a folder can be created', !!folderInput)
      if (folderInput) {
        setValue(folderInput, 'probe folder')
        folderInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
        await wait(700)
      }
      const folderRows = () => [...document.querySelectorAll('[data-testid="rest-tree-folder"]')]
      push('the folder is in the tree', folderRows().length === 1, 'folders=' + folderRows().length)

      // File a request into it, then fold the folder shut and open again: the request
      // has to travel with it rather than disappear from the tree.
      const firstItem = treeItems()[0]
      const firstName = firstItem ? (firstItem.textContent || '').trim() : ''
      if (firstItem) {
        const open = firstItem.querySelector('[data-testid="rest-tree-open"]')
        if (open) {
          open.click()
          await wait(500)
        }
      }
      const moveSelect = field('rest-tree-move')
      const folderId = folderRows()[0] ? folderRows()[0].getAttribute('data-folder-id') : ''
      push('a request can be moved into a folder', !!moveSelect && !!folderId,
        'folder=' + folderId)
      if (moveSelect && folderId) {
        setValue(moveSelect, folderId)
        await wait(700)
      }
      const folderRow = folderRows()[0]
      const insideCount = () => {
        const row = folderRows()[0]
        if (!row || !row.parentElement) return -1
        return row.parentElement.querySelectorAll('[data-testid="rest-tree-item"]').length
      }
      push('the request is filed inside the folder', insideCount() === 1,
        'inside=' + insideCount())
      const toggle = folderRow ? folderRow.querySelector('[data-testid="rest-tree-toggle"]') : null
      if (toggle) {
        toggle.click()
        await wait(500)
        push('folding the folder hides what is inside it', insideCount() === 0,
          'inside=' + insideCount())
        toggle.click()
        await wait(500)
        push('opening it brings the request back', insideCount() === 1, 'inside=' + insideCount())
      }
      const itemsBeforeFolderDelete = treeItems().length
      const folderRowNow = folderRows()[0]
      if (folderRowNow) {
        const folderDelete = folderRowNow.querySelector('[data-testid="rest-tree-delete"]')
        if (folderDelete) {
          folderDelete.click()
          await wait(700)
        }
      }
      push('deleting a folder keeps the requests that were inside it',
        folderRows().length === 0 && treeItems().length === itemsBeforeFolderDelete,
        'folders=' + folderRows().length + ' items=' + treeItems().length)
      const afterFolderDelete = await window.termdeck.loadRestState()
      const stillFiled = (afterFolderDelete.saved || []).filter(
        (entry) => entry.folderId === null || typeof entry.folderId === 'undefined'
      )
      push('and what was inside is filed at the top level, not lost',
        (afterFolderDelete.folders || []).length === 0 &&
          stillFiled.length === (afterFolderDelete.saved || []).length &&
          stillFiled.length === itemsBeforeFolderDelete,
        'folders=' + (afterFolderDelete.folders || []).length +
          ' top-level=' + stillFiled.length + ' saved=' + (afterFolderDelete.saved || []).length)

      // The filter searches names and URLs.
      const filterBox = field('rest-tree-search')
      if (filterBox) {
        setValue(filterBox, 'zzz-nothing-matches')
        await wait(500)
        push('filtering the tree hides what does not match', treeItems().length === 0,
          'shown=' + treeItems().length)
        setValue(filterBox, '')
        await wait(500)
        push('and clearing it brings the tree back',
          treeItems().length === itemsBeforeFolderDelete, 'shown=' + treeItems().length)
      }

      /*
       * ---- 10. 保存条目要带着请求头与 body（第二十九批） --------------------------
       * 用户原话："保存条目的请求头 和 body 也都保存"。这条往返（存一条带请求头和 body 的
       * 条目 -> 落盘 -> 选回来）之前从没被断言过：第 7 节种的条目是 headers: []、body: ''，
       * 而且只断言过"选回来 URL 对"。这里分四步：用界面存一条带请求头和 body 的条目并读
       * 落盘的文件；选回来断言编辑器里两样都在；改过之后用条目上的 Save 回写；重载后从
       * 文件里选回来（第 7 节的种子条目这次带着请求头和 body）。
       */
      step = 'kept round-trip'
      // The page was remounted in 6e, so the tabs have to be opened again from scratch.
      await openTab('headers')
      const rowsNow = field('rest-headers-rows')
      const jsonNow = field('rest-headers-json')
      const withUrl = 'http://kept.example/api/with-headers'
      setValue(field('rest-method'), 'POST')
      setValue(field('rest-url'), withUrl)
      // 请求头按单引号粘进来的形状设进去，顺带再走一遍第二十八批的解析规则。
      jsonNow.click()
      await wait(300)
      setValue(field('rest-headers-json-input'), "{'X-Kept-Header': 'v1'}")
      const headerRead = await waitFor(() => !!field('rest-headers-json-ok'), 3000)
      push('the header about to be kept is parsed and counted', headerRead,
        headerRead ? text('rest-headers-json-ok') : text('rest-headers-json-error'))
      await openTab('body')
      setValue(field('rest-body'), '{"kept":"body"}')
      field('rest-save-saved').click()
      await wait(700)
      const keptFile = await window.termdeck.loadRestState()
      const keptEntry = (keptFile.saved || []).find((e) => e.request.url === withUrl)
      push('keeping an entry writes its headers into the file',
        !!keptEntry && keptEntry.request.headers.length === 1 &&
          keptEntry.request.headers[0].name === 'X-Kept-Header' &&
          keptEntry.request.headers[0].value === 'v1',
        JSON.stringify(keptEntry ? keptEntry.request.headers : 'no entry'))
      push('and its body too',
        !!keptEntry && keptEntry.request.body === '{"kept":"body"}',
        JSON.stringify(keptEntry ? keptEntry.request.body : 'no entry'))

      // 选回来：树里点开它，行编辑器（真正在用的那份列表）里要有这个请求头，body 要回到框里。
      /*
       * 这条条目是上面那个"保存"按钮更新的（选中一条时它更新那一条，这是设计），所以它的
       * 名字还是按当时那个 URL 起的。先在树里把它改成一个固定的名字，后面的查找才是确定的。
       */
      const selectedRow = document.querySelector('[data-testid="rest-tree-item"].is-selected')
      if (selectedRow) {
        const renameIt = selectedRow.querySelector('[data-testid="rest-tree-rename"]')
        if (renameIt) {
          renameIt.click()
          await wait(350)
          const renameBox = field('rest-tree-rename-input')
          if (renameBox) {
            setValue(renameBox, 'round trip entry')
            renameBox.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
            )
            await wait(700)
          }
        }
      }
      const keptLabel = 'round trip entry'
      push('the kept entry is in the collection tree', !!itemNamed(keptLabel),
        treeItems().map((row) => row.textContent).join(',').slice(0, 90))
      await openNamed(keptLabel)
      await openTab('headers')
      const rowsButtonAgain = field('rest-headers-rows')
      if (rowsButtonAgain) {
        rowsButtonAgain.click()
        await wait(350)
      }
      const pickedNames = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
        .map((input) => input.value)
      push('picking it restores the headers into the rows',
        pickedNames.indexOf('X-Kept-Header') >= 0, 'names=' + JSON.stringify(pickedNames))
      await openTab('body')
      push('and the body back into the box', valueOf('rest-body') === '{"kept":"body"}',
        JSON.stringify(valueOf('rest-body')))

      // 保存后再编辑：工具栏上的保存要把编辑器回写进这条条目，请求头不能因此丢掉。
      setValue(field('rest-body'), '{"kept":"edited"}')
      await wait(400)
      field('rest-save-saved').click()
      await wait(800)
      const editedFile = await window.termdeck.loadRestState()
      const editedEntry = (editedFile.saved || []).find((e) => e.request.url === withUrl)
      push('saving the editor over the entry keeps the edited body',
        !!editedEntry && editedEntry.request.body === '{"kept":"edited"}',
        JSON.stringify(editedEntry ? editedEntry.request.body : 'no entry'))
      push('and does not drop the headers the entry had',
        !!editedEntry && editedEntry.request.headers.length === 1 &&
          editedEntry.request.headers[0].name === 'X-Kept-Header',
        JSON.stringify(editedEntry ? editedEntry.request.headers : 'no entry'))

      // 还没解析成功的文本不是请求头：保存时既不能把它当头存进去，也不能把在用的头弄丢。
      await openTab('headers')
      if (field('rest-headers-json')) {
        field('rest-headers-json').click()
        await wait(350)
      }
      setValue(field('rest-headers-json-input'), '{"X-Unparsed": ')
      const unparsedSeen = await waitFor(() => !!field('rest-headers-json-error'), 3000)
      push('the half-typed header text is still reported before saving', unparsedSeen,
        unparsedSeen ? text('rest-headers-json-error') : 'no error shown')
      field('rest-save-saved').click()
      await wait(700)
      const unparsedFile = await window.termdeck.loadRestState()
      const unparsedEntry = (unparsedFile.saved || []).find((e) => e.request.url === withUrl)
      push('saving with unparsed header text keeps exactly the headers in use',
        !!unparsedEntry && unparsedEntry.request.headers.length === 1 &&
          unparsedEntry.request.headers[0].name === 'X-Kept-Header' &&
          unparsedEntry.request.headers[0].value === 'v1',
        JSON.stringify(unparsedEntry ? unparsedEntry.request.headers : 'no entry'))
      push('and the half-typed text itself is not stored as a header',
        !!unparsedEntry && JSON.stringify(unparsedEntry.request.headers).indexOf('Unparsed') < 0,
        JSON.stringify(unparsedEntry ? unparsedEntry.request.headers : 'no entry'))

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
  const post = received.find((entry) => entry.url === '/echo' && entry.body === '{"ping":"pong"}')
  // By the header it carried, not by being the last one: several requests go to /hello now.
  const jsonHeader = received.find(
    (entry) => entry.url === '/hello' && entry.headers['x-from-json'] === 'yes'
  )
  const paramRequest = received.find((entry) => entry.url === '/hello?probe=param')
  const varRequest = received.find(
    (entry) => entry.url === '/hello' && entry.headers['x-carried'] === 'yes'
  )
  const authRequest = received.find(
    (entry) => entry.url === '/hello' && entry.headers['authorization'] === 'Bearer probe-token'
  )
  const formPost = received.filter((entry) => entry.url === '/echo').pop()
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
    },
    {
      name: 'a parameter typed into the table reached the server as a query',
      ok: !!paramRequest,
      detail: paramRequest ? paramRequest.url : received.map((entry) => entry.url).join(' ')
    },
    {
      name: 'a URL written as a variable arrived as the real address',
      ok: !!varRequest,
      detail: varRequest ? varRequest.url : 'no request carried the header'
    },
    {
      name: 'the auth tab put its header on the wire',
      ok: !!authRequest,
      detail: authRequest ? String(authRequest.headers['authorization']) : 'no bearer header'
    },
    {
      name: 'a form body arrived urlencoded',
      ok: !!formPost && formPost.body === 'a=1' &&
        String(formPost.headers['content-type']).includes('application/x-www-form-urlencoded'),
      detail: formPost ? formPost.body + ' / ' + String(formPost.headers['content-type']) : 'no post'
    },
    {
      name: 'nothing with an unresolved variable ever reached the wire',
      ok: !received.some((entry) => entry.url.indexOf('{{') >= 0),
      detail: received.map((entry) => entry.url).filter((url) => url.indexOf('{{') >= 0).join(' ')
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
        // Seeded, so the reload also shows that a dragged height is really in the file
        // and not just in this window's React state.
        bodyHeight: 300,
        saved: [
          {
            id: 's1',
            name: 'kept health',
            // 第二十九批起带着请求头与 body 种：落盘 -> 重载 -> 选回，两样都要回来。
            request: {
              method: 'POST',
              url: 'http://kept.example/health',
              headers: [{ name: 'X-Seeded', value: 'from-file' }],
              body: '{"seed":"body"}'
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
        const treeRows = [...document.querySelectorAll('[data-testid="rest-tree-item"]')]
        push('the saved request is listed in the tree',
          treeRows.some((row) => (row.textContent || '').indexOf('kept health') >= 0),
          treeRows.map((row) => row.textContent).join(','))
        const keptRow = treeRows.find((row) => (row.textContent || '').indexOf('kept health') >= 0)
        if (keptRow) {
          const open = keptRow.querySelector('[data-testid="rest-tree-open"]')
          if (open) {
            open.click()
            await wait(500)
          }
          push('picking it fills the request in',
            (field('rest-url') || {}).value === 'http://kept.example/health',
            'url=' + ((field('rest-url') || {}).value || ''))
          // 从文件里回来的条目，请求头与 body 也都得回来（第二十九批）。
          const headersTab = field('rest-tab-headers')
          if (headersTab) {
            headersTab.click()
            await wait(350)
          }
          const seededNames = [...document.querySelectorAll('[data-testid="rest-header-name"]')]
            .map((input) => input.value)
          push('picking it restores the headers that were in the file',
            seededNames.indexOf('X-Seeded') >= 0, 'names=' + JSON.stringify(seededNames))
          const bodyTab = field('rest-tab-body')
          if (bodyTab) {
            bodyTab.click()
            await wait(350)
          }
          push('and the body that was in the file',
            (field('rest-body') || {}).value === '{"seed":"body"}',
            'body=' + JSON.stringify((field('rest-body') || {}).value || ''))
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

        // The height that was in the file, applied to a page that has just started.
        const sizedBack = await waitFor(() => {
          const box = field('rest-body')
          return !!box && Math.round(box.getBoundingClientRect().height) === 300
        }, 8000)
        const sizedBox = field('rest-body')
        push('the size a saved file carries is applied after a real reload', sizedBack,
          'height=' + (sizedBox ? Math.round(sizedBox.getBoundingClientRect().height) : -1))
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
