import { app, type BrowserWindow } from 'electron'

/**
 * Development-only keyboard plumbing.
 *
 * The application menu itself lives in `menu.ts` — it has to exist on macOS and be
 * removed everywhere else, and that decision belongs with the roles that make it
 * necessary. What is left here is the pair of accelerators a development build wants
 * back (devtools and reload), and only in a development build: a keystroke that
 * reloads the app is not something to ship by accident.
 */

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
