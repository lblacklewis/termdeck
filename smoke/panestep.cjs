/**
 * Open a local shell and wait for its terminal to be fitted.
 *
 *   const { openFittedShell } = require('./panestep')
 *   const ok = await openFittedShell(win)
 *
 * Every suite that measures the terminal needs the pane to have reached its real
 * size first, and one launch can leave the pane at 65px with the terminal on
 * xterm's 80x24 default. That state is now understood: Electron throttles an
 * *occluded* renderer, and a throttled renderer serves stale computed styles,
 * never paints, and therefore never lets xterm measure a cell — so `fit()` does
 * nothing at all. It is a property of the harness window, not of the app, and
 * `backgroundThrottling: false` on the probe window prevents it (see
 * smoke/chrome.cjs and `docs/项目会话总结.md`).
 *
 * The retry is kept anyway: it also covers a genuinely slow settle, and it costs
 * nothing when the first attempt already fits.
 *
 * A second page load is a genuinely fresh boot, and it is used here so a suite can
 * assert on the terminal's geometry without that intermittent state being reported
 * as a product failure. The assertions themselves are unchanged: if the retry also
 * fails to fit, this returns false and the calling suite fails.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ROWS = `(() => {
  const e = window.__tdTerminals ? Object.values(window.__tdTerminals)[0] : null
  return e && e.term ? e.term.rows : -1
})()`

const CLICK_LOCAL = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  if (!document.querySelector('.td-sidebar')) {
    const t = document.querySelector('[data-testid="rail-toggle"]')
    if (t) t.click()
    await wait(600)
  }
  const btn = [...document.querySelectorAll('.td-sidebar .td-btn')]
    .find((b) => /Local shell/i.test(b.textContent || ''))
  if (!btn) return false
  btn.click()
  return true
})()`

/** True once the first terminal has more rows than xterm's default. */
async function waitForFit(win, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if ((await win.webContents.executeJavaScript(ROWS)) > 24) return true
    await sleep(400)
  }
  return false
}

async function openFittedShell(win) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await win.webContents.executeJavaScript(CLICK_LOCAL)
    if (await waitForFit(win)) return true
    if (attempt < 3) {
      // A fresh boot is the only reliable way out of the stuck state, and it is
      // cheaper than asserting against a pane that will never fit.
      await win.reload()
      await sleep(2600)
    }
  }
  return false
}

module.exports = { openFittedShell, waitForFit }
