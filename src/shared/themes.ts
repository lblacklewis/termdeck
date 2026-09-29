/**
 * Built-in colour themes.
 *
 * Both the application shell and the terminal are described here, so adding a
 * theme is a data-only change. The renderer converts a `Theme` into CSS custom
 * properties, and passes `terminal` straight to xterm.
 */
import type { Theme } from './types'

const TERMIUS_DARK: Theme = {
  id: 'termius-dark',
  name: 'Termius Dark',
  scheme: 'dark',
  preview: ['#1c2430', '#252e3d', '#4a9eff'],
  ui: {
    bg: '#1c2430',
    bgRaised: '#232c3a',
    bgSunken: '#151b24',
    border: '#2e3846',
    borderStrong: '#3d4a5c',
    text: '#e8eef6',
    textDim: '#94a3b8',
    textFaint: '#6b7c93',
    accent: '#4a9eff',
    accentHover: '#6db0ff',
    danger: '#ef5350',
    green: '#4caf7d',
    orange: '#f5a623',
    overlay: 'rgba(255, 255, 255, 0.04)'
  },
  terminal: {
    background: '#1c2430',
    foreground: '#e8eef6',
    cursor: '#4a9eff',
    cursorAccent: '#1c2430',
    selectionBackground: '#2f4a6d',
    black: '#232c3a',
    red: '#ef5350',
    green: '#4caf7d',
    yellow: '#f5c542',
    blue: '#4a9eff',
    magenta: '#b47cd8',
    cyan: '#4dd0e1',
    white: '#e8eef6',
    brightBlack: '#6b7c93',
    brightRed: '#ff7b78',
    brightGreen: '#6dd39c',
    brightYellow: '#ffd76b',
    brightBlue: '#7cbcff',
    brightMagenta: '#c99ae8',
    brightCyan: '#7ce0ec',
    brightWhite: '#ffffff'
  }
}

/**
 * The palette from the Termius host-list screenshot: white panes, a pale grey
 * chrome, hairline borders and a single saturated blue accent.
 */
const TERMIUS_LIGHT: Theme = {
  id: 'termius-light',
  name: 'Termius Light',
  scheme: 'light',
  preview: ['#ffffff', '#f5f7fa', '#2f7de1'],
  ui: {
    bg: '#f5f7fa',
    bgRaised: '#ffffff',
    bgSunken: '#fafbfd',
    border: '#e2e8f0',
    borderStrong: '#cbd5e1',
    text: '#1f2b3d',
    textDim: '#5a6b80',
    textFaint: '#7c90a4',
    accent: '#2f7de1',
    accentHover: '#1f6cd0',
    danger: '#d93b3b',
    green: '#1f9d63',
    orange: '#c47a1a',
    overlay: 'rgba(15, 23, 42, 0.03)'
  },
  terminal: {
    background: '#ffffff',
    foreground: '#1f2b3d',
    cursor: '#2f7de1',
    cursorAccent: '#ffffff',
    selectionBackground: '#cfe0ff',
    black: '#1f2b3d',
    red: '#d93b3b',
    green: '#1f9d63',
    yellow: '#a97b0f',
    blue: '#2f7de1',
    magenta: '#8b5cf6',
    cyan: '#0e8f9e',
    white: '#eef2f7',
    brightBlack: '#8296ab',
    brightRed: '#e56565',
    brightGreen: '#28b573',
    brightYellow: '#c8951f',
    brightBlue: '#5182f0',
    brightMagenta: '#a17cf8',
    brightCyan: '#1aa5b5',
    brightWhite: '#ffffff'
  }
}

