/**
 * Focused diagnostic for the blank-SSH-terminal symptom.
 *
 *   electron smoke/sshdata.cjs
 *
 * Drives the same SshShellBackend the app uses and reports every event, so we
 * can tell whether ssh2 itself is emitting, or whether the loss happens later.
 */
const path = require('node:path')
const os = require('node:os')
const { app } = require('electron')

const ROOT = path.join(__dirname, '..')
const HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const USER = process.env.TD_SSH_USER || 'root'
const KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')

app.whenReady().then(async () => {
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))

  const t0 = Date.now()
  const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`

  const info = await mod.sessionManager.create(
    (_id, cols, rows) =>
      Promise.resolve(
        new mod.SshShellBackend(
          {
            host: HOST,
            port: 22,
            username: USER,
            auth: { privateKeyPath: KEY },
            // This harness checks streaming and replay, not host-key policy, so
            // it trusts the host rather than depending on the user's known_hosts.
            hostKeyPolicy: 'trust'
          },
          cols,
          rows,
          { knownHosts: new mod.KnownHosts(), resolveSecret: () => null }
        )
      ),
    { kind: 'ssh', title: `probe ${USER}@${HOST}` },
    80,
    24
  )
  console.log(`${stamp()} session created: ${info.id}`)

  let chunks = 0
  let bytes = 0

  mod.sessionManager.on('data', (id, chunk, seq) => {
    chunks += 1
    bytes += chunk.length
    if (chunks <= 6) {
      console.log(`${stamp()} data seq=${seq} len=${chunk.length} ${JSON.stringify(chunk.slice(0, 70))}`)
    }
  })
  mod.sessionManager.on('error', (id, message) => console.log(`${stamp()} ERROR ${message}`))
  mod.sessionManager.on('exit', (id, code, signal) => {
    console.log(`${stamp()} EXIT code=${code} signal=${signal}`)
    console.log(`\ntotals: chunks=${chunks} bytes=${bytes}`)
    const replay = mod.sessionManager.replay(id)
    console.log(`replay after exit: ${replay ? JSON.stringify(replay.data.slice(0, 80)) : 'null'}`)
    app.exit(bytes > 0 ? 0 : 1)
  })

  // Success is measured by real shell output, not by the session ending:
  // an interactive shell stays open indefinitely.
  setTimeout(async () => {
    console.log(`${stamp()} ${chunks} chunks so far — writing 'echo HELLO_FROM_PROBE\\n'`)
    mod.sessionManager.write(info.id, 'echo HELLO_FROM_PROBE\n')
    const replay = mod.sessionManager.replay(info.id)
    console.log(`${stamp()} replay len=${replay ? replay.data.length : 'null'} seq=${replay ? replay.seq : '-'}`)

    setTimeout(() => {
      // Re-read at check time: the echo reply arrives after the first read.
      const final = mod.sessionManager.replay(info.id)
      const text = final ? final.data : ''
      const ok = chunks >= 3 && /Welcome to Ubuntu/.test(text) && /HELLO_FROM_PROBE/.test(text)
      console.log(
        `\n${stamp()} RESULT chunks=${chunks} bytes=${bytes} ` +
          `banner=${/Welcome to Ubuntu/.test(text)} ` +
          `echo=${/HELLO_FROM_PROBE/.test(text)}`
      )
      mod.sessionManager.disposeAll()
      app.exit(ok ? 0 : 1)
    }, 3000)
  }, 6000)
})
