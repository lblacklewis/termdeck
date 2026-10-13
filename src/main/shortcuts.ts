import { app, Menu, type BrowserWindow } from 'electron'

/**
 * Window-level keyboard plumbing that has to happen in the main process.
 *
 * Two separate things live here, both about not fighting the page:
 *
 *  - the application menu is removed outright. The default one is invisible until
 *    `Alt` is pressed, and every `Alt`-based shortcut in the app (`Alt`+digit to
 *    switch rail sections, `Alt+[` / `Alt+]`) would also reveal the menu bar,
 *    which shifts the whole layout down for as long as the modifier is held. The
 *    app has its own UI for everything the default menu offered.
 *
 *  - development gets back the two accelerators that were doing real work
 *    (devtools and reload), and only in a development build: a keystroke that
 *    reloads the app is not something to ship by accident.
 */

export function removeApplicationMenu(): void {
  Menu.setApplicationMenu(null)
}

export function attachDevShortcuts(win: BrowserWindow): void {
  if (app.isPackaged) return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    const devtools =
      input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (devtools) {
      event.preventDefault()
      win.webContents.toggleDevTools()
      return
    }

    if (input.control && !input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault()
      win.webContents.reload()
    }
  })
}
