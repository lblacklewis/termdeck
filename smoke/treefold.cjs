/**
 * Folding every group in the drawer's session tree at once.
 *
 *   npm run build && electron smoke/treefold.cjs --user-data-dir=...
 *
 * The tree has folded per group since it was built; what never existed is a way to
 * fold *all* of them, which is the only workable gesture once the tree is taller than
 * the drawer. Three things have to hold for that button to be worth having, and each
 * is a way it could look finished while being useless:
 *
 *   1. it folds every group, not just the top level (a nested group left open still
 *      pushes everything below it off the bottom);
 *   2. the state is stored per folder, not in the page — the drawer is unmounted on
 *      every other page, and "collapse all" that forgets itself is a button that
 *      appears to do nothing;
 *   3. a search still reaches into a folded group. Folding everything and then hiding
 *      every search result would be worse than having no button at all.
 */
const path = require('node:path')
const os = require('node:os')
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

  /*
   * Seed before the window loads: the renderer reads the tree once on mount.
   *
   * The folder ids have to be read back out of the tree — `upsertFolder` does not
   * return the folder it made, and using its return value silently files everything
   * under the root, which is a mistake this probe would then be asserting about.
   */
  const sessions = mod.storeAccess().sessions
  sessions.upsertFolder({ name: 'prod' })
  sessions.upsertFolder({ name: 'staging' })
  const idOf = (name) =>
    (sessions.load().folders.find((f) => f.name === name) || {}).id || null
  sessions.upsertFolder({ name: 'edge', parentId: idOf('prod') })

  const host = (name, parentId) =>
    sessions.upsertSession({
      name, host: '10.0.0.1', port: 22, username: 'deploy', authMethod: 'password',
      parentId: parentId || null, tags: []
    })

  host('prod-a', idOf('prod'))
  host('prod-b', idOf('prod'))
  host('edge-1', idOf('edge'))
  host('stage-1', idOf('staging'))
  host('root-1', null)

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
      const out = []
      const push = (n, ok, d) => out.push({ name: n, ok: Boolean(ok), detail: d || '' })
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const api = window.termdeck
      const setValue = (el, value) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }

      const waitFor = async (fn, timeout) => {
        const end = Date.now() + (timeout || 8000)
        while (Date.now() < end) {
          const v = await fn()
          if (v) return v
          await wait(150)
        }
        return null
      }

      // ---- the drawer, with its Sessions section open ----------------------
      const sidebar = await waitFor(() => document.querySelector('[data-testid="sidebar"]'), 15000)
      push('the drawer is up', !!sidebar)
      if (!sidebar) return out

      const section = document.querySelector('[data-testid="section-sessions"]')
      push('the drawer has a sessions section', !!section)
      if (!section) return out
      if (section.getAttribute('data-collapsed') === 'true') {
        section.querySelector('[data-testid="toggle-sessions"]').click()
        await wait(600)
      }

      const childrenLists = () => document.querySelectorAll('.td-node-children').length
      const folderRows = () => [...document.querySelectorAll('[data-node-kind="folder"]')]
      const rowNamed = (name) =>
        [...document.querySelectorAll('[data-node-kind="session"]')]
          .find((row) => (row.querySelector('.td-node-label') || {}).textContent === name)
      const carets = () => folderRows().map((row) => (row.querySelector('.td-caret') || {}).textContent)
      const foldAll = () => document.querySelector('[data-testid="tree-fold-all"]')
      /**
       * Fold or unfold every group by hand, re-reading the rows as they appear.
       *
       * Folding goes deepest-first: folding a parent takes its children out of the
       * document, so a nested group clicked afterwards is not there any more and stays
       * open in the store — which is the whole reason a single "fold everything" is
       * worth having rather than a loop like this one.
       */
      const setEach = async (want) => {
        for (let i = 0; i < 12; i += 1) {
          const candidates = folderRows().filter((entry) => {
            const caret = (entry.querySelector('.td-caret') || {}).textContent
            return want ? caret !== '\\u25be' : caret !== '\\u25b8'
          })
          if (candidates.length === 0) return true
          const row = want ? candidates[0] : candidates[candidates.length - 1]
          row.querySelector('.td-node-main').click()
          await wait(300)
        }
        return false
      }

      const baseline = childrenLists()
      const names = folderRows().map((row) => (row.querySelector('.td-node-label') || {}).textContent)
      push('the seeded groups are listed', names.length === 3 && childrenLists() > 0,
        'folders=' + names.join(',') + ' open=' + baseline)

      /*
       * ---- a search has to see into a folded group -------------------------
       *
       * Asserted with the groups folded *by hand*, so it is about the tree rather than
       * about the new button: a folded group that swallows the search result reads as
       * "the session is gone", and one button that folds everything would turn that
       * from an edge case into the normal state.
       */
      await setEach(true)
      await setEach(false)
      const foldedByHand = childrenLists() === 0
      const search = document.querySelector('[data-testid="tree-search"]')
      if (search) {
        setValue(search, 'edge-1')
        await wait(700)
        push('a search still finds a session inside a folded group',
          foldedByHand && !!rowNamed('edge-1'),
          'folded=' + foldedByHand + ' edge-1=' + (rowNamed('edge-1') ? 'visible' : 'hidden'))
        setValue(search, '')
        await wait(700)
      } else {
        push('a search still finds a session inside a folded group', false, 'no tree-search')
      }

      // ---- the one control that does all of it -----------------------------
      /*
       * Fold everything *including* the nested group before asking the button
       * anything: a nested group inside a folded parent is not a row any more, so
       * folding by hand alone leaves it open in the store — which is exactly what the
       * button's own direction is read from, and the first version of this probe
       * reported the button as "backwards" because of it.
       */
      await setEach(true)
      await setEach(false)
      const foldedState = await api.loadSessionTree()
      const allFolded = childrenLists() === 0 &&
        foldedState.folders.every((folder) => folder.expanded === false)

      push('the sessions tree offers one control to fold every group', !!foldAll(),
        foldAll() ? 'title=' + foldAll().getAttribute('title') : 'no [data-testid=tree-fold-all]')

      if (foldAll()) {
        push('and it offers to open them again while every group is folded',
          allFolded && foldAll().getAttribute('title') === 'Expand all groups',
          'folded=' + allFolded + ' title=' + foldAll().getAttribute('title'))

        foldAll().click()
        await wait(700)
        push('one click opens every group again',
          childrenLists() === baseline &&
            carets().filter((c) => c === '\\u25be').length === names.length,
          'open lists=' + childrenLists() + ' of ' + baseline + ' carets=' + carets().join(''))

        foldAll().click()
        await wait(700)
        push('one click folds every group, the nested ones included',
          childrenLists() === 0 && carets().every((c) => c === '\\u25b8'),
          'open lists=' + childrenLists() + ' carets=' + carets().join(''))

        const stored = await api.loadSessionTree()
        push('the fold is stored per folder, so leaving the page does not lose it',
          stored.folders.length > 0 &&
            stored.folders.every((folder) => folder.expanded === false),
          'expanded=' + JSON.stringify(stored.folders.map((f) => f.expanded)))

        push('and the sessions at the root are still listed',
          !!rowNamed('root-1'), 'root-1 ' + (rowNamed('root-1') ? 'visible' : 'missing'))

        const searchAgain = document.querySelector('[data-testid="tree-search"]')
        if (searchAgain) {
          setValue(searchAgain, 'edge-1')
          await wait(700)
          push('the fold control is offered but disabled while searching',
            !!foldAll() && foldAll().disabled === true,
            'button=' + !!foldAll() + ' disabled=' + (foldAll() ? foldAll().disabled : 'n/a'))
          setValue(searchAgain, '')
          await wait(700)
          push('clearing the search folds the groups back up',
            childrenLists() === 0, 'open lists=' + childrenLists())
        }

        // Leave the tree open for anything that runs after this suite.
        foldAll().click()
        await wait(500)
      }

      return out
    })()
  `

  try {
    const checks = await win.webContents.executeJavaScript(probe)
    report(checks)
  } catch (err) {
    report([{ name: 'treefold probe crashed', ok: false, detail: String((err && err.message) || err) }])
  }

  const failed = all.filter((c) => !c.ok)
  console.log(`\n${all.length - failed.length}/${all.length} checks passed`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('treefold probe crashed:', err)
    app.exit(1)
  })
)
