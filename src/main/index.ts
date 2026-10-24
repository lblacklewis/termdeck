import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc, loadSettingsForStartup, stopAllTunnels } from './ipc'
import { attachFocusMode, registerFocusIpc } from './focus'
import { attachQuitConfirmation, registerQuitIpc, requestQuitConfirmation, isQuitting } from './quit'
import { attachDevShortcuts } from './shortcuts'
import { installApplicationMenu } from './menu'
import { sessionManager } from './sessions/SessionManager'
import { defaultScaleForWidth, setScreenDefaultScale } from './store/Stores'

const isDev = !app.isPackaged

/** Used as the macOS menu title and in its "Quit …" item. */
const APP_NAME = 'TermDeck'

/**
 * A starting size that suits the display it opens on.
 *
 * A fixed 1440x900 is cramped on a 2560px-wide monitor and oversized on a laptop
 * panel, so the window takes most of the work area while still leaving the
 * desktop visible. It is only the initial size: the user can resize it, and this
 * never changes the interface scale.
 */
function preferredWindowSize(): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  return {
    width: Math.min(1900, Math.max(1100, Math.round(width * 0.82))),
    height: Math.min(1300, Math.max(700, Math.round(height * 0.86)))
  }
}

/**
 * Seed the first-run interface scale from the display in front of us.
 *
 * Uses the *logical* work-area width, so an OS-level 200% scale on a 4K panel
 * (→ 1920 logical px) is already accounted for and stays at 100%.
 */
function seedDefaultScale(): void {
  setScreenDefaultScale(defaultScaleForWidth(screen.getPrimaryDisplay().workAreaSize.width))
}

function createWindow(): BrowserWindow {
  const size = preferredWindowSize()
  const win = new BrowserWindow({
    ...size,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1f27',
    title: 'TermDeck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  // Closing the window asks the user first: every open pane is a live login.
  attachQuitConfirmation(win)

  // Focus mode: full screen on one key, with the app's own chrome out of the way.
  attachFocusMode(win)

  // The two accelerators development still wants from the menu that is now gone.
  attachDevShortcuts(win)

  /**
   * Start at the saved interface scale.
   *
   * The renderer also sends this once it has loaded, but doing it here as well
   * means a 125% display never flashes a shrunken 100% layout on the way in.
   */
  win.webContents.setZoomFactor(loadSettingsForStartup().uiScale)

  // Keep external links out of the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// A single instance keeps one authoritative set of live SSH sessions.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    seedDefaultScale()
    registerIpc()
    registerQuitIpc()
    registerFocusIpc()

    /*
     * The application menu: none on Windows and Linux, a minimal App/Edit/Window
     * menu on macOS, where Edit's roles are what provide Cmd+C / Cmd+V / Cmd+A at
     * all. See `menu.ts` for why the Quit item is ours rather than the `quit` role.
     */
    installApplicationMenu({ appName: APP_NAME, askQuit: requestQuitConfirmation })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    createWindow()
  })

  app.on('window-all-closed', () => {
    sessionManager.disposeAll()
    stopAllTunnels()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    /*
     * Only once the quit is already confirmed.
     *
     * On macOS the Dock's own "Quit" calls `app.quit()` directly, before the
     * renderer has been asked anything — and the window's `close` then cancels
     * that quit if the user chooses to stay. Teardown here would have ended every
     * session behind the confirmation dialog, and cancelling would have left an
     * app with nothing in it. The confirmed path (`requestQuit`) sets the flag, and
     * `window-all-closed` disposes as well, so nothing is skipped.
     */
    if (!isQuitting()) return
    sessionManager.disposeAll()
    stopAllTunnels()
  })
}
