/**
 * Telnet and "commands to run after login", end to end.
 *
 *   npm run build && electron smoke/transport.cjs --user-data-dir=...
 *
 * The far end is a real TCP server started by this probe, so nothing here is
 * simulated: it sends telnet negotiation the way a switch does, prints a banner,
 * records every byte the app sends, and echoes input so the pane has something
 * to paint.
 *
 * What it pins down:
 *   - a saved entry with `kind: 'telnet'` connects over telnet, not SSH;
 *   - the option parser answers the negotiation (window size / terminal type)
 *     instead of leaking those bytes into the terminal as garbage;
 *   - `postConnectCommands` are typed in on their own after the session is up;
 *   - typing still reaches the far end afterwards.
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const net = require('node:net')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

/** Bytes the server has received, as latin1 so control bytes stay readable. */
let received = ''
let connections = 0
let server = null

function report(checks) {
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`
    )
    all.push(c)
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = net.createServer((socket) => {
      connections += 1
      socket.setNoDelay(true)
      socket.on('data', (chunk) => {
        const text = chunk.toString('latin1')
        received += text
        /*
         * Echo printable input back so the pane has output to show.
         *
         * Only ASCII: the client's own negotiation arrives here too, and echoing
         * those bytes would send them back as UTF-8 (0xFF becomes 0xC3 0xBF) and
         * paint mojibake in the pane — an artefact of this fake server, not of
         * the client.
         */
        const printable = text.replace(/[^\x20-\x7e\r\n]/g, '')
        if (printable.trim()) socket.write('ECHO:' + printable.replace(/\r/g, '') + '\r\n')
      })
      /*
       * Ask for the two options a terminal client should answer, then greet.
       * IAC DO NAWS / IAC WILL ECHO / IAC DO TTYPE — exactly the shape a
       * network switch opens with.
       */
      socket.write(Buffer.from([255, 253, 31]))
      socket.write(Buffer.from([255, 251, 1]))
      socket.write(Buffer.from([255, 253, 24]))
      socket.write('Welcome to the test switch\r\nswitch> ')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function main() {
  const port = await startServer()
  console.log(`telnet test server on 127.0.0.1:${port}`)

  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  const settings = mod.storeAccess().settings.load()
  mod.storeAccess().settings.save({ ...settings, hostKeys: { policy: 'trust' } })

  mod.storeAccess().sessions.upsertSession({
    name: 'switch',
    host: '127.0.0.1',
    port,
    username: '',
    authMethod: 'password',
    kind: 'telnet',
    postConnectCommands: ['show version'],
    parentId: null,
    tags: []
  })

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
  await sleep(300)

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
      const sessions = () => window.termdeck.listSessions()
      const rows = () => [...document.querySelectorAll('.td-node[data-node-kind="session"]')]
      const dbl = (el) =>
        el.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, composed: true, detail: 2
        }))
      const paneText = () => {
        const rows = [...document.querySelectorAll('.xterm-rows')]
        return rows.map((r) => r.textContent || '').join('\\n')
      }

      let step = 'start'
      try {

      const row = rows().find((n) => (n.textContent || '').includes('switch'))
      push('the telnet entry is in the sidebar', !!row)
      if (!row) return out
      dbl(row.querySelector('.td-node-main'))

      const up = await waitFor(async () => (await sessions()).length > 0, 15000)
      push('the entry connects', up)
      if (!up) return out
      const info = (await sessions())[0]
      push('it is a telnet session, not ssh', info.kind === 'telnet', 'kind=' + info.kind)

      const painted = await waitFor(() => paneText().includes('Welcome to the test switch'), 15000)
      push('the banner reaches the terminal', painted, paneText().slice(0, 120))

      // The parser must swallow negotiation instead of painting it.
      push('no telnet control bytes leak into the screen',
        !/[\\u0000-\\u0008\\u000b-\\u001f]/.test(paneText()))

      // ---- post-connect commands ----------------------------------------
      const got = () => window.__tdTransportReceived || ''
      const sent = await waitFor(() => got().includes('show version'), 15000)
      push('the post-connect command was typed in on its own', sent, got().slice(-80))

      // ---- normal typing still works ------------------------------------
      const id = info.id
      window.termdeck.writeSession(id, 'dir' + String.fromCharCode(13))
      const typed = await waitFor(() => got().includes('dir'), 8000)
      push('typing after that still reaches the far end', typed, got().slice(-80))

      // The client must have answered DO NAWS / WILL ECHO rather than ignoring
      // them: WILL NAWS is IAC WILL 31, which is what the parser sends back.
      push('the client agreed to report its window size',
        got().includes(String.fromCharCode(255, 251, 31)),
        got().split('').map((c) => c.charCodeAt(0)).filter((n) => n > 126).join(','))

      const echoed = await waitFor(() => paneText().includes('ECHO:dir'), 8000)
      push('and the far end replies on screen', echoed, paneText().slice(-160))

      // ---- the optional serial module is actually in this build ---------
      // Opening a port that does not exist is expected to fail; what matters is
      // *how* it fails. "unavailable" would mean serialport did not load into
      // the Electron process (a native-module rebuild problem), which is a very
      // different bug from "there is no COM255 on this machine".
      let serialError = ''
      let serialCreated = false
      try {
        const r = await window.termdeck.createSerialSession({ path: 'COM255', baudRate: 9600 })
        serialCreated = !!(r && r.ok)
      } catch (err) {
        serialError = String((err && err.message) || err)
      }
      push('the optional serial module loads in this build',
        serialCreated || !/unavailable/i.test(serialError),
        serialError || 'session created=' + serialCreated)
      if (serialCreated) {
        const list = await window.termdeck.listSessions()
        const s = list.find((x) => x.kind === 'serial')
        if (s) window.termdeck.closeSession(s.id)
        await wait(300)
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

  /*
   * Bridge: the socket lives here, the probe body runs in the page. Pushed every
   * 200 ms rather than exposed as a function, because the probe has to be able to
   * read it synchronously between awaits.
   */
  const bridge = setInterval(() => {
    const payload = JSON.stringify(received)
    win.webContents.executeJavaScript(`window.__tdTransportReceived = ${payload}; true`).catch(() => {})
  }, 200)

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'transport probe', ok: false, detail: String((err && err.message) || err) }])
  } finally {
    clearInterval(bridge)
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  if (server) server.close()
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('transport probe crashed:', err)
    app.exit(1)
  })
)
