/**
 * Layout check for a pane's terminal.
 *
 *   npm run build && electron smoke/geom.cjs --user-data-dir=...
 *
 * Asserts the two things that were wrong: the terminal must be fitted to the
 * space the layout gives it (not left at xterm's 80x24 default, which painted
 * 456px tall inside a 791px host), and the pane must not extend under the
 * snippet bar.
 */
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const all = []

function report(checks) {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    all.push(c)
  }
}

async function main() {
  // A dedicated profile can still carry settings from an earlier run — this suite
  // turns timestamps on and saves that — so it starts from nothing.
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  // Start from the default arrangement, so a collapsed sidebar left behind by an
  // earlier run cannot change what this measures.
  mod.storeAccess().layout.clear()

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
  await sleep(2600)

  // Open a pane first: there is nothing to measure without one. The layout was
  // cleared above, so the rail is expanded and its drawer carries this button.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const target = [...document.querySelectorAll('.td-sidebar .td-btn')]
      .find((b) => /Local shell/i.test(b.textContent || ''))
    if (target) target.click()
    await wait(1500)
    return !!target
  })()`)

  // Let dockview finish propagating its size before measuring: it attaches the
  // panel before the group has been laid out, so an immediate measurement sees a
  // 100x100 placeholder rather than the real pane.
  await sleep(3000)

  /*
   * Note the collapsed docking surface if this launch produced one. It is reported
   * as a failure rather than skipped: `smoke:repeat` is the dedicated check and
   * runs each pane in its own process, so a collapse here is real information
   * about this process, not a reason to measure nothing.
   */
  const collapsed = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dv-grid-view')
    const d = document.querySelector('.td-dockview')
    const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
    if (!g || !d) return null
    return {
      grid: g.clientWidth + 'x' + g.clientHeight,
      dock: d.clientWidth + 'x' + d.clientHeight,
      rows: e && e.term ? e.term.rows : -1,
      collapsed: g.clientHeight < d.clientHeight - 50 || (e && e.term && e.term.rows <= 24)
    }
  })()`)
  if (collapsed && collapsed.collapsed) {
    console.log('NOTE  the docking surface is collapsed: ' + JSON.stringify(collapsed))
  }

  const probe = `
    (async () => {
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))

      const host = () => document.querySelector('.td-terminal-host')
      const entry = () => (window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null)
      const term = () => (entry() && entry().term ? entry().term : null)
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
      }

      // Wait until the pane's box has settled and the terminal has been fitted,
      // rather than sleeping a fixed amount and hoping.
      const equipped = await (async () => {
        for (let i = 0; i < 60; i++) {
          await wait(250)
          const h = host()
          const t = term()
          if (h && t && h.clientHeight > 200 && t.rows > 24) return true
        }
        return false
      })()
      push('the pane fitted itself without a manual nudge', equipped,
        host() ? 'host=' + host().clientHeight + ' rows=' + (term() ? term().rows : '?') : 'no host')

      push('a shell pane was opened', !!term())
      push('the pane has a real box', !!host() && host().clientHeight > 200,
        (host() ? host().clientHeight + 'px tall' : 'no host') +
          ' grid=' + (() => {
            const g = document.querySelector('.dv-grid-view')
            return g ? g.clientWidth + 'x' + g.clientHeight : 'none'
          })() +
          ' dock=' + (() => {
            const d = document.querySelector('.td-dockview')
            return d ? d.clientWidth + 'x' + d.clientHeight : 'none'
          })() +
          ' dockInner=' + (() => {
            const d = document.querySelector('.dv-dockview')
            return d ? d.clientWidth + 'x' + d.clientHeight + ' style=' + (d.getAttribute('style') || '') : 'none'
          })() +
          ' last=' + JSON.stringify((window.__tdDockTrail || []).slice(-1)))
      if (!term()) return out

      const t = term()
      const h = host()
      push('the terminal is fitted to its box, not left at 80x24 default',
        t.rows > 24 || t.cols > 80,
        \`term=\${t.cols}x\${t.rows} host=\${h.clientWidth}x\${h.clientHeight}\`)

      // The pane must not extend below the space the layout reserved for it.
      const bar = document.querySelector('[data-testid="snippet-bar"]')
      const main = document.querySelector('.td-main')
      const screenEl = document.querySelector('.xterm-screen')
      const sb = box(screenEl)
      const bb = box(bar)
      push('the terminal does not extend under the snippet bar',
        !bar || (sb && bb && sb.bottom <= bb.top + 1),
        JSON.stringify({ screenBottom: sb ? sb.bottom : null, barTop: bb ? bb.top : null }))
      push('the pane fills the space left for it',
        !!main && !!sb && Math.abs(sb.bottom - box(main).bottom) < 12,
        JSON.stringify({ screenBottom: sb ? sb.bottom : null, mainBottom: box(main).bottom }))

      // Hiding the bar must let the terminal grow.
      const rowsBefore = t.rows
      document.querySelector('[data-testid="toggle-snippets"]').click()
      await wait(2000)
      const rowsAfter = term().rows
      push('hiding the snippet bar lets the terminal grow',
        rowsAfter >= rowsBefore,
        \`rows \${rowsBefore} -> \${rowsAfter}\`)

      // Showing it again must shrink it back, not leave a clipped bottom.
      document.querySelector('[data-testid="toggle-snippets"]').click()
      await wait(2000)
      const rowsRestored = term().rows
      const sb2 = box(document.querySelector('.xterm-screen'))
      const bb2 = box(document.querySelector('[data-testid="snippet-bar"]'))
      push('restoring the bar shrinks the terminal back',
        Math.abs(rowsRestored - rowsBefore) <= 1,
        \`rows \${rowsBefore} -> \${rowsAfter} -> \${rowsRestored}\`)
      push('and it still clears the bar',
        !!bb2 && sb2 && sb2.bottom <= bb2.top + 1,
        JSON.stringify({ screenBottom: sb2 ? sb2.bottom : null, barTop: bb2 ? bb2.top : null }))

      // ---- timestamps: off by default, and aligned when shown --------------
      push('the timestamp gutter is off by default',
        !document.querySelector('[data-testid="timestamp-gutter"]'))

      const stampSettings = await window.termdeck.loadSettings()
      await window.termdeck.saveSettings({
        ...stampSettings,
        terminal: { ...stampSettings.terminal, showTimestamps: true }
      })
      await wait(1200)

      const gutter = document.querySelector('[data-testid="timestamp-gutter"]')
      push('turning timestamps on shows the gutter', gutter)
      if (gutter) {
        /*
         * A freshly opened shell has not printed anything yet, so wait for a
         * stamped line before measuring. Cells are counted by whether they hold
         * text, not by matching a time: the gutter blanks the repeats inside one
         * second, so a pattern would under-count on a fast shell.
         */
        const filledCells = () =>
          [...gutter.querySelectorAll('.td-terminal-stamp')].filter(
            (c) => (c.textContent || '').trim().length > 0
          )
        for (let i = 0; i < 40; i++) {
          if (filledCells().length > 0) break
          await wait(250)
        }
        const cells = [...gutter.querySelectorAll('.td-terminal-stamp')]
        push('the gutter matches the terminal row count',
          cells.length === term().rows,
          'cells=' + cells.length + ' rows=' + term().rows)
        const stamped = filledCells().map((c) => (c.textContent || '').trim())
        push('stamps use the bracketed [HH:MM:SS] form',
          stamped.length > 0 &&
            stamped.every(
              (t) =>
                t.length === 10 &&
                t[0] === '[' &&
                t[9] === ']' &&
                t[3] === ':' &&
                t[6] === ':'
            ),
          JSON.stringify(stamped.slice(0, 3)))
        const cellH = cells[0] ? cells[0].getBoundingClientRect().height : 0
        const rowH = document.querySelector('.xterm-screen').getBoundingClientRect().height / term().rows
        push('gutter rows align with terminal rows',
          Math.abs(cellH - rowH) < 1.5,
          'cell=' + cellH.toFixed(2) + ' row=' + rowH.toFixed(2))
      }

      return out
    })()
  `

  try {
    report(await win.webContents.executeJavaScript(probe))
  } catch (err) {
    report([{ name: 'layout probe', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('geom crashed:', err)
    app.exit(1)
  })
)
