/**
 * The application menu — on macOS, and only on macOS.
 *
 * On Windows and Linux the menu is removed outright (`Menu.setApplicationMenu(null)`),
 * and that is still right there: the default menu is invisible until `Alt` is
 * pressed, and every `Alt`-based shortcut in the app would also reveal the menu bar,
 * which shifts the whole layout down for as long as the modifier is held. The app has
 * its own UI for everything the default menu offered.
 *
 * macOS is the opposite case, and it is not a matter of taste: `Cmd+C`, `Cmd+V`,
 * `Cmd+X`, `Cmd+A` and `Cmd+Z` are provided by the **Edit menu's roles**. Without a
 * menu they do not exist at all — not "unbound by us", but not offered by the system
 * — so a Mac build with no menu has no working copy/paste in any input field. The App
 * and Window menus are needed for the same reason (`Cmd+Q`, `Cmd+H`, `Cmd+M`).
 *
 * Three deliberate departures from the standard menu:
 *
 *  - **Quit asks first.** The plain `quit` role calls `app.quit()` immediately, and a
 *    quit tears down every live SSH login. Every other path into a quit (the close
 *    button, the quit shortcut) goes through the in-app confirmation, so this one
 *    does too: the item is a custom entry that asks the renderer. The macOS Dock menu
 *    still calls `app.quit()` directly, which is why the teardown in `index.ts` only
 *    runs once a quit has been confirmed.
 *  - **`Cmd+W` is not the window close.** On a Mac `Cmd+W` is the app's own binding
 *    for "close the active pane" (see `MAC_BINDING_DEFAULTS` in
 *    `shared/platform.ts`); the system window close sits on `Cmd+Shift+W` so the two
 *    are not fighting over one chord. Copy and paste are the app's own bindings on
 *    the same modifier, so the Edit roles below cover ordinary text fields and the
 *    terminal keeps its own paths.
 *  - **Settings lives in the App menu** (`Cmd+,`), which is where a Mac user looks for
 *    it; the renderer's binding for the same key is unbound on darwin so exactly one
 *    of the two answers it.
 */
import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  /** Shown as the menu title and in "Quit …". */
  appName: string
  /** Ask the renderer to show the quit confirmation. */
  askQuit: () => void
  /** Ask the renderer to open the settings drawer. */
  openSettings: () => void
}

/**
 * The menu for a platform, or `null` for "no application menu".
 *
 * Returned as plain data rather than built here, because the parts that matter —
 * which roles exist, and which chords the menu claims — are exactly the parts that
 * can only be checked on a machine with no Mac on it.
 */
export function menuTemplateFor(
  platform: string,
  actions: MenuActions
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null

  return [
    {
      label: actions.appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        /*
         * Settings lives here, not in the shortcut table.
         *
         * `Cmd+,` opening the settings is a Mac *menu* convention: people look for
         * it under the application menu, and a Mac build that answers the chord but
         * shows nothing in the menu looks like it has no settings at all. The
         * renderer's own binding for it is therefore unbound on darwin (see
         * `MAC_BINDING_DEFAULTS`), so the two are not both listening for one key.
         *
         * The label is "Settings…" rather than "Preferences…": Apple renamed the
         * item in macOS 13, and this builds for the versions where that is current.
         */
        { label: 'Settings…', accelerator: 'Command+,', click: () => actions.openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // Not `role: 'quit'`: see the note at the top of this file.
        {
          label: 'Quit ' + actions.appName,
          accelerator: 'Command+Q',
          click: () => actions.askQuit()
        }
      ]
    },
    {
      label: 'Edit',
      // These roles are what give the settings fields a working Cmd+C / Cmd+V /
      // Cmd+A. xterm handles its own copy and paste through the app's bindings;
      // these cover every ordinary text input.
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // The system's window close, moved off Cmd+W so the pane close can have it.
        { label: 'Close Window', role: 'close', accelerator: 'Command+Shift+W' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
}

/**
 * Install the menu for the running platform.
 *
 * Called once at startup; on Windows and Linux this is the same
 * `setApplicationMenu(null)` it has always been.
 */
export function installApplicationMenu(actions: MenuActions): void {
  const template = menuTemplateFor(process.platform, actions)
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null)
}
