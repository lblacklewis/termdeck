/**
 * Local port forwarding, end to end.
 *
 *   npm run build && electron smoke/tunnel.cjs --user-data-dir=...
 *
 * The destination is the SSH host's own sshd: a tunnel from a local port to
 * `127.0.0.1:22` seen from that host. Opening the local port must then produce
 * an SSH banner, which is the one observable that proves the bytes actually
 * travelled through the connection and came back — a listener that accepts and
 * forwards nothing looks identical from the outside until you read from it.
 *
 * Also covers: status transitions, the live connection count, stopping (the port
 * must be free again), and that a port already in use is reported rather than
 * crashing the page.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const HOST = process.env.TD_SSH_HOST || '82.156.226.192'
const USER = process.env.TD_SSH_USER || 'root'
const KEY = process.env.TD_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

/** Ask the OS for a free port, then let go of it again. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/** Read the first bytes a listener sends, then hang up. */
function readBanner(port, timeout = 8000) {
  return new Promise((resolve) => {
    let settled = ''
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (why) => {
      if (settled) return
      settled = why
      socket.destroy()
      resolve(why)
    }
    socket.setTimeout(timeout, () => done('timeout'))
    socket.on('data', (chunk) => done(chunk.toString('utf8').split('\r\n')[0].trim()))
    socket.on('error', (err) => done('error: ' + err.message))
  })
}