/** A softer light option: cool grey chrome, indigo accent. */
const SLATE_LIGHT: Theme = {
  id: 'slate-light',
  name: 'Slate Light',
  scheme: 'light',
  preview: ['#ffffff', '#f1f3f7', '#5b6ee1'],
  ui: {
    bg: '#f1f3f7',
    bgRaised: '#ffffff',
    bgSunken: '#f8f9fc',
    border: '#dfe3ea',
    borderStrong: '#c6ccd8',
    text: '#232a36',
    textDim: '#5f6b7d',
    textFaint: '#7f8c9d',
    accent: '#5b6ee1',
    accentHover: '#4a5dd0',
    danger: '#cf4141',
    green: '#2a9463',
    orange: '#b8741c',
    overlay: 'rgba(15, 23, 42, 0.03)'
  },
  terminal: {
    background: '#ffffff',
    foreground: '#232a36',
    cursor: '#5b6ee1',
    cursorAccent: '#ffffff',
    selectionBackground: '#d9ddff',
    black: '#232a36',
    red: '#cf4141',
    green: '#2a9463',
    yellow: '#96700f',
    blue: '#4a5dd0',
    magenta: '#8b5cf6',
    cyan: '#0f8b99',
    white: '#eef0f5',
    brightBlack: '#8794a6',
    brightRed: '#dc5f5f',
    brightGreen: '#33aa73',
    brightYellow: '#b38a1f',
    brightBlue: '#6b7ce8',
    brightMagenta: '#a17cf8',
    brightCyan: '#1aa1b0',
    brightWhite: '#ffffff'
  }
}

const MIDNIGHT: Theme = {
  id: 'midnight',
  name: 'Midnight',
  scheme: 'dark',
  preview: ['#0a0e14', '#131a24', '#2dd4bf'],
  ui: {
    bg: '#0a0e14',
    bgRaised: '#121822',
    bgSunken: '#05080c',
    border: '#1e2733',
    borderStrong: '#2c3948',
    text: '#dbe4ef',
    textDim: '#8296ac',
    textFaint: '#556678',
    accent: '#2dd4bf',
    accentHover: '#52e0cf',
    danger: '#f2777a',
    green: '#5fd38d',
    orange: '#e0a458',
    overlay: 'rgba(45, 212, 191, 0.05)'
  },
  terminal: {
    background: '#0a0e14',
    foreground: '#dbe4ef',
    cursor: '#2dd4bf',
    cursorAccent: '#0a0e14',
    selectionBackground: '#1d4a52',
    black: '#131a24',
    red: '#f2777a',
    green: '#5fd38d',
    yellow: '#e0c46c',
    blue: '#5aa9f0',
    magenta: '#c397d8',
    cyan: '#2dd4bf',
    white: '#dbe4ef',
    brightBlack: '#556678',
    brightRed: '#ff9a9d',
    brightGreen: '#82e3aa',
    brightYellow: '#f0d78c',
    brightBlue: '#7cc0f7',
    brightMagenta: '#d7b3e8',
    brightCyan: '#63e6d6',
    brightWhite: '#ffffff'
  }
}

const CARBON: Theme = {
  id: 'carbon',
  name: 'Carbon',
  scheme: 'dark',
  preview: ['#161616', '#222222', '#f0a33e'],
  ui: {
    bg: '#161616',
    bgRaised: '#1f1f1f',
    bgSunken: '#0f0f0f',
    border: '#2c2c2c',
    borderStrong: '#3d3d3d',
    text: '#ececec',
    textDim: '#a0a0a0',
    textFaint: '#6e6e6e',
    accent: '#f0a33e',
    accentHover: '#ffb75c',
    danger: '#ee6b6b',
    green: '#8ecf7a',
    orange: '#f0a33e',
    overlay: 'rgba(255, 255, 255, 0.04)'
  },
  terminal: {
    background: '#161616',
    foreground: '#ececec',
    cursor: '#f0a33e',
    cursorAccent: '#161616',
    selectionBackground: '#4a3a1e',
    black: '#222222',
    red: '#ee6b6b',
    green: '#8ecf7a',
    yellow: '#f0c674',
    blue: '#7ab6e8',
    magenta: '#c39ac9',
    cyan: '#7fd0c8',
    white: '#ececec',
    brightBlack: '#6e6e6e',
    brightRed: '#ff8f8f',
    brightGreen: '#a8e396',
    brightYellow: '#ffd88f',
    brightBlue: '#9ccbf0',
    brightMagenta: '#d7b3db',
    brightCyan: '#9ce0d8',
    brightWhite: '#ffffff'
  }
}

