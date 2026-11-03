/**
 * The real-SSH suites need a fixture that only exists on a machine set up for it:
 * a private key at `~/.ssh/id_rsa` (override with `TD_SSH_KEY`) and a route to the
 * test host below. Without both, every one of those suites dies at the connect step
 * and the whole gate looks red for a reason that has nothing to do with the code —
 * which is exactly what happened the first time this repo was opened on a Mac.
 *
 * Usage, at the top of a suite's `main()`:
 *
 *   if (await sshFixture.skipped('duplicate')) { app.exit(0); return }
 *
 * A skip is not a pass: it prints a loud SKIP line with the reason and how to set the
 * fixture up, so `npm run verify` can be green on a machine that legitimately cannot
 * run these, without anyone believing they ran.
 *
 * The target is the test box the suites already point at — NOT an sshd on this
 * machine, which is what the first version of this file wrongly assumed.
 */
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

/** The real host the SSH suites connect to (the made-up ones are negative cases). */
const HOST = '82.156.226.192'
const PORT = 22

/** Where the test private key is expected to live. */
function sshKeyPath() {
  return process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host, port: port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    // Generous next to a healthy handshake (a few ms) and short next to the 20s ssh2
    // readyTimeout: only reached when the key exists, so an unreachable host costs a
    // few seconds per suite instead of a run full of connection errors.
    socket.setTimeout(3000)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

/** Human-readable reason the fixture is unusable, or null when it looks fine. */
async function sshFixtureProblem() {
  const key = sshKeyPath()
  if (!fs.existsSync(key)) return 'no private key at ' + key
  const listening = await canConnect(HOST, PORT)
  if (!listening) return 'cannot reach the test host ' + HOST + ':' + PORT
  return null
}

/** Print the SKIP block and return true when the suite cannot run here. */
async function skipped(suite) {
  const problem = await sshFixtureProblem()
  if (!problem) return false
  console.log('SKIP  smoke:' + suite + ' — ' + problem)
  console.log('      this suite drives a real SSH session against ' + HOST + '; give it a test key')
  console.log('      at ~/.ssh/id_rsa (or TD_SSH_KEY=<path>), then rerun.')
  return true
}

module.exports = {
  HOST: HOST,
  PORT: PORT,
  sshKeyPath: sshKeyPath,
  sshFixtureProblem: sshFixtureProblem,
  skipped: skipped
}
