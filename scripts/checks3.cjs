/**
 * Conformance of the S3 request signer.
 *
 * Runs on plain `node` — no Electron, no app build — because SigV4 is pure
 * arithmetic and the only trustworthy reference is AWS's own published vectors.
 * A bad signature does not throw: it comes back as a 403 from the far end, hours
 * later, with no clue which of the six steps was wrong. So the two worked
 * examples from the AWS documentation are asserted here **exactly**, signature
 * included, and the rest pins the rules that differ between services.
 *
 * The TypeScript is bundled with esbuild (already a dependency, via
 * electron-vite) into a temp file so this stays a single fast step in the gate.
 */
const { buildSync } = require('esbuild')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const only = process.argv[2]

const dir = mkdtempSync(join(tmpdir(), 'td-s3-'))
const outfile = join(dir, 'sigv4.cjs')
try {
  // A one-line entry that re-exports both modules, so the temp bundle exposes the
  // signer and the client together. Absolute paths with forward slashes: esbuild
  // takes them on every platform, and a Windows backslash would be an escape.
  const entry = join(dir, 'entry.ts')
  const s3dir = join(ROOT, 'src', 'main', 's3').replace(/\\/g, '/')
  writeFileSync(entry, `export * from '${s3dir}/sigv4'\nexport * from '${s3dir}/S3Client'\n`, 'utf8')
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
} catch (err) {
  console.error('could not bundle the S3 modules:', err.message)
  process.exit(1)
}

const { signRequest, EMPTY_PAYLOAD_HASH } = require(outfile)

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail || '' })
}

/*
 * AWS's own conformance vector: the `get-vanilla` case of the SigV4 test suite.
 * Everything about it is fixed, including the instant, so the signature must be
 * reproduced character for character.
 */
const VANILLA = {
  method: 'GET',
  url: 'https://example.amazonaws.com/',
  body: '',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z'
}

const vanilla = signRequest(VANILLA)
check(
  'get-vanilla reproduces the published signature',
  vanilla.authorization ===
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  vanilla.authorization
)
check('an empty body hashes to the documented constant',
  vanilla.contentSha256 === EMPTY_PAYLOAD_HASH, vanilla.contentSha256)

/*
 * The S3 example from "Authenticating Requests (AWS Signature Version 4)":
 * GET on an object with a Range header, where x-amz-content-sha256 is part of
 * the signed set. This is the shape the app actually sends, so it matters more
 * than the vanilla case.
 */
const s3 = signRequest({
  method: 'GET',
  url: 'https://examplebucket.s3.amazonaws.com/test.txt',
  body: '',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  amzDate: '20130524T000000Z',
  signContentSha256: true,
  extraHeaders: { range: 'bytes=0-9' }
})
check(
  'the documented S3 GET reproduces its signature',
  s3.authorization ===
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  s3.authorization
)
check('its signed header set is the documented one',
  s3.headers.Authorization.includes('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date'))

// ---- the rules, one at a time -------------------------------------------

const a = signRequest({ ...VANILLA, url: 'https://example.amazonaws.com/?Param1=v1&Param2=v2' })
const b = signRequest({ ...VANILLA, url: 'https://example.amazonaws.com/?Param2=v2&Param1=v1' })
check('query order does not change the signature', a.signature === b.signature,
  a.signature.slice(0, 16) + ' vs ' + b.signature.slice(0, 16))
const c = signRequest({ ...VANILLA, url: 'https://example.amazonaws.com/?Param1=vX&Param2=v2' })
check('but a different value does', c.signature !== a.signature)

check('a default port is not part of the signed host',
  signRequest({ ...VANILLA, url: 'https://example.amazonaws.com:443/' }).signature === vanilla.signature)

const token = signRequest({ ...VANILLA, sessionToken: 'SESSION' })
check('a session token joins the signed headers',
  token.headers.Authorization.includes('x-amz-security-token') &&
    token.headers['x-amz-security-token'] === 'SESSION',
  token.headers.Authorization.split('SignedHeaders=')[1].split(',')[0])