const NORD: Theme = {
  id: 'nord',
  name: 'Nord',
  scheme: 'dark',
  preview: ['#2e3440', '#3b4252', '#88c0d0'],
  ui: {
    bg: '#2e3440',
    bgRaised: '#353c4a',
    bgSunken: '#272c36',
    border: '#3f4759',
    borderStrong: '#4c566a',
    text: '#eceff4',
    textDim: '#a8b2c4',
    textFaint: '#7b869c',
    accent: '#88c0d0',
    accentHover: '#a3d4e0',
    danger: '#bf616a',
    green: '#a3be8c',
    orange: '#ebcb8b',
    overlay: 'rgba(236, 239, 244, 0.045)'
  },
  terminal: {
    background: '#2e3440',
    foreground: '#eceff4',
    cursor: '#88c0d0',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#d08770',
    brightGreen: '#b9d4a0',
    brightYellow: '#f0d9a0',
    brightBlue: '#9db8d6',
    brightMagenta: '#c9a5c4',
    brightCyan: '#a3d8e2',
    brightWhite: '#ffffff'
  }
}

const DRACULA: Theme = {
  id: 'dracula',
  name: 'Dracula',
  scheme: 'dark',
  preview: ['#282a36', '#343746', '#bd93f9'],
  ui: {
    bg: '#282a36',
    bgRaised: '#30323f',
    bgSunken: '#21222c',
    border: '#3a3d4d',
    borderStrong: '#4b4f63',
    text: '#f8f8f2',
    textDim: '#a8adc4',
    textFaint: '#757a98',
    accent: '#bd93f9',
    accentHover: '#cdaaff',
    danger: '#ff5555',
    green: '#50fa7b',
    orange: '#ffb86c',
    overlay: 'rgba(248, 248, 242, 0.045)'
  },
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#bd93f9',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#6272a4',
    magenta: '#bd93f9',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#8ba0d8',
    brightMagenta: '#d6acff',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff'
  }
}

const ONE_DARK: Theme = {
  id: 'one-dark',
  name: 'One Dark',
  scheme: 'dark',
  preview: ['#21252b', '#282c34', '#61afef'],
  ui: {
    bg: '#21252b',
    bgRaised: '#282c34',
    bgSunken: '#1a1d22',
    border: '#333842',
    borderStrong: '#434a56',
    text: '#d7dae0',
    textDim: '#939aa6',
    textFaint: '#6d7580',
    accent: '#61afef',
    accentHover: '#7cc0ff',
    danger: '#e06c75',
    green: '#98c379',
    orange: '#d19a66',
    overlay: 'rgba(255, 255, 255, 0.04)'
  },
  terminal: {
    background: '#282c34',
    foreground: '#d7dae0',
    cursor: '#61afef',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    black: '#21252b',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d7dae0',
    brightBlack: '#5c6370',
    brightRed: '#ef8a92',
    brightGreen: '#b3d68f',
    brightYellow: '#f0d197',
    brightBlue: '#8cc8ff',
    brightMagenta: '#d9a9f5',
    brightCyan: '#7fd6e0',
    brightWhite: '#ffffff'
  }
}

