const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { app } = require('electron')
app.whenReady().then(() => {
  const mod = require(path.join(__dirname, '..', 'out', 'main', 'smokeEntry.js'))
  const tmp = path.join(os.tmpdir(), 'td-rep-' + Date.now())
  fs.mkdirSync(tmp, { recursive: true })
  const khPath = path.join(tmp, 'known_hosts')
  const HOST = '82.156.226.192'

  const type = Buffer.from('ssh-ed25519')
  function b64(mat){ return Buffer.concat([Buffer.from([0,0,0,type.length]), type, Buffer.from([0,0,0,mat.length]), mat]).toString('base64') }
  const decoyData = b64(crypto.randomBytes(32))
  const liveData  = b64(crypto.randomBytes(32))   // stands in for the real server key

  // Exactly what the parent process plants.
  fs.writeFileSync(khPath, `${HOST} ssh-ed25519 ${decoyData}\n`, { mode: 0o600 })

  const kh = new mod.KnownHosts({ paths: [khPath] })
  console.log('find before trust   :', kh.find(HOST, 22).length)
  console.log('verify live (expect mismatch):', kh.verify(HOST, 22, `ssh-ed25519 ${liveData}`).status)

  kh.trust(HOST, 22, `ssh-ed25519 ${liveData}`)

  const lines = fs.readFileSync(khPath, 'utf8').trim().split('\n')
  console.log('\nlines after trust   :', lines.length)
  lines.forEach((l, i) => console.log(`  [${i}] ${l.startsWith('|1|') ? '<hashed>' : l.split(' ')[0]} ${(l.split(' ')[2]||'').slice(0,28)}`))
  console.log('\nfind after trust    :', kh.find(HOST, 22).length)
  console.log('verify live after   :', kh.verify(HOST, 22, `ssh-ed25519 ${liveData}`).status)
  console.log('decoy still present :', fs.readFileSync(khPath,'utf8').includes(decoyData))

  fs.rmSync(tmp, { recursive: true, force: true })
  app.exit(0)
})