const plainPut = signRequest({
  method: 'PUT',
  url: 'https://examplebucket.s3.amazonaws.com/obj',
  body: 'payload',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
  amzDate: '20150830T123600Z'
})
check('x-amz-content-sha256 is only signed when asked for',
  !plainPut.headers.Authorization.includes('x-amz-content-sha256'))

/*
 * The cases that bite in practice: a key with a space, a slash and a unicode
 * character. They must be encoded exactly once, and the same way in the path and
 * in the signature.
 */
const odd = signRequest({
  ...VANILLA,
  method: 'GET',
  url: 'https://example.amazonaws.com/buck et/a+b/中文.txt'
})
check('odd keys are encoded in the canonical path',
  odd.canonicalRequest.split('\n')[1] === '/buck%20et/a%2Bb/%E4%B8%AD%E6%96%87.txt',
  odd.canonicalRequest.split('\n')[1])

check('a body changes the signature',
  signRequest({ ...VANILLA, method: 'POST', body: '{"k":"v"}' }).signature !== vanilla.signature)

// ---- the client against a mock S3 ----------------------------------------
/*
 * The signer being spec-correct is necessary, not sufficient: the usual real bug
 * is the *request* — a path the client signed and then sent differently, a
 * bucket in the wrong place, a header added after signing. So the mock server
 * rebuilds the canonical request from what actually arrived on the socket and
 * recomputes the signature with its own HMAC code. If the two disagree, the sign
 * that went out and the bytes that landed are not describing the same request.
 */
const { createHash, createHmac } = require('node:crypto')
const http = require('node:http')

function serverSignature(req, secret, payloadHash) {
  const auth = String(req.headers.authorization || '')
  const matched = /Credential=[^/]+\/\d{8}\/[^/]+\/[^/]+\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth)
  if (!matched) return null
  const signedHeaders = matched[1]
  const names = signedHeaders.split(';')
  const canonicalHeaders = names
    .map((name) => `${name}:${String(req.headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  // The path arrived already encoded; re-encoding it here would hide a
  // double-encoding bug in the client, so it is used exactly as received.
  const [pathOnly, searchOnly] = String(req.url).split('?')
  const query = (searchOnly || '')
    .split('&')
    .filter(Boolean)
    .map((pair) => pair.split('='))
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value ?? ''}`)
    .join('&')
  const canonicalRequest = [
    req.method,
    pathOnly || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')
  /*
   * The credential scope is date/region/service/aws4_request. The regex captures
   * only the first three, and leaving off the terminator derives a different
   * signing key — which is exactly the kind of thing this check exists to catch,
   * so it caught itself first.
   */
  const scope =
    /\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request/.exec(auth).slice(1).join('/') + '/aws4_request'
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    req.headers['x-amz-date'],
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n')
  const date = scope.split('/')[0]
  const kDate = createHmac('sha256', 'AWS4' + secret).update(date).digest()
  const kRegion = createHmac('sha256', kDate).update(scope.split('/')[1]).digest()
  const kService = createHmac('sha256', kRegion).update(scope.split('/')[2]).digest()
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
  return createHmac('sha256', kSigning).update(stringToSign).digest('hex')
}

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
const requests = []
const mock = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const payloadHash = req.headers['x-amz-content-sha256'] || createHash('sha256').update(body).digest('hex')
    const expected = serverSignature(req, SECRET, payloadHash)
    requests.push({
      method: req.method,
      url: req.url,
      signatureOk: expected !== null && String(req.headers.authorization).includes(`Signature=${expected}`)
    })
    const xml = (text) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(text)
    }
    if (req.url.startsWith('/b1?') || req.url === '/b1') {
      xml(
        '<ListBucketResult><Name>b1</Name><Prefix>dir/</Prefix><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>dir/a.txt</Key><Size>5</Size><LastModified>2024-01-02T03:04:05.000Z</LastModified></Contents>' +
          '<Contents><Key>dir/b.txt</Key><Size>9</Size><LastModified>2024-01-02T03:04:06.000Z</LastModified></Contents>' +
          '<CommonPrefixes><Prefix>dir/sub/</Prefix></CommonPrefixes></ListBucketResult>'
      )
      return
    }
    if (req.url === '/' && req.method === 'GET') {
      xml(
        '<ListAllMyBucketsResult><Buckets>' +
          '<Bucket><Name>alpha</Name><CreationDate>2023-05-01T00:00:00.000Z</CreationDate></Bucket>' +
          '<Bucket><Name>beta</Name><CreationDate>2023-06-01T00:00:00.000Z</CreationDate></Bucket>' +
          '</Buckets></ListAllMyBucketsResult>'
      )
      return
    }
    if (req.url === '/b1/a.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello s3')
      return
    }
    if (req.url === '/b1/missing.txt') {
      res.writeHead(404, { 'Content-Type': 'application/xml' })
      res.end('<Error><Code>NoSuchKey</Code><Message>The key does not exist.</Message></Error>')
      return
    }
    if (req.url === '/b1/new.txt' && req.method === 'PUT') {
      xml('<PutObjectResult/>')
      return
    }
    res.writeHead(400, { 'Content-Type': 'application/xml' })
    res.end('<Error><Code>Unexpected</Code><Message>' + req.method + ' ' + req.url + '</Message></Error>')
  })
})

