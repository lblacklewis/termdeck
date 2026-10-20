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

/**
 * The cursor shape to hand xterm.
 *
 * xterm has no *active* outline cursor: `cursorStyle` takes block, bar and
 * underline, and the hollow box it can draw is the one it shows while the
 * terminal is unfocused. So "outline" goes to xterm as a block, and our stylesheet
 * draws that block hollow instead — the host carries `data-cursor-style` so the
 * CSS knows which shape was actually asked for.
 */
export function xtermCursorStyle(
  style: TerminalSettings['cursorStyle']
): 'block' | 'bar' | 'underline' {
  return style === 'outline' ? 'block' : style
}

/**
 * What a double-click stops at.
 *
 * xterm's default is ` ()[]{}',"` plus a backtick, which leaves the colon inside a
 * word: double-clicking `key` in `key: value` selected `key:` and put the separator on
 * the clipboard, where it is purely in the way. The comma and semicolon are the same
 * kind of trailing punctuation, so they go in too. The `=` is deliberately *not* here —
 * it sits inside a token (`--flag=value`, `KEY=value`) far more often than after one.
 */
const WORD_SEPARATOR = ' ()[]{}\',"`:,;'

/** Terminal options derived from user settings. */
export function buildTerminalOptions(settings: TerminalSettings): ITerminalOptions {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorStyle: xtermCursorStyle(settings.cursorStyle),
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    convertEol: false,
    macOptionIsMeta: true,
    // Selection is handled by copy-on-select, not by right-click word select.
    rightClickSelectsWord: false,
    wordSeparator: WORD_SEPARATOR,
    // Padding comes from the surrounding panel, not xterm.
    scrollOnUserInput: true
  }
}
