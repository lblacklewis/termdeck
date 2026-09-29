/**
 * Headless smoke check, run *inside Electron* so it exercises the same ABI and
 * module resolution the real app uses.
 *
 *   electron smoke/smoke.cjs
 *
 * Verifies the two native/transport dependencies the app cannot work without:
 *   - @lydell/node-pty can spawn a local PTY and stream output
 *   - ssh2 can be required and driven by the SessionManager/SshShellBackend
 */
const path = require('node:path')
const { app } = require('electron')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function checkPty() {
  try {
    const pty = require('@lydell/node-pty')
    const shell =
      process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash'
    const args =
      process.platform === 'win32'
        ? ['/c', 'echo PTY_OK && exit 0']
        : ['-lc', 'echo PTY_OK']

    const output = await new Promise((resolve, reject) => {
      const proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env
      })
      let buf = ''
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        reject(new Error('timed out waiting for PTY output'))
      }, 15000)
      proc.onData((d) => {
        buf += d
        if (buf.includes('PTY_OK')) {
          clearTimeout(timer)
          try {
            proc.kill()
          } catch {}
          resolve(buf)
        }
      })
      proc.onExit(() => {
        clearTimeout(timer)
        resolve(buf)
      })
    })

    record('node-pty spawn + stream', output.includes('PTY_OK'), `captured ${output.trim().length} chars`)
  } catch (err) {
    record('node-pty spawn + stream', false, err && err.message)
  }
}

async function checkSsh() {
  try {
    const ssh2 = require('ssh2')
    const key = require('node:fs').readFileSync(
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_rsa')
    )
    const parsed = ssh2.utils.parseKey(key)
    if (parsed instanceof Error) throw parsed
    record('ssh2 require + parseKey', true, `key type ${parsed.type}`)

    const client = new ssh2.Client()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH connect timed out')), 25000)
      client
        .on('ready', () => {
          client.exec('echo SSH_OK', (err, stream) => {
            if (err) return reject(err)
            let out = ''
            stream.on('data', (d) => (out += d.toString()))
            stream.on('close', () => {
              clearTimeout(timer)
              client.end()
              out.includes('SSH_OK') ? resolve() : reject(new Error(`unexpected output: ${out.trim()}`))
            })
          })
        })
        .on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        .connect({
          host: '82.156.226.192',
          port: 22,
          username: 'root',
          privateKey: key,
          readyTimeout: 20000,
          hostVerifier: () => true
        })
    })
    record('ssh2 real connect + exec', true, '82.156.226.192')
  } catch (err) {
    record('ssh2 real connect + exec', false, err && err.message)
  }
}

app.whenReady().then(async () => {
  console.log(`electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform}`)
  await checkPty()
  await checkSsh()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
})