const GRUVBOX: Theme = {
  id: 'gruvbox',
  name: 'Gruvbox',
  scheme: 'dark',
  preview: ['#282828', '#3c3836', '#fabd2f'],
  ui: {
    bg: '#282828',
    bgRaised: '#32302f',
    bgSunken: '#1d2021',
    border: '#3c3836',
    borderStrong: '#504945',
    text: '#ebdbb2',
    textDim: '#bdae93',
    textFaint: '#928374',
    accent: '#fabd2f',
    accentHover: '#ffd05c',
    danger: '#fb4934',
    green: '#b8bb26',
    orange: '#fe8019',
    overlay: 'rgba(235, 219, 178, 0.05)'
  },
  terminal: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#fabd2f',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    black: '#3c3836',
    red: '#fb4934',
    green: '#b8bb26',
    yellow: '#fabd2f',
    blue: '#83a598',
    magenta: '#d3869b',
    cyan: '#8ec07c',
    white: '#ebdbb2',
    brightBlack: '#928374',
    brightRed: '#ff665c',
    brightGreen: '#d5d94a',
    brightYellow: '#ffd05c',
    brightBlue: '#a3c4b5',
    brightMagenta: '#eaa8bd',
    brightCyan: '#aee0a0',
    brightWhite: '#fbf1c7'
  }
}

const CATPPUCCIN: Theme = {
  id: 'catppuccin',
  name: 'Catppuccin Mocha',
  scheme: 'dark',
  preview: ['#1e1e2e', '#313244', '#cba6f7'],
  ui: {
    bg: '#1e1e2e',
    bgRaised: '#272738',
    bgSunken: '#181825',
    border: '#313244',
    borderStrong: '#45475a',
    text: '#cdd6f4',
    textDim: '#a6adc8',
    textFaint: '#6e7288',
    accent: '#cba6f7',
    accentHover: '#d9bdfa',
    danger: '#f38ba8',
    green: '#a6e3a1',
    orange: '#fab387',
    overlay: 'rgba(205, 214, 244, 0.045)'
  },
  terminal: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f7a3b8',
    brightGreen: '#bce8b8',
    brightYellow: '#fbecc2',
    brightBlue: '#a5c8fb',
    brightMagenta: '#dcc0fa',
    brightCyan: '#b0ece3',
    brightWhite: '#ffffff'
  }
}

const PAPER: Theme = {
  id: 'paper',
  name: 'Paper',
  scheme: 'light',
  preview: ['#faf9f7', '#eeece8', '#b45309'],
  ui: {
    bg: '#faf9f7',
    bgRaised: '#ffffff',
    bgSunken: '#f0eeea',
    border: '#e2ded7',
    borderStrong: '#cbc5bb',
    text: '#2b2a28',
    textDim: '#6b6862',
    textFaint: '#948f88',
    accent: '#b45309',
    accentHover: '#96450a',
    danger: '#c0392b',
    green: '#2f7d4f',
    orange: '#b45309',
    overlay: 'rgba(43, 42, 40, 0.035)'
  },
  terminal: {
    background: '#faf9f7',
    foreground: '#2b2a28',
    cursor: '#b45309',
    cursorAccent: '#faf9f7',
    selectionBackground: '#f0dfc4',
    black: '#2b2a28',
    red: '#c0392b',
    green: '#2f7d4f',
    yellow: '#9a7b1f',
    blue: '#2c5f9e',
    magenta: '#7d4a9e',
    cyan: '#1f7a80',
    white: '#eeece8',
    brightBlack: '#96918a',
    brightRed: '#d4544a',
    brightGreen: '#3d9a63',
    brightYellow: '#b8942e',
    brightBlue: '#3f74b5',
    brightMagenta: '#9560b8',
    brightCyan: '#2f9299',
    brightWhite: '#ffffff'
  }
}

export const THEMES: Theme[] = [
  TERMIUS_DARK,
  TERMIUS_LIGHT,
  SLATE_LIGHT,
  MIDNIGHT,
  CARBON,
  ONE_DARK,
  DRACULA,
  NORD,
  GRUVBOX,
  CATPPUCCIN,
  PAPER
]

export const DEFAULT_THEME_ID = TERMIUS_DARK.id

export function findTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? TERMIUS_DARK
}
