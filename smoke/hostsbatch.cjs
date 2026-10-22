/**
 * Batch operations on the Hosts page: check some hosts, delete / duplicate / move them.
 *
 *   npm run build && electron smoke/hostsbatch.cjs --user-data-dir=...
 *
 * The page could already do all three *one host at a time* (right-click menu, or drag
 * to another group). What is new is doing them to a selection, and a selection brings
 * three ways to be wrong that a single-host action cannot have:
 *
 *   1. the batch must act on exactly what was ticked — no more (nobody wants a
 *      mis-click to delete the group) and no less;
 *   2. delete has to ask first. One host is a mistake you can re-add; a ticked range
 *      is not, and there is no undo here;
 *   3. "select all" has to mean "all that is on screen". A folded group is not on
 *      screen, so ticking its hosts off-screen would turn a visible selection into a
 *      delete of things the user never saw.
 *
 * It also checks the two things the store must get right underneath: one write for the
 * whole batch (not one per host), and deleting a host taking its stored secret with it.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
    all.push(c)
  }
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()

  const sessions = mod.storeAccess().sessions
  const credentials = mod.storeAccess().credentials

  sessions.upsertFolder({ name: 'ops' })
  sessions.upsertFolder({ name: 'web' })
  const idOf = (name) =>
    (sessions.load().folders.find((f) => f.name === name) || {}).id || null
  sessions.upsertFolder({ name: 'canary', parentId: idOf('web') })

  const host = (name, parentId) =>
    sessions.upsertSession({
      name, host: '10.20.30.40', port: 22, username: 'deploy', authMethod: 'password',
      parentId: parentId || null, tags: []
    })

  host('db-1', idOf('ops'))
  host('db-2', idOf('ops'))
  host('web-1', idOf('web'))
  host('web-2', idOf('web'))
  host('canary-1', idOf('canary'))
  host('scratch-1', null)
  host('scratch-2', null)

  /*
   * Ids have to be read back out of the store: `upsertSession` — like
   * `upsertFolder` — commits the whole tree and returns *that*, not the new session.
   * Taking `.id` from its result yields `undefined`, every selector built from it
   * matches nothing, and the probe then fails for a reason that has nothing to do
   * with the feature.
   */
  const sessionId = (name) =>
    (sessions.load().sessions.find((s) => s.name === name) || {}).id || null
  const ids = {
    db1: sessionId('db-1'),
    web1: sessionId('web-1'),
    scratch1: sessionId('scratch-1'),
    scratch2: sessionId('scratch-2')
  }

  // A stored secret on one host, so "delete takes the secret with it" has something
  // real to check. Sealed the same way the editor seals it.
  credentials.set(ids.scratch1, { password: 'probe-secret' })

  const fixture = {
    ops: idOf('ops'),
    web: idOf('web'),
    canary: idOf('canary'),
    db1: ids.db1,
    web1: ids.web1,
    scratch1: ids.scratch1,
    scratch2: ids.scratch2
  }

  const win = new BrowserWindow({
    width: 1500,
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
  mod.attachFocusMode(win)

  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await win.webContents.executeJavaScript('localStorage.setItem("tdDebug","1"); true')
  await win.reload()
  await sleep(3000)

  const probe = `
    (async () => {
      const FIX = ${JSON.stringify(fixture)}
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const field = (id) => document.querySelector('[data-testid="' + id + '"]')

      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          const v = fn()
          if (v) return v
          await wait(150)
        }
        return null
      }

      /** The Hosts page is a rail section, so go there rather than assume it. */
      const rail = await waitFor(() => document.querySelector('[data-testid="rail-hosts"]'), 15000)
      push('the hosts page can be opened', !!rail)
      if (!rail) return out
      rail.click()
      await wait(900)
      const page = await waitFor(() => field('hosts-page'))
      if (!page) {
        push('the hosts page renders', false, 'no [data-testid=hosts-page]')
        return out
      }

      const boxes = () => [...document.querySelectorAll('[data-testid="select-host"]')]
      const rowOf = (id) => document.querySelector('[data-host-row="' + id + '"]')
      const countText = () => {
        const chip = field('hosts-selected-count')
        return chip ? chip.textContent.trim() : ''
      }
      const selectedIds = () => boxes().filter((b) => b.checked).map((b) => b.getAttribute('data-host-id'))
      const tick = async (id) => {
        const row = rowOf(id)
        const box = row ? row.querySelector('[data-testid="select-host"]') : null
        // No checkbox means the feature is not there at all; report that rather than
        // crashing the whole probe on the first tick.
        if (!box) return false
        box.click()
        await wait(350)
        return true
      }
      const clearAll = async () => {
        const clear = field('clear-host-selection')
        if (clear) {
          clear.click()
          await wait(450)
        }
      }
      const storeCount = async () => (await api.loadSessionTree()).sessions.length
      /**
       * The stored password, through the app's own "reveal" IPC.
       *
       * Secrets are never part of the session tree, so this is the only honest way for
       * a probe to ask whether a copy really carries the secret and whether a delete
       * really took it away.
       */
      const secretOf = async (id) => {
        try {
          return await api.revealCredential(id)
        } catch {
          return null
        }
      }
      const parentOf = async (id) => {
        const tree = await api.loadSessionTree()
        const found = tree.sessions.find((s) => s.id === id)
        return found ? found.parentId : 'missing'
      }

      // ---- 勾选本身 --------------------------------------------------------
      push('every host row carries a checkbox',
        boxes().length === 7 && boxes().every((b) => !!b.getAttribute('data-host-id')),
        'checkboxes=' + boxes().length)

      if (!(await tick(FIX.db1))) {
        push('ticking a host opens the batch bar with a count', false,
          rowOf(FIX.db1) ? 'the row has no checkbox' : 'no row for db-1')
      } else {
        push('ticking a host opens the batch bar with a count',
          !!field('hosts-batch-bar') && countText().indexOf('1') >= 0 &&
            rowOf(FIX.db1).className.indexOf('is-selected') >= 0,
          'bar=' + !!field('hosts-batch-bar') + ' count=' + countText())
        await clearAll()
        push('the selection can be cleared',
          !field('hosts-batch-bar') && selectedIds().length === 0,
          'bar=' + !!field('hosts-batch-bar') + ' ticked=' + selectedIds().length)
      }

      // ---- 全选 = 屏幕上看得见的那些 ---------------------------------------
      if (field('select-all-hosts')) {
        field('select-all-hosts').click()
        await wait(500)
        push('select-all ticks every host on the page',
          selectedIds().length === 7, 'ticked=' + selectedIds().length + ' count=' + countText())
        await clearAll()

        // Fold "web" (which also holds the nested canary), then select all again.
        const fold = document.querySelector('[data-testid="hosts-group-fold"][data-fold-key="' + FIX.web + '"]')
        if (fold) {
          fold.click()
          await wait(500)
          field('select-all-hosts').click()
          await wait(500)
          const ticked = selectedIds()
          push('and select-all means what is on screen, not what is folded away',
            ticked.length === 4 && ticked.indexOf(FIX.web1) < 0,
            'ticked=' + ticked.length + ' web-1=' + (ticked.indexOf(FIX.web1) >= 0 ? 'ticked' : 'not ticked'))
          await clearAll()
          fold.click()
          await wait(500)
        } else {
          push('and select-all means what is on screen, not what is folded away', false, 'no fold control for web')
        }
      } else {
        push('select-all ticks every host on the page', false, 'no [data-testid=select-all-hosts]')
        push('and select-all means what is on screen, not what is folded away', false,
          'no select-all control')
      }

      // ---- 批量移动 --------------------------------------------------------
      await tick(FIX.db1)
      await tick(FIX.web1)
      const moveButton = field('batch-move-hosts')
      if (!moveButton) {
        push('the batch bar offers move, duplicate and delete', false, 'no [data-testid=batch-move-hosts]')
        push('moving asks which group, and lists them', false, 'no move control')
        push('batch move re-files exactly the ticked hosts', false, 'no move control')
      } else {
        push('the batch bar offers move, duplicate and delete',
          !!field('batch-duplicate-hosts') && !!field('batch-delete-hosts'),
          'move/duplicate/delete present')
        moveButton.click()
        await wait(600)
        const menu = field('hosts-move-menu')
        const target = menu ? menu.querySelector('[data-menu-id="move:' + FIX.web + '"]') : null
        push('moving asks which group, and lists them',
          !!menu && !!target, menu ? 'items=' + menu.querySelectorAll('.td-menu-item').length : 'no menu')
        if (target) {
          target.click()
          await wait(900)
          const parents = [await parentOf(FIX.db1), await parentOf(FIX.web1)]
          push('batch move re-files exactly the ticked hosts',
            parents[0] === FIX.web && parents[1] === FIX.web,
            'db-1=' + (parents[0] === FIX.web ? 'web' : parents[0]) + ' web-1=' + (parents[1] === FIX.web ? 'web' : parents[1]))
          push('and the page shows them in that group',
            !!document.querySelector('[data-host-group="web"] [data-host-row="' + FIX.db1 + '"]'),
            'db-1 under web')
          push('a batch action clears the selection',
            !field('hosts-batch-bar'), 'bar=' + !!field('hosts-batch-bar'))
        }
      }

      // ---- 批量复制 --------------------------------------------------------
      await tick(FIX.scratch1)
      await tick(FIX.scratch2)
      const dupButton = field('batch-duplicate-hosts')
      if (dupButton) {
        const before = await storeCount()
        dupButton.click()
        await wait(1100)
        const tree = await api.loadSessionTree()
        const copies = tree.sessions.filter((s) => s.name.indexOf(' copy') > 0)
        const copyOfScratch1 = copies.find((s) => s.name === 'scratch-1 copy')
        const sealed = copyOfScratch1 ? await secretOf(copyOfScratch1.id) : null
        push('batch duplicate copies exactly the ticked hosts',
          tree.sessions.length === before + 2 && copies.length === 2 &&
            copies.every((s) => s.parentId === null),
          'sessions ' + before + ' -> ' + tree.sessions.length + ' copies=' + copies.map((s) => s.name).join(','))
        push('and the copy carries the original stored secret',
          sealed === 'probe-secret', 'scratch-1 copy password=' + (sealed === 'probe-secret' ? 'carried' : String(sealed)))
        await clearAll()
      } else {
        push('batch duplicate copies exactly the ticked hosts', false, 'no duplicate control')
        push('and the copy carries the original stored secret', false, 'no duplicate control')
      }

      // ---- 批量删除 --------------------------------------------------------
      await tick(FIX.db1)
      await tick(FIX.web1)
      const delButton = field('batch-delete-hosts')
      if (delButton) {
        const before = await storeCount()
        delButton.click()
        await wait(500)
        const confirm = field('confirm-delete-hosts')
        push('batch delete asks before it deletes anything',
          !!confirm && (await storeCount()) === before,
          'confirm=' + !!confirm + ' sessions=' + (await storeCount()) + ' of ' + before)

        const cancel = field('cancel-delete-hosts')
        if (cancel) {
          cancel.click()
          await wait(450)
          push('cancelling leaves every host alone',
            (await storeCount()) === before && !!field('hosts-batch-bar'),
            'sessions=' + (await storeCount()) + ' bar=' + !!field('hosts-batch-bar'))
        }

        field('batch-delete-hosts').click()
        await wait(400)
        field('confirm-delete-hosts').click()
        await wait(1100)
        const tree = await api.loadSessionTree()
        const gone = [FIX.db1, FIX.web1].filter((id) => !tree.sessions.some((s) => s.id === id))
        push('confirming deletes exactly the ticked hosts',
          tree.sessions.length === before - 2 && gone.length === 2,
          'sessions=' + tree.sessions.length + ' of ' + before + ' removed=' + gone.length)
        push('and the selection is gone with them',
          !field('hosts-batch-bar'), 'bar=' + !!field('hosts-batch-bar'))
      } else {
        push('batch delete asks before it deletes anything', false, 'no delete control')
        push('cancelling leaves every host alone', false, 'no delete control')
        push('confirming deletes exactly the ticked hosts', false, 'no delete control')
      }

      // ---- 删除要把密文一起带走 --------------------------------------------
      // Tick first: the batch bar — and with it the delete control — only exists
      // while something is selected.
      const secretRow = rowOf(FIX.scratch1)
      if (secretRow && (await tick(FIX.scratch1))) {
        const secretDelete = field('batch-delete-hosts')
        if (!secretDelete) {
          push('deleting a host takes its stored secret with it', false,
            'the batch bar did not appear after ticking')
        } else {
          secretDelete.click()
          await wait(400)
          field('confirm-delete-hosts').click()
          await wait(1100)
          const leftover = await secretOf(FIX.scratch1)
          push('deleting a host takes its stored secret with it',
            leftover === null,
            'secret for the deleted host=' + (leftover === null ? 'gone' : 'still there'))
        }
      } else {
        push('deleting a host takes its stored secret with it', false,
          secretRow ? 'the row has no checkbox' : 'no row for scratch-1')
      }

      return out
    })()
  `

  try {
    const checks = await win.webContents.executeJavaScript(probe)
    report(checks)
  } catch (err) {
    report([{ name: 'hostsbatch probe crashed', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('hostsbatch probe crashed:', err)
    app.exit(1)
  })
)
