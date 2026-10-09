import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc, loadSettingsForStartup } from './ipc'
import { sessionManager } from './sessions/SessionManager'
import { defaultScaleForWidth, setScreenDefaultScale } from './store/Stores'

const isDev = !app.isPackaged

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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    createWindow()
  })

  app.on('window-all-closed', () => {
    sessionManager.disposeAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    sessionManager.disposeAll()
  })
}
