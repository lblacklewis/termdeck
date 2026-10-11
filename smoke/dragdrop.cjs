/**
 * Drag and drop: moving a host between groups, on both pages that list them.
 *
 *   npm run build && electron smoke/dragdrop.cjs --user-data-dir=...
 *
 * "Servers cannot be dragged any more" has several possible causes and none of
 * them is visible: the row may not be draggable, the drag may never reach the
 * handler, or the drop target may refuse the drop — in which case the browser
 * never fires `drop` at all and the whole gesture silently does nothing.
 *
 * So each link in the chain is asserted separately, and the final state of the
 * tree is what decides whether it worked.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
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

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.storeAccess().layout.clear()

  mod.storeAccess().sessions.upsertFolder({ name: 'prod' })
  mod.storeAccess().sessions.upsertFolder({ name: 'staging' })
  mod.storeAccess().sessions.upsertSession({
    name: 'loose-host', host: '10.9.9.9', port: 22, username: 'root',
    authMethod: 'password', parentId: null, tags: []
  })
  const prodFolder = mod.storeAccess().sessions.load().folders.find((f) => f.name === 'prod')
  mod.storeAccess().sessions.upsertSession({
    name: 'inside-prod', host: '10.8.8.8', port: 22, username: 'root',
    authMethod: 'password', parentId: prodFolder.id, tags: []
  })

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript(`localStorage.setItem('tdDebug','1'); true`)
  await win.reload()
  await sleep(3000)

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      let step = 'start'
      try {

      const dragOnto = async (from, to) => {
        const dt = new DataTransfer()
        const fire = (el, type) => {
          const ev = new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, dataTransfer: dt
          })
          el.dispatchEvent(ev)
          return ev.defaultPrevented
        }
        const result = { started: fire(from, 'dragstart') }
        await wait(150)
        result.entered = fire(to, 'dragenter')
        result.over = fire(to, 'dragover')
        await wait(150)
        result.dropped = fire(to, 'drop')
        await wait(1000)
        fire(from, 'dragend')
        return result
      }

      // ---- 1. the sidebar tree (Terminal page) -----------------------------
      step = 'tree'
      const rowByName = (name) =>
        [...document.querySelectorAll('.td-node[data-node-kind="session"]')]
          .find((n) => (n.textContent || '').includes(name))
      const folderByName = (name) =>
        [...document.querySelectorAll('.td-node-folder')]
          .find((n) => (n.textContent || '').includes(name))

      const loose = rowByName('loose-host')
      const staging = folderByName('staging')
      push('the tree has a draggable session row', !!loose,
        loose ? 'draggable=' + loose.getAttribute('draggable') : 'not found')
      push('the tree has a folder row to drop onto', !!staging)
      push('the session row is marked draggable',
        !!loose && loose.getAttribute('draggable') === 'true',
        loose ? String(loose.getAttribute('draggable')) : '-')
      push('the folder row is marked draggable (it is also a drag source)',
        !!staging && staging.getAttribute('draggable') === 'true',
        staging ? String(staging.getAttribute('draggable')) : '-')

      if (loose && staging) {
        const chain = await dragOnto(loose, staging)
        push('dragstart reaches the row (not cancelled)', !chain.started,
          JSON.stringify(chain))
        push('the folder accepts the drag (dragenter and dragover cancel the default)',
          chain.entered && chain.over, JSON.stringify(chain))

        const tree = await window.termdeck.loadSessionTree()
        const moved = tree.sessions.find((s) => s.name === 'loose-host')
        const target = tree.folders.find((f) => f.name === 'staging')
        push('dropping a host on a folder re-files it',
          !!moved && moved.parentId === target.id,
          'parent=' + (moved ? String(moved.parentId).slice(0, 8) : '-') +
            ' expected=' + target.id.slice(0, 8))
      }

      // ---- 2. dragging a folder onto another folder -----------------------
      step = 'folder'
      const prod = folderByName('prod')
      if (prod && staging) {
        const chain = await dragOnto(prod, staging)
        push('a folder can be dragged onto another folder',
          !chain.started && chain.entered && chain.over, JSON.stringify(chain))
        const tree = await window.termdeck.loadSessionTree()
        const movedFolder = tree.folders.find((f) => f.name === 'prod')
        const target = tree.folders.find((f) => f.name === 'staging')
        push('the dragged folder is nested under the target',
          !!movedFolder && movedFolder.parentId === target.id,
          'parent=' + (movedFolder ? String(movedFolder.parentId).slice(0, 8) : '-'))
        await window.termdeck.moveFolder(movedFolder.id, null)
        await wait(700)
      }

      // ---- 3. the Hosts page ---------------------------------------------
      step = 'hosts'
      document.querySelector('[data-testid="rail-hosts"]').click()
      await wait(1200)

      const hostRow = [...document.querySelectorAll('[data-host-row]')].find((r) =>
        /loose-host/.test(r.textContent || '')
      )
      // Drop onto a *different* group than the one the host is already in, or the
      // drop would be a no-op and the assertion would prove nothing. "Unfiled" is
      // where an ungrouped host starts, so a named group is the target.
      // The drop handlers are on the group section, whose own attribute is the
      // group's label (the header carries the testid; the section carries the
      // drop zone).
      const groupSection = [...document.querySelectorAll('[data-host-group]')].find(
        (s) => s.getAttribute('data-host-group') === 'staging'
      )
      push('the hosts page has a draggable host row', !!hostRow,
        hostRow ? 'draggable=' + hostRow.getAttribute('draggable') : 'not found')
      push('the host row is marked draggable',
        !!hostRow && hostRow.getAttribute('draggable') === 'true')
      push('the hosts page has a target group to drop onto', !!groupSection,
        groupSection
          ? 'group=' + String(groupSection.getAttribute('data-host-group'))
          : 'none; groups=[' +
            [...document.querySelectorAll('[data-host-group]')]
              .map((s) => s.getAttribute('data-host-group')).join(' | ') +
            ']')

      if (hostRow && groupSection) {
        const hostId = hostRow.getAttribute('data-host-row')
        const groupLabel = String(groupSection.getAttribute('data-host-group') || '')
        const chain = await dragOnto(hostRow, groupSection)
        push('dragstart reaches the hosts row (not cancelled)', !chain.started,
          JSON.stringify(chain))
        push('the hosts group accepts the drag (dragenter and dragover)',
          chain.entered && chain.over, JSON.stringify(chain))

        const tree = await window.termdeck.loadSessionTree()
        const moved = tree.sessions.find((s) => s.id === hostId)
        const target = groupLabel === 'Unfiled'
          ? null
          : (tree.folders.find((f) => groupLabel.includes(f.name)) || null)
        const expected = target ? target.id : null
        push('dropping onto a group in the list re-files the host',
          !!moved && moved.parentId === expected,
          'group=' + groupLabel +
            ' parent=' + (moved ? String(moved.parentId).slice(0, 8) : '-') +
            ' expected=' + (expected ? expected.slice(0, 8) : 'null'))
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
    report([{ name: 'drag probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('drag probe crashed:', err)
    app.exit(1)
  })
)
