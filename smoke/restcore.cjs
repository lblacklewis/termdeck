/**
 * REST 工作台的地基：请求怎么组装、cURL 怎么进出、旧存储怎么读上来。
 *
 * 这一层刻意全是纯函数与存储读写 —— 没有窗口、没有网络，所以它跑得快、断言硬，
 * 而且能在"界面上看不出来"的地方把错抓出来（参数折回 URL 的编码、{{变量}} 缺失时
 * 到底发不发、Basic 认证的 base64、v1 文件读上来之后的形状）。
 *
 * 两组证据：
 *   A. 共享层纯函数（esbuild 现打 src/shared/rest*.ts）：参数表与 URL 的双向同步、
 *      变量替换、有效请求组装（含 Content-Type 与 auth 头）、cURL 导出与**导入**
 *      （还做 round-trip：导出再导入必须回到同一个请求）；
 *   B. 真实的主进程存储（out/main/smokeEntry.js 里导出的 RestStore）：一份 v1 的
 *      rest.json 读进来之后，已保存条目落在根层、body 推断出 json/raw、界面上没编辑过的
 *      字段不被写丢；v2 里指向不存在的文件夹/环境的引用被收回到安全位置。
 *
 * 旧代码上这组必然失败：这些模块与字段那时都不存在（A 组直接显式 FAIL）。
 *
 * 用法：npx electron smoke/restcore.cjs --user-data-dir=node_modules/.smoke-data/restcore
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app } = require('electron')

const ROOT = 'D:\\project\\dsh-workspace\\termdeck'
const DASH = String.fromCharCode(8212)
const NL = String.fromCharCode(10)

const checks = []
const push = (name, ok, detail) =>
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? true : detail })

function report() {
  let failed = 0
  for (const check of checks) {
    const ok = check.ok === true
    if (!ok) failed += 1
    const detail = check.detail === true ? '' : ' ' + DASH + ' ' + String(check.detail ?? '')
    console.log((ok ? 'PASS  ' : 'FAIL  ') + check.name + detail)
  }
  console.log(NL + (checks.length - failed) + '/' + checks.length + ' checks passed')
  return failed
}

function slash(p) {
  return p.split(path.sep).join('/')
}

async function main() {
  const guard = setTimeout(() => {
    console.error('restcore probe watchdog')
    app.exit(1)
  }, 120000)

  // ---- A. the shared layer, bundled the way the app bundles it -----------
  let mod = null
  try {
    const { buildSync } = require('esbuild')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-restcore-'))
    const entry = path.join(dir, 'entry.ts')
    const files = ['restUrl', 'restVars', 'restBuild', 'restCurl'].map((name) =>
      slash(path.join(ROOT, 'src', 'shared', name + '.ts'))
    )
    fs.writeFileSync(
      entry,
      files.map((file) => 'export * from ' + JSON.stringify(file)).join(NL),
      'utf8'
    )
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(dir, 'restcore.cjs'),
      logLevel: 'silent'
    })
    mod = require(path.join(dir, 'restcore.cjs'))
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    push('the shared REST layer can be bundled out of src/shared', false,
      'explicit FAIL: ' + String((err && err.message) || err))
  }

  if (!mod) {
    clearTimeout(guard)
    app.exit(report() === 0 ? 0 : 1)
    return
  }

  // ---- A1. parameters and the URL are two views of one thing ------------
  const ZHONG = String.fromCharCode(0x4e2d)
  const split = mod.splitUrlQuery('https://api.test/pets?a=1&b=hello%20world&c=%E4%B8%AD')
  push('the query is split off the URL, in order and decoded',
    split.base === 'https://api.test/pets' &&
      split.params.length === 3 &&
      split.params[1].value === 'hello world' &&
      split.params[2].value === ZHONG,
    'base=' + split.base + ' rows=' + JSON.stringify(split.params))

  const plus = mod.splitUrlQuery('https://api.test/x?q=a+b')
  push('a plus in a value reads as a space', plus.params[0].value === 'a b',
    'value=' + JSON.stringify(plus.params[0].value))

  const noQuery = mod.splitUrlQuery('https://api.test/pets')
  push('a URL with no query has no rows', noQuery.params.length === 0 && noQuery.base === 'https://api.test/pets')

  const frag = mod.splitUrlQuery('https://api.test/pets?q=1#section')
  push('a fragment stays on the base, not inside the query',
    frag.params.length === 1 && frag.base === 'https://api.test/pets#section',
    'base=' + frag.base)

  const composed = mod.composeUrl('https://api.test/pets', [
    { name: 'a', value: '1', enabled: true },
    { name: 'b', value: 'hello world', enabled: true },
    { name: 'off', value: 'x', enabled: false },
    { name: '  ', value: 'y', enabled: true },
    { name: 'empty', value: '', enabled: true }
  ])
  push('composing keeps enabled named rows, encodes them, and drops the rest',
    composed === 'https://api.test/pets?a=1&b=hello%20world&empty=',
    composed)

  push('composing with nothing to add gives the base back',
    mod.composeUrl('https://api.test/pets', []) === 'https://api.test/pets')

  push('composing puts the fragment at the very end',
    mod.composeUrl('https://api.test/pets#top', [
      { name: 'a', value: '1', enabled: true }
    ]) === 'https://api.test/pets?a=1#top')

  const kept = mod.paramsForUrl('https://api.test/pets?a=2', [
    { name: 'a', value: '1', enabled: true },
    { name: 'gone', value: 'x', enabled: true },
    { name: 'off', value: 'y', enabled: false }
  ])
  push('editing the URL drops the rows it no longer has, and keeps the switched-off ones',
    kept.length === 2 &&
      kept[0].name === 'a' && kept[0].value === '2' &&
      kept[1].name === 'off' && kept[1].enabled === false,
    JSON.stringify(kept))

  // ---- A2. {{name}} ------------------------------------------------------
  const vars = { base: 'http://127.0.0.1:4523', token: 'abc' }
  const filled = mod.substituteVars('{{base}}/pets?t={{ token }}&x={{nope}}', vars)
  push('defined variables are replaced, spaces inside the braces are fine',
    filled.text === 'http://127.0.0.1:4523/pets?t=abc&x={{nope}}',
    filled.text)
  push('an undefined variable is left visible and reported',
    filled.missing.length === 1 && filled.missing[0] === 'nope',
    JSON.stringify(filled.missing))
  push('variables are listed without duplicates',
    JSON.stringify(mod.varsUsed('{{a}} {{a}} {{b}}')) === JSON.stringify(['a', 'b']))
  push('text with no braces has no variables',
    mod.varsUsed('plain text').length === 0 && mod.usesVars('plain text') === false)

  const env = {
    id: 'e1',
    name: 'local',
    variables: [
      { name: 'base', value: 'http://127.0.0.1:4523', enabled: true },
      { name: 'token', value: 'abc', enabled: true },
      { name: 'off', value: 'x', enabled: false }
    ]
  }
  const envVars = mod.environmentVars(env)
  push('a switched-off variable counts as undefined',
    envVars.base === 'http://127.0.0.1:4523' && envVars.off === undefined,
    JSON.stringify(envVars))

  // ---- A3. the request that actually goes out ---------------------------
  const built = mod.buildRestRequest(
    {
      method: 'GET',
      url: '{{base}}/pets',
      params: [
        { name: 'page', value: '2', enabled: true },
        { name: 'skip', value: 'me', enabled: false }
      ],
      headers: [{ name: 'X-Env', value: '{{token}}' }]
    },
    env
  )
  push('the sent URL has the parameters folded in and the variables resolved',
    built.ok === true &&
      built.request.url === 'http://127.0.0.1:4523/pets?page=2',
    'url=' + built.request.url)
  push('variables in headers are resolved too',
    built.request.headers[0].value === 'abc',
    JSON.stringify(built.request.headers))

  const unresolved = mod.buildRestRequest(
    { method: 'GET', url: '{{nope}}/pets', headers: [] },
    env
  )
  push('a request using an undefined variable is not sendable, and says which',
    unresolved.ok === false &&
      unresolved.missing.length === 1 && unresolved.missing[0] === 'nope' &&
      unresolved.request.url.indexOf('{{nope}}') === 0,
    'ok=' + unresolved.ok + ' missing=' + JSON.stringify(unresolved.missing))

  const fromUrl = mod.buildRestRequest(
    { method: 'GET', url: 'https://api.test/pets?q=1&r=2', headers: [] },
    null
  )
  push('a request whose parameters only exist in the URL still sends them',
    fromUrl.request.url === 'https://api.test/pets?q=1&r=2',
    fromUrl.request.url)

  const bearer = mod.authHeaders({ type: 'bearer', token: 'xyz' })
  push('Bearer auth becomes an Authorization header',
    bearer.length === 1 && bearer[0].name === 'Authorization' &&
      bearer[0].value === 'Bearer xyz',
    JSON.stringify(bearer))

  const basic = mod.authHeaders({ type: 'basic', username: 'user', password: 'pass' })
  const oracle = Buffer.from('user:pass', 'utf8').toString('base64')
  push('Basic auth is base64 of user:colon:password',
    basic.length === 1 && basic[0].value === 'Basic ' + oracle,
    JSON.stringify(basic) + ' expected ' + oracle)

  const unicode = mod.authHeaders({ type: 'basic', username: 'u' + ZHONG, password: 'p' })
  push('Basic auth encodes non-ASCII credentials as UTF-8',
    unicode[0].value === 'Basic ' + Buffer.from('u' + ZHONG + ':p', 'utf8').toString('base64'),
    unicode[0].value)

  const apiKey = mod.authHeaders({ type: 'apikey', key: 'X-Api-Key', value: 'k1' })
  push('an API key goes into the header it names',
    apiKey.length === 1 && apiKey[0].name === 'X-Api-Key' && apiKey[0].value === 'k1',
    JSON.stringify(apiKey))

  const noAuth = mod.authHeaders({ type: 'none' })
  push('auth "none" adds nothing', noAuth.length === 0 && mod.authHeaders(undefined).length === 0)

  const wins = mod.buildRestRequest(
    {
      method: 'GET',
      url: 'https://api.test/x',
      headers: [{ name: 'authorization', value: 'Bearer typed-by-hand' }],
      auth: { type: 'bearer', token: 'from-the-tab' }
    },
    null
  )
  push('a hand-typed Authorization header wins over the auth tab',
    wins.request.headers.length === 1 &&
      wins.request.headers[0].value === 'Bearer typed-by-hand',
    JSON.stringify(wins.request.headers))

  const jsonBuilt = mod.buildRestRequest(
    { method: 'POST', url: 'https://api.test/x', headers: [], bodyMode: 'json', body: '{"a":1}' },
    null
  )
  push('JSON mode declares its content type',
    jsonBuilt.request.body === '{"a":1}' &&
      jsonBuilt.request.headers.some(
        (header) => header.name === 'Content-Type' && header.value === 'application/json'
      ),
    JSON.stringify(jsonBuilt.request.headers))

  const formBuilt = mod.buildRestRequest(
    {
      method: 'POST',
      url: 'https://api.test/x',
      headers: [],
      bodyMode: 'form',
      form: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: 'two words', enabled: true },
        { name: 'off', value: 'x', enabled: false }
      ]
    },
    null
  )
  push('form mode becomes an urlencoded body with its own content type',
    formBuilt.request.body === 'a=1&b=two%20words' &&
      formBuilt.request.headers.some(
        (header) =>
          header.name === 'Content-Type' &&
          header.value === 'application/x-www-form-urlencoded'
      ),
    'body=' + formBuilt.request.body + ' headers=' + JSON.stringify(formBuilt.request.headers))

  const typed = mod.buildRestRequest(
    {
      method: 'POST',
      url: 'https://api.test/x',
      headers: [{ name: 'Content-Type', value: 'application/vnd.custom+json' }],
      bodyMode: 'json',
      body: '{}'
    },
    null
  )
  push('a content type the user typed is never overwritten',
    typed.request.headers.length === 1 &&
      typed.request.headers[0].value === 'application/vnd.custom+json',
    JSON.stringify(typed.request.headers))

  push('a stored body with no mode is read as JSON when it parses',
    mod.effectiveBodyMode({ method: 'POST', url: 'u', headers: [], body: '{"a":1}' }) === 'json')
  push('and as raw when it does not',
    mod.effectiveBodyMode({ method: 'POST', url: 'u', headers: [], body: 'not json' }) === 'raw')
  push('no body means no mode',
    mod.effectiveBodyMode({ method: 'POST', url: 'u', headers: [] }) === 'none')

  const requestVars = mod.requestVars({
    method: 'POST',
    url: '{{base}}/x',
    headers: [{ name: 'X', value: '{{token}}' }],
    params: [{ name: 'p', value: '{{page}}', enabled: true }],
    bodyMode: 'raw',
    body: '{{body}}',
    auth: { type: 'bearer', token: '{{token}}' }
  })
  push('the variables a whole request uses are collected without duplicates',
    JSON.stringify(requestVars) === JSON.stringify(['base', 'page', 'token', 'body']),
    JSON.stringify(requestVars))

  // ---- A4. cURL out, and back in ----------------------------------------
  const exported = mod.buildCurl({
    method: 'POST',
    url: 'https://api.test/pets',
    params: [{ name: 'q', value: 'a b', enabled: true }],
    headers: [{ name: 'Accept', value: 'application/json' }],
    bodyMode: 'json',
    body: '{"name":"x"}',
    auth: { type: 'bearer', token: 'tok' },
    insecure: true
  })
  push('the exported line is a curl command with the method, URL and headers',
    exported.indexOf('curl -X POST') === 0 &&
      exported.indexOf("'https://api.test/pets?q=a%20b'") > 0 &&
      exported.indexOf("-H 'Accept: application/json'") > 0 &&
      exported.indexOf('-H ' + "'" + 'Authorization: Bearer tok' + "'") > 0 &&
      exported.indexOf('--data') > 0 &&
      exported.indexOf('--insecure') > 0,
    exported.split(NL).join(' | '))

  const docStyle = [
    'curl -X POST https://api.test/pets \\',
    "  -H 'Content-Type: application/json' \\",
    "  -H 'X-Trace: abc' \\",
    "  -d '{\"name\":\"rex\"}' \\",
    '  --compressed -k'
  ].join(NL)
  const imported = mod.parseCurl(docStyle)
  push('a documentation-style curl line is understood',
    imported.ok === true &&
      imported.request.method === 'POST' &&
      imported.request.url === 'https://api.test/pets' &&
      imported.request.headers.length === 2 &&
      imported.request.body === '{"name":"rex"}' &&
      imported.request.bodyMode === 'json' &&
      imported.request.insecure === true,
    imported.ok ? JSON.stringify(imported.request) : imported.message)

  const withUser = mod.parseCurl("curl -u alice:secret https://api.test/x")
  push('curl -u becomes basic auth',
    withUser.ok === true && withUser.request.auth &&
      withUser.request.auth.type === 'basic' &&
      withUser.request.auth.username === 'alice' &&
      withUser.request.auth.password === 'secret',
    withUser.ok ? JSON.stringify(withUser.request.auth) : withUser.message)

  const getWithData = mod.parseCurl("curl -G -d 'a=1' -d 'b=2' https://api.test/x")
  push('curl -G puts its data in the query table, not in the body',
    getWithData.ok === true &&
      getWithData.request.method === 'GET' &&
      getWithData.request.body === undefined &&
      (getWithData.request.params || []).length === 2,
    getWithData.ok ? JSON.stringify(getWithData.request) : getWithData.message)

  const withQuery = mod.parseCurl("curl 'https://api.test/x?a=1&b=2'")
  push('a query in the pasted URL lands in the parameter table',
    withQuery.ok === true &&
      withQuery.request.url === 'https://api.test/x' &&
      (withQuery.request.params || []).length === 2,
    withQuery.ok ? JSON.stringify(withQuery.request) : withQuery.message)

  const multipart = mod.parseCurl("curl -F 'file=@a.txt' https://api.test/upload")
  push('a multipart upload is refused in words, not silently dropped',
    multipart.ok === false && multipart.message.indexOf('multipart') >= 0,
    multipart.ok ? 'accepted' : multipart.message)

  const noUrl = mod.parseCurl('curl -X POST')
  push('a curl line with no URL is refused',
    noUrl.ok === false && noUrl.message.indexOf('URL') >= 0,
    noUrl.ok ? 'accepted' : noUrl.message)

  const unbalanced = mod.parseCurl("curl -H 'X: y https://api.test/x")
  push('an unterminated quote is refused rather than guessed',
    unbalanced.ok === false && unbalanced.message.indexOf('quote') >= 0,
    unbalanced.ok ? 'accepted' : unbalanced.message)

  const original = {
    method: 'PATCH',
    url: 'https://api.test/pets/7',
    params: [{ name: 'force', value: 'true', enabled: true }],
    headers: [{ name: 'X-Trace', value: 'abc' }],
    bodyMode: 'json',
    body: '{"name":"rex"}',
    auth: { type: 'bearer', token: 'tok' },
    insecure: true
  }
  const roundTrip = mod.parseCurl(mod.buildCurl(original))
  const same =
    roundTrip.ok === true &&
    roundTrip.request.method === original.method &&
    roundTrip.request.url === original.url &&
    JSON.stringify(roundTrip.request.params) === JSON.stringify(original.params) &&
    JSON.stringify(roundTrip.request.headers) ===
      JSON.stringify(original.headers.concat([{ name: 'Authorization', value: 'Bearer tok' }])) &&
    roundTrip.request.body === original.body &&
    roundTrip.request.bodyMode === 'json' &&
    roundTrip.request.insecure === true
  push('export then import gives the same request back',
    same, roundTrip.ok ? JSON.stringify(roundTrip.request) : roundTrip.message)

  // ---- B. the store, and what it does with an old file -------------------
  const mod2 = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  if (typeof mod2.RestStore !== 'function') {
    push('the main process exports its REST store to the harness', false,
      'explicit FAIL: smokeEntry does not export RestStore')
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-reststore-'))
    const file = path.join(dir, 'rest.json')
    // A v1 file, exactly as the shipped version wrote it.
    fs.writeFileSync(
      file,
      JSON.stringify({
        draft: {
          method: 'POST',
          url: 'https://api.test/pets',
          headers: [{ name: 'Accept', value: 'application/json' }],
          body: '{"name":"rex"}'
        },
        saved: [
          {
            id: 's1',
            name: 'create pet',
            request: {
              method: 'POST',
              url: 'https://api.test/pets',
              headers: [],
              body: 'plain text, not json'
            }
          }
        ],
        history: [
          {
            id: 'h1',
            at: 1,
            request: { method: 'GET', url: 'https://api.test/pets', headers: [] },
            ok: true,
            durationMs: 12
          }
        ],
        bodyHeight: 300
      }),
      'utf8'
    )
    const store = new mod2.RestStore(dir)
    const state = store.load()
    push('a v1 file reads up with the collection fields present and empty',
      Array.isArray(state.folders) && state.folders.length === 0 &&
        Array.isArray(state.environments) && state.environments.length === 0 &&
        state.activeEnvironmentId === null,
      JSON.stringify({ folders: state.folders, environments: state.environments, active: state.activeEnvironmentId }))
    push('a saved request with no folder sits at the top level',
      state.saved.length === 1 && state.saved[0].folderId === null,
      JSON.stringify(state.saved.map((entry) => entry.folderId)))
    push('the old draft body is read as JSON',
      state.draft && state.draft.bodyMode === 'json',
      'bodyMode=' + (state.draft && state.draft.bodyMode))
    push('an old body that is not JSON is read as raw',
      state.saved[0].request.bodyMode === 'raw',
      'bodyMode=' + state.saved[0].request.bodyMode)
    push('the dragged body height survives the migration', state.bodyHeight === 300,
      'bodyHeight=' + state.bodyHeight)
    push('history is carried across', state.history.length === 1 && state.history[0].id === 'h1')

    const written = store.save({
      draft: null,
      folders: [
        { id: 'f1', name: 'pets', parentId: null },
        { id: 'f2', name: 'orphan', parentId: 'missing' },
        { id: 'f3', name: 'loop', parentId: 'f3' },
        { id: 'f4', name: '  ', parentId: null }
      ],
      saved: [
        {
          id: 's1',
          name: 'create pet',
          folderId: 'f1',
          request: {
            method: 'POST',
            url: 'https://api.test/pets',
            params: [
              { name: 'q', value: '1', enabled: true },
              { name: '', value: '', enabled: true }
            ],
            headers: [],
            bodyMode: 'form',
            form: [{ name: 'a', value: '1', enabled: false }],
            auth: { type: 'nonsense' }
          }
        },
        {
          id: 's2',
          name: 'homeless',
          folderId: 'gone',
          request: { method: 'GET', url: 'https://api.test/x', headers: [] }
        }
      ],
      environments: [
        { id: 'e1', name: 'local', variables: [{ name: 'host', value: '127.0.0.1', enabled: true }] },
        { id: 'e2', name: '  ', variables: [] }
      ],
      activeEnvironmentId: 'nope',
      history: [],
      bodyHeight: 123
    })

    push('a nameless folder is dropped, and a folder with no parent goes to the top',
      written.folders.length === 3 &&
        written.folders.every((folder) => folder.parentId === null || folder.parentId === 'f1') &&
        written.folders.some((folder) => folder.id === 'f2' && folder.parentId === null) &&
        written.folders.some((folder) => folder.id === 'f3' && folder.parentId === null),
      JSON.stringify(written.folders))

    push('a request filed in a folder that is gone is moved to the top, not lost',
      written.saved.length === 2 &&
        written.saved.some((entry) => entry.id === 's2' && entry.folderId === null),
      JSON.stringify(written.saved.map((entry) => [entry.id, entry.folderId])))

    push('an unknown auth type is dropped rather than stored',
      written.saved[0].request.auth === undefined,
      JSON.stringify(written.saved[0].request.auth))

    push('parameter rows are kept, and an empty row is not',
      (written.saved[0].request.params || []).length === 1,
      JSON.stringify(written.saved[0].request.params))

    push('a form row is kept with its switched-off state',
      (written.saved[0].request.form || []).length === 1 &&
        written.saved[0].request.form[0].enabled === false,
      JSON.stringify(written.saved[0].request.form))

    push('a nameless environment is dropped, and the active one must exist',
      written.environments.length === 1 && written.activeEnvironmentId === null,
      JSON.stringify({ environments: written.environments.map((e) => e.name), active: written.activeEnvironmentId }))

    push('an active environment that does exist is kept', (() => {
      const next = store.save({ ...written, activeEnvironmentId: 'e1' })
      return next.activeEnvironmentId === 'e1'
    })(), 'active=' + store.load().activeEnvironmentId)

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    push('what reaches the disk is the new shape',
      Array.isArray(onDisk.folders) && Array.isArray(onDisk.environments) &&
        typeof onDisk.activeEnvironmentId !== 'undefined',
      Object.keys(onDisk).join(','))
    fs.rmSync(dir, { recursive: true, force: true })
  }

  clearTimeout(guard)
  const code = report() === 0 ? 0 : 1
  fs.mkdirSync(path.join(ROOT, 'node_modules', '.smoke-data'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'node_modules', '.smoke-data', 'restcore-last.json'),
    JSON.stringify(checks, null, 2)
  )
  app.exit(code)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('restcore probe crashed: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  })
)
