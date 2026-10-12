import { BrowserWindow, ipcMain } from 'electron'

import { loadSettingsForStartup } from './ipc'

/**
 * Focus mode: one key, full screen, no chrome.
 *
 * The key is handled *here* rather than in the renderer for two reasons. Electron's
 * default menu already claims F11 for its own plain full screen, and a menu
 * accelerator is consumed in the browser process — the page never sees the key at
 * all. And `before-input-event` is the one place that can stop both the menu and
 * the page, so the toggle cannot run twice.
 *
 * The binding is read from settings on every key press rather than captured, so
 * re-binding it in Settings → Shortcuts works immediately.
 */

/** Does an input event satisfy a `Ctrl+Shift+F`-style binding? */
export function matchesBinding(binding: string, input: Electron.Input): boolean {
  const parts = binding
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return false

  let key = ''
  let ctrl = false
  let shift = false
  let alt = false
  let meta = false

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') ctrl = true
    else if (part === 'shift') shift = true
    else if (part === 'alt' || part === 'option') alt = true
    else if (['meta', 'cmd', 'command', 'win', 'super'].includes(part)) meta = true
    else key = part
  }
  if (!key) return false

  return (
    input.control === ctrl &&
    input.shift === shift &&
    input.alt === alt &&
    input.meta === meta &&
    input.key.toLowerCase() === key
  )
}

function focusBinding(): string {
  return loadSettingsForStartup().keybindings.find((b) => b.id === 'toggleFocus')?.keys ?? ''
}

/** Enter or leave full screen, reporting what actually happened. */
function setFullScreen(win: BrowserWindow, on: boolean): boolean {
  win.setFullScreen(on)
  return win.isFullScreen()
}

export function registerFocusIpc(): void {
  ipcMain.handle('app:setFullScreen', (event, on: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? setFullScreen(win, on === true) : false
  })

  ipcMain.handle('app:isFullScreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win ? win.isFullScreen() : false
  })
}

export function attachFocusMode(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const binding = focusBinding()
    if (!binding || !matchesBinding(binding, input)) return

    // Stops the menu accelerator *and* the page's own handler, so exactly one
    // toggle happens per press.
    event.preventDefault()
    const on = setFullScreen(win, !win.isFullScreen())
    win.webContents.send('app:focus-mode', on)
  })

  // Leaving full screen by any other route (an OS gesture, a future menu item)
  // must not leave the renderer hiding its chrome with nothing to show for it.
  const report = (): void => win.webContents.send('app:focus-mode', win.isFullScreen())
  win.on('enter-full-screen', report)
  win.on('leave-full-screen', report)
}
