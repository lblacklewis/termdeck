import type { ITerminalOptions, ITheme } from '@xterm/xterm'
import type { TerminalSettings, Theme } from '@shared/types'

/**
 * xterm theme derived from the active application theme, so the terminal always
 * matches the shell around it.
 */
export function terminalThemeFor(theme: Theme): ITheme {
  const t = theme.terminal
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite
  }
}

/** Terminal options derived from user settings. */
export function buildTerminalOptions(settings: TerminalSettings): ITerminalOptions {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    convertEol: false,
    macOptionIsMeta: true,
    // Selection is handled by copy-on-select, not by right-click word select.
    rightClickSelectsWord: false,
    // Padding comes from the surrounding panel, not xterm.
    scrollOnUserInput: true
  }
}
