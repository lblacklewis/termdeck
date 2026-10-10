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
        host() ? host().clientHeight + 'px tall' : 'no host')
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

      // ---- timestamps on by default, WindTerm-style bracketed clock --------
      const gutter = document.querySelector('[data-testid="timestamp-gutter"]')
      push('the timestamp gutter is on by default', gutter)
      if (gutter) {
        // A freshly opened shell has not printed anything yet, so wait for the
        // prompt before asserting that lines are stamped. The pattern is built
        // with the RegExp constructor rather than a literal, because a literal
        // inside this template would lose a backslash and become /[d{2}/.
        const stampedRe = new RegExp('\\\\[\\\\d{2}:\\\\d{2}')
        for (let i = 0; i < 40; i++) {
          const any = [...gutter.querySelectorAll('.td-terminal-stamp')]
            .some((c) => stampedRe.test(c.textContent || ''))
          if (any) break
          await wait(250)
        }
        const cells = [...gutter.querySelectorAll('.td-terminal-stamp')]
        push('the gutter matches the terminal row count',
          cells.length === term().rows,
          'cells=' + cells.length + ' rows=' + term().rows)
        const stamped = cells.map((c) => c.textContent).filter((s) => stampedRe.test(s))
        push('stamps use the bracketed [HH:MM:SS] form',
          stamped.length > 0, JSON.stringify(stamped.slice(0, 3)))
        const cellH = cells[0] ? cells[0].getBoundingClientRect().height : 0
        const screenH = document.querySelector('.xterm-screen').getBoundingClientRect().height
        push('gutter rows align with terminal rows',
          Math.abs(cellH - screenH / term().rows) < 1.5,
          \`cell=\${cellH.toFixed(2)} row=\${(screenH / term().rows).toFixed(2)}\`)
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
