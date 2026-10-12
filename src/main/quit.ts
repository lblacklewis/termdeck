import { app, BrowserWindow, ipcMain } from 'electron'

import { sessionManager } from './sessions/SessionManager'

/**
 * The second chance before the app closes.
 *
 * Quitting is destructive here in a way it is not in most apps: every open pane
 * is a live SSH login or a local shell, and closing the window ends all of them
 * with no undo. So the window's `close` is held in the main process and handed to
 * the renderer, which shows an ordinary in-app dialog and calls `quitApp()` to let
 * the close through.
 *
 * Held in main rather than in the renderer because the X button, Alt+F4 and
 * "Close window" from the taskbar all arrive here as a single `close` event:
 * intercepting it covers every path to a quit at once, including the ones the
 * renderer never hears about.
 */

/** Set once the user has confirmed, so the retried close goes through. */
let quitting = false

/** Quit for real. Idempotent, and the only way past the confirmation. */
export function requestQuit(): void {
  quitting = true
  app.quit()
}

/** True once a quit has been confirmed. Used by the window close handler. */
export function isQuitting(): boolean {
  return quitting
}

export function registerQuitIpc(): void {
  ipcMain.on('app:quit', () => requestQuit())
}

/**
 * Hold this window's close until the renderer confirms.
 *
 * A renderer that is already gone cannot be asked, so in that case the close is
 * allowed rather than trapping the user in a window that will not shut.
 */
export function attachQuitConfirmation(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (quitting) return
    if (win.webContents.isDestroyed()) {
      requestQuit()
      return
    }
    event.preventDefault()
    win.webContents.send('app:quit-requested', { sessions: sessionManager.list().length })
  })
}
