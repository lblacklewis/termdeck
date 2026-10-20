/**
 * Layout gestures: what the app does to the terminals while the layout moves.
 *
 *   npm run build && electron smoke/gesture.cjs --user-data-dir=...
 *
 * Every pane re-measures on a size change, and re-measuring reflows xterm and
 * tells the main process to resize the pty. That is right for a window resize and
 * wrong for the thirty frames of a sash drag, so a fit is held for the length of
 * a gesture and taken once at the end. This suite watches a pane's column count
 * through the three gestures that move a pane's box without a window resize, and
 * checks that nothing else is mistaken for one — an over-eager pause would freeze
 * the terminals for good.
 *
 * The rail half is checked with animation effects emulated on. That is not
 * decoration: the rail's collapse is recognised *by its width transition*, and on
 * a machine with Windows animations switched off every transition is 1ms, leaving
 * nothing to observe. The second half runs under the machine's real preference and
 * checks the pointer-driven gestures, which do not depend on a transition at all.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []
const DASH = String.fromCharCode(8212)

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ' ' + DASH + ' ' + c.detail : ''}`)
    all.push(c)
  }
}

/** Helpers every check uses, shared by both halves. */
const HELPERS = `
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, timeout, step) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          if (await fn()) return true
          await wait(step || 80)
        }
        return false
      }
      /** The one open pane: its column count is what a re-fit changes. */
      const pane = () => {
        const reg = window.__tdTerminals || {}
        const id = Object.keys(reg)[0]
        return id ? reg[id] : null
      }
      const cols = () => {
        const e = pane()
        return e && e.term ? e.term.cols : -1
      }
      const paused = () => window.__tdFitsPaused === true
      const gesture = () => !!document.querySelector('.td-root.is-layout-gesture')
      const expandRail = async () => {
        if (!document.querySelector('.td-sidebar')) {
          document.querySelector('[data-testid="rail-toggle"]').click()
          await wait(700)
        }
      }
      const openPane = async () => {
        await expandRail()
        document.querySelector('[data-testid="local-shell"]').click()
        return waitFor(() => {
          const e = pane()
          return e && e.term && e.term.rows > 24
        }, 20000)
      }
`

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()

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
  await sleep(2800)

  /** Pretend the machine has animation effects on, so the rail has a transition. */
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  })

  // ---- 1. a gesture that is recognised by its transition ------------------
  const animated = `
    (async () => {
${HELPERS}
      let step = 'start'
      try {
        step = 'open a pane'
        push('a pane is open and fitted', await openPane(), 'cols=' + cols())

        step = 'rail collapse'
        /*
         * Collapsing the rail hides the list beside it, so the workspace widens
         * and every pane's column count changes — over the length of the rail's
         * width transition. Fitting each of those frames is the cost; fitting once
         * at the end is the fix.
         */
        const rail = document.querySelector('.td-rail')
        push('the rail still animates its width',
          getComputedStyle(rail).transitionProperty.indexOf('width') >= 0 &&
            getComputedStyle(rail).transitionDuration === '0.17s',
          getComputedStyle(rail).transitionDuration)
        const colsBefore = cols()
        const trace = []
        for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
          window.addEventListener(type, (e) => {
            const el = e.target
            if (el && el.classList && el.classList.contains('td-rail')) {
              trace.push(type.replace('transition', '') + ':' + e.propertyName +
                '@' + Math.round(performance.now()))
            }
          }, true)
        }
        document.querySelector('[data-testid="rail-toggle"]').click()
        const engaged = await waitFor(() => paused() && gesture(), 2000, 10)
        push('the collapse is recognised as a layout gesture', engaged,
          'gesture=' + gesture() + ' paused=' + paused())
        push('and the panes are held still while it runs', paused() === true,
          'paused=' + paused())
        /*
         * From the moment the gesture is recognised, the panes must not move again
         * until it ends — that is the frame-by-frame fit this exists to stop. The
         * list beside the rail disappears without an animation, and that has
         * already resized them once by now, which is legitimate: the pane really
         * did get wider at that instant.
         *
         * The pause is followed rather than measured from a fixed offset, because
         * how far into the animation it is first seen depends on the poll; what has
         * to hold is that nothing is fitted between the pause going on and it
         * coming off again.
         */
        const heldAt = cols()
        let held = 0
        let moved = false
        while (held < 40) {
          await wait(20)
          /*
           * Re-check first: releasing the pause refits everything, which is the
           * whole design, so a change seen in the interval where it let go is the
           * expected one rather than a leak. Only a change while it is still held
           * counts.
           */
          if (!paused()) break
          held += 1
          if (cols() !== heldAt) moved = true
        }
        push('nothing is fitted while the gesture is held', !moved && held >= 3,
          held + ' x 20ms held, cols ' + heldAt + ' -> ' + cols() + ' | ' + trace.join(' '))
        const settled = await waitFor(() => !paused(), 4000)
        await wait(500)
        push('the fit is taken again once it finishes', settled && paused() === false,
          'paused=' + paused())
        push('and the pane ends at its new width', cols() !== heldAt,
          'cols ' + colsBefore + ' -> ' + heldAt + ' (mid) -> ' + cols())

        step = 'not a gesture'
        /*
         * The other half of the contract. A pause that never lifts is worse than
         * no pause at all: the terminals would keep the size they had mid-gesture
         * for the rest of the session, so ordinary interactions have to stay clear
         * of it.
         */
        await expandRail()
        document.querySelector('[data-testid="rail-hosts"]').click()
        await waitFor(async () => !!document.querySelector('.td-page'), 3000)
        push('switching page is not treated as a gesture', !paused() && !gesture(),
          'paused=' + paused() + ' gesture=' + gesture())
        document.querySelector('[data-testid="rail-terminal"]').click()
        await wait(500)
        const tab = document.querySelector('.dv-tab[data-tab-panel-id]')
        push('the pane has a tab', !!tab)
        if (tab) {
          tab.click()
          await wait(300)
          push('and clicking it is not either', !paused() && !gesture(),
            'paused=' + paused() + ' gesture=' + gesture())
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
    report(await win.webContents.executeJavaScript(animated))
  } catch (err) {
    report([{ name: 'rail half', ok: false, detail: String((err && err.message) || err) }])
  }

  // ---- 2. the pointer-driven gestures, under the machine's own setting -----
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })

  const reduced = `
    (async () => {
${HELPERS}
      let step = 'start'
      try {
        step = 'a machine with animations off'
        push('the machine is in reduce mode',
          window.matchMedia('(prefers-reduced-motion: reduce)').matches === true)
        push('so a transition is instantaneous',
          getComputedStyle(document.querySelector('.td-rail')).transitionDuration === '0.001s',
          getComputedStyle(document.querySelector('.td-rail')).transitionDuration)

        step = 'tab drag'
        /*
         * Whether a transition runs is the OS's business; whether a drag floods
         * the main process with pty resizes is ours. This gesture is driven by
         * dragstart/dragend alone, so it has to behave the same either way.
         */
        const tab = document.querySelector('.dv-tab[data-tab-panel-id]')
        push('the pane has a tab to drag', !!tab)
        if (tab) {
          const dt = new DataTransfer()
          tab.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, cancelable: true, dataTransfer: dt
          }))
          await wait(80)
          push('dragging a tab holds the fits', paused() === true && gesture(),
            'paused=' + paused() + ' gesture=' + gesture())
          tab.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, cancelable: true, dataTransfer: dt
          }))
          await wait(250)
          push('and releasing it lets them run again', paused() === false, 'paused=' + paused())
        }

        step = 'drawer resize'
        await expandRail()
        const edge = document.querySelector('[data-testid="drawer-resize"]')
        push('the drawer has a resize edge', !!edge)
        if (edge) {
          const box = edge.getBoundingClientRect()
          const x = Math.round(box.x + box.width / 2)
          const y = Math.round(box.y + box.height / 2)
          const colsAtStart = cols()
          edge.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, clientX: x, clientY: y
          }))
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x + 70, clientY: y
          }))
          await wait(200)
          push('widening the drawer holds the fits', paused() === true, 'paused=' + paused())
          const during = cols()
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 70 }))
          await wait(500)
          push('and the pane is measured once when the drag ends',
            paused() === false && cols() <= during && cols() !== colsAtStart,
            'cols ' + colsAtStart + ' -> ' + during + ' (during) -> ' + cols())

          /*
           * A drag the browser cancels never delivers pointerup. If that left the
           * pause on, every pane would stay frozen at whatever size it had when the
           * drag was interrupted — for the rest of the session.
           */
          edge.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, clientX: x, clientY: y
          }))
          window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x + 40, clientY: y
          }))
          await wait(150)
          push('a second drag holds them again', paused() === true, 'paused=' + paused())
          window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
          await wait(300)
          push('and a cancelled drag still lets them go', paused() === false,
            'paused=' + paused())
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
    report(await win.webContents.executeJavaScript(reduced))
  } catch (err) {
    report([{ name: 'pointer half', ok: false, detail: String((err && err.message) || err) }])
  }

  /*
   * ---- 3. a dragged divider stays where it was released --------------------
   *
   * Driven here rather than in the page: a real drag needs mouse events from
   * outside the renderer, and the breakage was invisible to anything that only
   * looked at the DOM afterwards. The correction watchdog used to hand dockview
   * `layout(w, h, true)` ten times a second, and that does not merely measure — it
   * re-distributes the grid. A divider being dragged was pushed back to equal
   * halves on the next tick, and the ratio the user chose was gone on release.
   */
  const sashChecks = []
  const pushSash = (name, ok, detail) =>
    sashChecks.push({ name, ok: Boolean(ok), detail: detail || '' })
  const readWidths = `(() => {
    const groups = window.__tdDockApi.groups
    return groups.map((g) => Math.round(g.element.getBoundingClientRect().width)).join(',')
  })()`

  try {
    const geom = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.__tdDockApi
      while (api.panels.length < 2) {
        document.querySelector('[data-testid="local-shell"]').click()
        await wait(2500)
        if (api.panels.length < 2) return { error: 'could not open two panes' }
      }
      // Side by side, whatever arrangement they were left in. The second pane is
      // moved even when it already shares the first group: as a tab it has to be
      // split out to the right, and a panel in its own right-hand group lands in
      // the same place.
      const first = api.groups[0]
      if (api.panels[1]) api.panels[1].api.moveTo({ group: first, position: 'right' })
      await wait(1200)
      const sash = [...document.querySelectorAll('[class*="dv-sash"]')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.height > r.width)
        .sort((a, b) => b.height - a.height)[0]
      const host = document.querySelector('.td-dockview').getBoundingClientRect()
      if (!sash) return { error: 'no vertical divider' }
      return {
        x: Math.round(sash.x + sash.width / 2),
        y: Math.round(sash.y + sash.height / 2),
        targetX: Math.round(host.x + host.width * 0.7),
        widths: api.groups.map((g) => Math.round(g.element.getBoundingClientRect().width))
      }
    })()`)

    if (geom.error) {
      pushSash('two panes can be placed side by side', false, geom.error)
    } else {
      pushSash('two panes can be placed side by side', geom.widths.length === 2,
        'widths=' + geom.widths.join(','))

      if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
      const send = (method, params) => win.webContents.debugger.sendCommand(method, params)
      const widthsNow = async () =>
        (await win.webContents.executeJavaScript(readWidths)).split(',').map(Number)

      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: geom.x, y: geom.y, button: 'left', clickCount: 1
      })

      const steps = 10
      const trace = []
      let trackedEarly = false
      for (let i = 1; i <= steps; i += 1) {
        const x = Math.round(geom.x + (geom.targetX - geom.x) * (i / steps))
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y: geom.y, button: 'left', buttons: 1
        })
        await sleep(90)
        const widths = await widthsNow()
        trace.push(widths.join('/'))
        // The divider has to follow the pointer from the start, not only when a
        // watchdog tick happens to leave it alone.
        if (i <= 3 && Math.abs(widths[0] - geom.widths[0]) > 4) trackedEarly = true
      }
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: geom.targetX, y: geom.y, button: 'left', clickCount: 1
      })
      await sleep(400)
      const released = await widthsNow()
      await sleep(1200)
      const settled = await widthsNow()
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()

      pushSash('a dragged divider follows the pointer from the first steps', trackedEarly,
        'start=' + geom.widths.join('/') + ' trace=' + trace.join(' '))
      pushSash('it lands at the ratio it was released at',
        released[0] > geom.widths[0] + 20,
        geom.widths.join('/') + ' -> ' + released.join('/'))
      pushSash('and it stays there instead of snapping back to equal halves',
        Math.abs(settled[0] - released[0]) <= 2,
        released.join('/') + ' -> ' + settled.join('/'))
    }
  } catch (err) {
    pushSash('the divider drag could be driven', false, String((err && err.message) || err))
  }
  report(sashChecks)

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('gesture probe crashed:', err)
    app.exit(1)
  })
)
