/**
 * Known Hosts: browsing, filtering and the batch "forget".
 *
 * The page had no coverage at all before this, and the batch path is the one with a
 * trap in it: entries are addressed by **line number**, so removing several one at a
 * time from the top deletes the wrong keys — every removal shifts the lines below
 * it. The suite therefore removes two *non-adjacent* rows and then checks the
 * survivors by name, not by count.
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A known_hosts file of this suite's own, so nothing here can touch the developer's
 * real one. Set before the IPC module is loaded, because it is read at import time.
 */
const knownHostsPath = path.join(os.tmpdir(), 'termdeck-known-hosts-suite')
process.env['TERMDECK_KNOWN_HOSTS'] = knownHostsPath

/** Four entries, standing in for four hosts, with the ones to remove not adjacent. */
const ENTRIES = [
  `alpha.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(40)}`,
  `bravo.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'B'.repeat(40)}`,
  `charlie.example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB${'C'.repeat(40)}`,
  `delta.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'D'.repeat(40)}`
]

function writeEntries(list) {
  fs.writeFileSync(knownHostsPath, list.join('\n') + '\n', { mode: 0o600 })
}

async function main() {
  require(path.join(__dirname, 'clearstore.cjs')).wipeProfile()
  writeEntries(ENTRIES)

  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  mod.registerIpc()
  mod.registerFocusIpc()
  mod.storeAccess().layout.clear()

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
  mod.attachFocusMode(win)
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await sleep(2800)

  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' })
  const page = (code) => win.webContents.executeJavaScript(code)

  // ---- the page lists what is on disk ----------------------------------------
  const listed = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="rail-known-hosts"]').click()
    await wait(1200)
    const rows = [...document.querySelectorAll('[data-entry-key]')]
      .filter((el) => el.tagName === 'TR')
    return {
      hasPage: !!document.querySelector('[data-testid="known-hosts-page"]'),
      hosts: rows.map((r) => (r.querySelector('.td-mono') || {}).textContent || ''),
      checkboxes: document.querySelectorAll('[data-testid="select-entry"]').length,
      hasSelectAll: !!document.querySelector('[data-testid="select-all-entries"]')
    }
  })()`)
  push('the Known Hosts page lists every entry', listed.hasPage && listed.hosts.length === 4,
    JSON.stringify(listed.hosts))
  push('every row can be selected', listed.checkboxes === 4, String(listed.checkboxes))
  push('and the header offers select-all', listed.hasSelectAll)

  // ---- selection --------------------------------------------------------------
  const selection = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const boxes = [...document.querySelectorAll('[data-testid="select-entry"]')]
    // Rows 1 and 3: not adjacent, which is what makes a naive loop delete the
    // wrong entries.
    boxes[0].click()
    boxes[2].click()
    await wait(400)
    return {
      checked: boxes.filter((b) => b.checked).length,
      label: (document.querySelector('[data-testid="forget-selected"]') || {}).textContent || '',
      rowsMarked: document.querySelectorAll('.td-table tr.is-selected').length,
      singleRow: boxes[1].checked
    }
  })()`)
  push('two non-adjacent rows can be selected', selection.checked === 2, JSON.stringify(selection))
  push('the action says how many will go', /2/.test(selection.label), selection.label)
  push('selected rows are visibly marked', selection.rowsMarked === 2, String(selection.rowsMarked))

  // ---- the batch removal ------------------------------------------------------
  const removed = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-testid="forget-selected"]').click()
    await wait(300)
    const confirm = document.querySelector('[data-testid="confirm-remove-selected-yes"]')
    const confirmText = confirm ? confirm.textContent : 'none'
    if (confirm) confirm.click()
    await wait(1200)
    const rows = [...document.querySelectorAll('[data-entry-key]')]
      .filter((el) => el.tagName === 'TR')
    return {
      confirmText: confirmText,
      hosts: rows.map((r) => (r.querySelector('.td-mono') || {}).textContent || ''),
      selectionCleared: !document.querySelector('[data-testid="forget-selected"]'),
      error: (document.querySelector('.td-form-error') || {}).textContent || ''
    }
  })()`)
  push('the batch asks for confirmation first', /Remove 2 keys/.test(removed.confirmText),
    removed.confirmText)
  push('exactly the two selected entries are gone',
    removed.hosts.length === 2 &&
      removed.hosts.join(',') === 'bravo.example.com,delta.example.com',
    JSON.stringify(removed.hosts))
  push('and the selection is cleared afterwards', removed.selectionCleared)
  push('the removal reported no error', removed.error === '', removed.error)

  const onDisk = fs
    .readFileSync(knownHostsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split(' ')[0])
  push('the file on disk lost exactly those two lines',
    onDisk.join(',') === 'bravo.example.com,delta.example.com', JSON.stringify(onDisk))

  // ---- filtering, and the selection it prunes ---------------------------------
  const filtered = await page(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const boxes = [...document.querySelectorAll('[data-testid="select-entry"]')]
    boxes[0].click()
    boxes[1].click()
    await wait(300)
    const before = document.querySelectorAll('.td-table tr.is-selected').length

    const filter = document.querySelector('[aria-label="filter-known-hosts"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(filter, 'bravo')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(600)
    return {
      before: before,
      rowsShown: [...document.querySelectorAll('[data-entry-key]')]
        .filter((el) => el.tagName === 'TR').length,
      selected: document.querySelectorAll('.td-table tr.is-selected').length,
      action: !!document.querySelector('[data-testid="forget-selected"]')
    }
  })()`)
  push('a filter narrows the list', filtered.rowsShown === 1, JSON.stringify(filtered))
  push('and the selection is pruned to what is still visible',
    filtered.selected === 1, JSON.stringify(filtered))

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('known-hosts probe crashed:', err)
    app.exit(1)
  })
)