async function clientChecks() {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const { S3Client, S3Error } = require(outfile)
  const endpoint = 'http://127.0.0.1:' + mock.address().port
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: SECRET,
    pathStyle: true
  })

  const buckets = await client.listBuckets()
  check('listBuckets parses the response', buckets.length === 2 && buckets[0].name === 'alpha',
    buckets.map((b) => b.name).join(','))

  const listing = await client.listObjects('b1', { prefix: 'dir/', delimiter: '/' })
  check('listObjects parses objects and prefixes',
    listing.objects.length === 2 && listing.objects[0].key === 'dir/a.txt' &&
      listing.prefixes[0] === 'dir/sub/' && listing.truncated === false,
    'objects=' + listing.objects.length + ' prefixes=' + listing.prefixes.join(','))

  const object = await client.getObject('b1', 'a.txt')
  check('getObject returns the body', object.body === 'hello s3', object.body)

  await client.putObject('b1', 'new.txt', '{"a":1}', 'application/json')
  check('putObject sends the body', requests.some((r) => r.method === 'PUT' && r.url === '/b1/new.txt'))

  let error = null
  try {
    await client.getObject('b1', 'missing.txt')
  } catch (err) {
    error = err
  }
  check('a failed call surfaces the S3 error code',
    error instanceof S3Error && error.code === 'NoSuchKey' && error.status === 404,
    error ? error.code + ' ' + error.status : 'no error')

  /*
   * The one that would otherwise show up as "403 from the customer's MinIO":
   * every single request the mock saw must have carried a signature it could
   * reproduce from the bytes it received.
   */
  const bad = requests.filter((entry) => !entry.signatureOk)
  check('every request signed correctly, as recomputed by the server',
    requests.length >= 5 && bad.length === 0,
    bad.length === 0
      ? requests.length + ' requests verified'
      : bad.map((entry) => entry.method + ' ' + entry.url).join(', '))
}

// ---- report --------------------------------------------------------------

clientChecks()
  .catch((err) => check('the mock S3 run completed', false, String((err && err.message) || err)))
  .then(() => {
    const failed = checks.filter((entry) => !entry.ok)
    for (const entry of only ? checks.filter((e) => e.name.includes(only)) : checks) {
      console.log(
        `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ' — ' + entry.detail : ''}`
      )
    }
    console.log(`\n${checks.length - failed.length}/${checks.length} signing checks passed`)

    mock.close()
    rmSync(dir, { recursive: true, force: true })
    process.exit(failed.length === 0 ? 0 : 1)
  })