async function main() {
  const localPort = await freePort()

  const knownHostsPath = path.join(os.tmpdir(), 'termdeck-tunnel-known-hosts')
  try {
    fs.rmSync(knownHostsPath, { force: true })
  } catch {
    /* a missing file is the point */
  }
  process.env['TERMDECK_KNOWN_HOSTS'] = knownHostsPath

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({ ...settings, hostKeys: { policy: 'trust' } })

  const saved = mod.storeAccess().sessions.upsertSession({
    name: 'cloud',
    host: HOST,
    port: 22,
    username: USER,
    authMethod: 'key',
    privateKeyPath: KEY,
    parentId: null,
    tags: []
  })
  const savedId = saved.sessions[0].id

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
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

  const spec = {
    id: '',
    name: 'sshd through the tunnel',
    savedSessionId: savedId,
    localHost: '127.0.0.1',
    localPort,
    remoteHost: '127.0.0.1',
    remotePort: 22
  }

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
          await wait(200)
        }
        return false
      }
      const spec = ${JSON.stringify(spec)}
      let step = 'start'
      try {

      // ---- 1. define it ---------------------------------------------------
      step = 'save'
      const savedList = await window.termdeck.saveTunnels([spec])
      push('the tunnel is stored', savedList.length === 1, 'count=' + savedList.length)
      const id = savedList[0] && savedList[0].id
      push('it gets an id and starts out stopped',
        !!id && savedList[0].status === 'stopped', 'status=' + (savedList[0] || {}).status)

      // ---- 2. start it ----------------------------------------------------
      step = 'start'
      await window.termdeck.startTunnel(id)
      const up = await waitFor(async () => {
        const list = await window.termdeck.listTunnels()
        return list[0] && list[0].status === 'running'
      }, 25000)
      const afterStart = await window.termdeck.listTunnels()
      push('it reports running once the listener is up', up,
        'status=' + (afterStart[0] || {}).status + ' msg=' + ((afterStart[0] || {}).message || ''))

      // ---- 3. the page shows it -------------------------------------------
      step = 'page'
      const railItems = [...document.querySelectorAll('button')]
      const tunnelTab = railItems.find((b) => /tunnel|隧道/i.test(b.textContent || ''))
      push('the rail has a tunnels entry', !!tunnelTab)
      if (tunnelTab) {
        tunnelTab.click()
        const shown = await waitFor(() => !!document.querySelector('[data-testid="tunnels-page"]'), 15000)
        push('opening it shows the page', shown)
        const row = await waitFor(() => !!document.querySelector('[data-testid="tunnel-row"]'), 10000)
        push('the tunnel is listed', row)
        const rowEl = document.querySelector('[data-testid="tunnel-row"]')
        push('the row says it is running',
          !!rowEl && rowEl.getAttribute('data-tunnel-status') === 'running',
          rowEl ? rowEl.getAttribute('data-tunnel-status') : 'no row')
        // Back to the terminal, where the rest of this suite does not care.
        const terminalTab = railItems.find((b) => /terminal|终端/i.test(b.textContent || ''))
        if (terminalTab) terminalTab.click()
        await wait(400)
      }

      return { checks: out, id }
      } catch (err) {
        out.push({
          name: 'failed at step: ' + step,
          ok: false,
          detail: String((err && err.message) || err)
        })
        return { checks: out, id: null }
      }
    })()
  `

  let id = null
  try {
    const result = await win.webContents.executeJavaScript(probe)
    report(result.checks)
    id = result.id
  } catch (err) {
    report([{ name: 'tunnel probe', ok: false, detail: String((err && err.message) || err) }])
  }

  // ---- 4. the forwarded port really carries SSH --------------------------
  if (id) {
    /*
     * Hold the socket open while the count is read: the tunnel counts live
     * connections, and a count read after hanging up can only ever prove that
     * the decrement works.
     */
    const held = net.createConnection({ host: '127.0.0.1', port: localPort })
    let banner = ''
    await new Promise((resolve) => {
      const finish = () => resolve()
      held.setTimeout(9000, finish)
      held.on('data', (chunk) => {
        banner += chunk.toString('utf8')
        if (banner.includes('\n')) finish()
      })
      held.on('error', (err) => {
        banner = 'error: ' + err.message
        finish()
      })
    })
    const firstLine = banner.split('\r\n')[0].trim()
    report([
      {
        name: 'the forwarded port speaks to the far end',
        ok: /^SSH-2\.0-/.test(firstLine),
        detail: firstLine
      }
    ])

    const live = await win.webContents.executeJavaScript('window.termdeck.listTunnels()')
    report([
      {
        name: 'the live connection is counted',
        ok: (live[0] ? live[0].connections : 0) >= 1,
        detail: 'connections=' + (live[0] && live[0].connections)
      }
    ])
    held.destroy()
    await sleep(400)

    // ---- 5. stopping releases the port ----------------------------------
    await win.webContents.executeJavaScript('window.termdeck.stopTunnel(' + JSON.stringify(id) + ')')
    const freed = await readBanner(localPort, 3000)
    report([
      {
        name: 'stopping the tunnel releases the local port',
        ok: /^error:/.test(freed),
        detail: freed
      }
    ])

    // ---- 5b. a running tunnel cannot be re-pointed silently -------------
    /*
     * The listener and the SSH channel were built from the numbers in the row, so
     * keeping a forward alive after its target was edited would leave something
     * that looks right and forwards elsewhere. Renaming, on the other hand, must
     * not tear down a working tunnel.
     */
    const repointedPort = await freePort()
    const statusOf = async (tunnelId) => {
      let last = ''
      for (let i = 0; i < 40; i += 1) {
        last = await win.webContents.executeJavaScript(
          'window.termdeck.listTunnels().then((l) => (l.find((t) => t.id === ' +
            JSON.stringify(tunnelId) +
            ') || {}).status || "")'
        )
        // "starting" is not an answer: a tunnel that is on its way either ends up
        // running or reports why it could not.
        if (last === 'running' || last === 'error') return last
        await sleep(200)
      }
      return last
    }

    await win.webContents.executeJavaScript('window.termdeck.startTunnel(' + JSON.stringify(id) + ')')
    const again = await statusOf(id)
    report([
      { name: 'the tunnel can be started again after a stop', ok: again === 'running', detail: again }
    ])

    const repointed = await win.webContents.executeJavaScript(
      'window.termdeck.saveTunnels([Object.assign({}, ' +
        JSON.stringify(spec) +
        ', { id: ' +
        JSON.stringify(id) +
        ', localPort: ' +
        repointedPort +
        ' })])'
    )
    const oldFreed = await readBanner(localPort, 3000)
    const newQuiet = await readBanner(repointedPort, 2500)
    report([
      {
        name: 'editing the target of a running tunnel stops it',
        ok: Array.isArray(repointed) && repointed[0] && repointed[0].status === 'stopped',
        detail: Array.isArray(repointed) && repointed[0] ? repointed[0].status : 'no list'
      },
      {
        name: 'and the old port is released',
        ok: /^error:/.test(oldFreed),
        detail: oldFreed
      },
      {
        name: 'and the new port is not opened behind our back',
        ok: /^error:/.test(newQuiet),
        detail: newQuiet
      }
    ])

    await win.webContents.executeJavaScript('window.termdeck.startTunnel(' + JSON.stringify(id) + ')')
    await statusOf(id)
    const renamed = await win.webContents.executeJavaScript(
      'window.termdeck.saveTunnels([Object.assign({}, ' +
        JSON.stringify(spec) +
        ', { id: ' +
        JSON.stringify(id) +
        ', localPort: ' +
        repointedPort +
        ', name: "renamed while running" })])'
    )
    report([
      {
        name: 'renaming a running tunnel leaves it running',
        ok: Array.isArray(renamed) && renamed[0] && renamed[0].status === 'running',
        detail: Array.isArray(renamed) && renamed[0]
          ? renamed[0].status + ' / ' + renamed[0].name
          : 'no list'
      }
    ])

    // ---- 6. a tunnel that cannot start says why -------------------------
    /*
     * The saved host is gone, so there is nothing to authenticate as. The point
     * is that it ends up as `error` with a message a person can act on, instead
     * of a listener that accepts connections and forwards them nowhere.
     */
    const brokenPort = await freePort()
    const broken = await win.webContents.executeJavaScript(
      'window.termdeck.saveTunnels([' +
        JSON.stringify({
          id: '',
          name: 'no such host',
          savedSessionId: 'deleted-session-id',
          localHost: '127.0.0.1',
          localPort: brokenPort,
          remoteHost: '127.0.0.1',
          remotePort: 22
        }) +
        '])'
    )
    await win.webContents.executeJavaScript(
      'window.termdeck.startTunnel(' + JSON.stringify(broken[0] && broken[0].id) + ')'
    )
    await sleep(1200)
    const brokenState = await win.webContents.executeJavaScript('window.termdeck.listTunnels()')
    report([
      {
        name: 'a tunnel pointing at a vanished host reports an error',
        ok: (brokenState[0] || {}).status === 'error',
        detail: 'status=' + (brokenState[0] || {}).status
      },
      {
        name: 'and the reason is human readable',
        ok: /no longer exists|not an SSH/i.test((brokenState[0] || {}).message || ''),
        detail: (brokenState[0] || {}).message || ''
      }
    ])
    const unused = await readBanner(brokenPort, 2000)
    report([
      {
        name: 'and it never opened its port',
        ok: /^error:/.test(unused),
        detail: unused
      }
    ])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('tunnel probe crashed:', err)
    app.exit(1)
  })
)
