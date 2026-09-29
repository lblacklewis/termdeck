import { useEffect } from 'react'
import type { Theme } from '@shared/types'
import { findTheme } from '@shared/themes'

/** `#rgb` / `#rrggbb` to `[r, g, b]`. */
export function hexToRgb(hex: string): [number, number, number] {
  let value = hex.replace('#', '').trim()
  if (value.length === 3) value = value.split('').map((c) => c + c).join('')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ]
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Pick a readable ink colour for text on a coloured fill.
 *
 * Hardcoding white breaks themes with a bright accent (Gruvbox yellow is only
 * 1.7:1 against white), so the choice is made from the fill's luminance — and
 * the threshold sits well below 0.5 because a mid-tone accent like One Dark's
 * blue needs dark ink on it to clear 3:1, not just pale yellows.
 */
export function readableOn(background: string): string {
  const white = contrastRatio(background, '#ffffff')
  const black = contrastRatio(background, '#10131a')
  return black > white ? '#10131a' : '#ffffff'
}

/**
 * Derive the semantic surface tokens from a theme's base palette.
 *
 * Light themes previously inherited the dark fallbacks for these (they are
 * declared without `light` variants), which produced dark boxes with dark text.
 * Rather than duplicating every key in ten theme definitions, the surfaces are
 * computed from the theme's own background/scheme.
 */
function deriveSurfaces(theme: Theme): Record<string, string> {
  const dark = theme.scheme === 'dark'
  const ui = theme.ui

  /**
   * Hairline borders, a little softer than the theme's own value.
   *
   * Drawn by pulling each border partway toward the surface it sits on. The
   * theme borders were authored as solid separators and read as hard outlines
   * around every panel and control; the softened pair keeps the separation
   * without the drawn-on look, and stays legible in every theme because it is
   * derived rather than hand-picked per palette.
   */
  const soften = (border: string, towards: string, amount: number): string =>
    mix(border, towards, amount)

  return {
    '--td-border': soften(ui.border, ui.bg, dark ? 0.18 : 0.22),
    '--td-border-strong': soften(ui.borderStrong, ui.bg, dark ? 0.16 : 0.2),
    '--td-surface': dark ? ui.bgRaised : ui.bgSunken,
    '--td-surface-hover': dark ? lighten(ui.bgRaised, 0.07) : darken(ui.bgSunken, 0.05),
    '--td-elevated': dark ? lighten(ui.bgRaised, 0.12) : darken(ui.bg, 0.04),
    '--td-elevated-hover': dark ? lighten(ui.bgRaised, 0.18) : darken(ui.bg, 0.08),
    '--td-on-accent': readableOn(ui.accent),
    '--td-danger-soft': dark ? '#2a1a1c' : mix(ui.bg, '#c0392b', 0.1),
    '--td-danger-border': dark ? '#56302f' : mix(ui.bg, '#c0392b', 0.32),
    '--td-danger-text': dark ? '#ffb3b8' : darken(ui.danger, 0.12),
    '--td-warn-soft': dark ? '#2a2318' : mix(ui.bg, '#c47a1a', 0.12),
    '--td-warn-border': dark ? '#4a3c22' : mix(ui.bg, '#c47a1a', 0.34),
    '--td-warn-text': dark ? '#e6c07b' : darken(ui.orange, 0.16),
    '--td-folder-line': dark ? lighten(ui.bg, 0.09) : darken(ui.bg, 0.08)
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Blend toward white. */
function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return toHex([r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount])
}

/** Blend toward black. */
function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return toHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)])
}

/** Blend one colour into another by `amount` (0..1). */
function mix(base: string, other: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(base)
  const [r2, g2, b2] = hexToRgb(other)
  return toHex([r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount])
}

function toHex(rgb: number[]): string {
  return '#' + rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')
}

/**
 * Maps a theme onto the document as CSS custom properties.
 *
 * Every component styles itself from these variables, so switching themes is a
 * single write rather than a re-render of the whole tree.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement

  // `data-theme-scheme` drives the few places that need to branch on light/dark.
  root.dataset.themeId = theme.id
  root.dataset.themeScheme = theme.scheme

  const vars: Record<string, string> = {
    '--td-bg': theme.ui.bg,
    '--td-bg-raised': theme.ui.bgRaised,
    '--td-bg-sunken': theme.ui.bgSunken,
    '--td-border': theme.ui.border,
    '--td-border-strong': theme.ui.borderStrong,
    '--td-text': theme.ui.text,
    '--td-text-dim': theme.ui.textDim,
    '--td-text-faint': theme.ui.textFaint,
    '--td-accent': theme.ui.accent,
    '--td-accent-hover': theme.ui.accentHover,
    '--td-danger': theme.ui.danger,
    '--td-green': theme.ui.green,
    '--td-orange': theme.ui.orange,
    ...deriveSurfaces(theme)
  }

  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)

  // Shadows depend on the scheme: a soft shadow reads as grime on light themes.
  const dark = theme.scheme === 'dark'
  root.style.setProperty('--td-shadow-sm', dark ? '0 1px 2px rgba(0,0,0,.28)' : '0 1px 2px rgba(15,23,42,.07)')
  root.style.setProperty('--td-shadow-md', dark ? '0 6px 20px rgba(0,0,0,.34)' : '0 6px 20px rgba(15,23,42,.11)')
  root.style.setProperty('--td-shadow-lg', dark ? '0 22px 60px rgba(0,0,0,.5)' : '0 22px 60px rgba(15,23,42,.16)')
}

/** Applies the active theme whenever its id changes. */
export function useTheme(themeId: string): Theme {
  const theme = findTheme(themeId)

  // Depend on the id, not the theme object: `findTheme` returns a fresh lookup
  // each render, so the object identity is not a stable dependency.
  useEffect(() => {
    applyTheme(findTheme(themeId))
  }, [themeId])

  return theme
}
