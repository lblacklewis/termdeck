/**
 * Derive accessible muted-text colours for each theme.
 *
 *   node scripts/tunecontrast.cjs [--write]
 *
 * `textFaint` and `textDim` were chosen by eye and several themes landed below
 * the WCAG AA threshold (3:1 for large/secondary text, 4.5:1 for body text).
 * This walks each colour toward the theme's own foreground until it clears the
 * target, keeping the hue close to the author's intent instead of replacing it
 * with a generic grey.
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'src', 'shared', 'themes.ts')

function hexToRgb(hex) {
  let v = hex.replace('#', '').trim()
  if (v.length === 3) v = v.split('').map((c) => c + c).join('')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
function toHex(rgb) {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  )
}
function lum(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a, b) {
  const la = lum(a)
  const lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t])
}

/** Move `color` toward `anchor` until it clears `target` against `bg`. */
function tune(color, bg, anchor, target) {
  if (ratio(color, bg) >= target) return color
  let best = color
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate = mix(color, anchor, t)
    best = candidate
    if (ratio(candidate, bg) >= target) return candidate
  }
  return best
}

const source = fs.readFileSync(FILE, 'utf8')
const write = process.argv.includes('--write')

// Parse each theme's ui block: id, scheme, bg, bgRaised, text, textDim, textFaint.
const themeRe =
  /id: '([^']+)',\s*\n\s*name: '[^']+',\s*\n\s*scheme: '(dark|light)',\s*\n\s*preview:[^\n]*\n\s*ui: \{([\s\S]*?)\n\s*\},/

let out = source
let changed = 0
const report = []

for (const match of source.matchAll(new RegExp(themeRe, 'g'))) {
  const [full, id, scheme, uiBlock] = match
  const get = (key) => {
    const m = new RegExp(`${key}: '([^']+)'`).exec(uiBlock)
    return m ? m[1] : null
  }

  const bg = get('bg')
  const bgRaised = get('bgRaised')
  const text = get('text')
  const textDim = get('textDim')
  const textFaint = get('textFaint')
  if (!bg || !bgRaised || !text || !textDim || !textFaint) continue

  // Muted text sits on raised surfaces as well as the base background, so a
  // colour must clear the target against whichever surface is worst for it.
  const anchor = text
  const worstSurface = (color) =>
    ratio(color, bg) <= ratio(color, bgRaised) ? bg : bgRaised

  const dimBase = worstSurface(textDim)
  const faintBase = worstSurface(textFaint)
  const tunedDim = tune(textDim, dimBase, anchor, 4.5)
  const tunedFaint = tune(textFaint, faintBase, anchor, 3.0)

  report.push({
    id,
    scheme,
    dim: `${textDim} (${ratio(textDim, dimBase).toFixed(2)}) -> ${tunedDim} (${ratio(tunedDim, dimBase).toFixed(2)})`,
    faint: `${textFaint} (${ratio(textFaint, faintBase).toFixed(2)}) -> ${tunedFaint} (${ratio(tunedFaint, faintBase).toFixed(2)})`
  })

  if (tunedDim !== textDim || tunedFaint !== textFaint) {
    changed++
    let next = full
    if (tunedDim !== textDim) next = next.replace(`textDim: '${textDim}'`, `textDim: '${tunedDim}'`)
    if (tunedFaint !== textFaint) {
      next = next.replace(`textFaint: '${textFaint}'`, `textFaint: '${tunedFaint}'`)
    }
    out = out.replace(full, next)
  }
}

console.log('theme            textDim                          textFaint')
for (const r of report) {
  console.log(`${r.id.padEnd(16)} ${r.dim.padEnd(32)} ${r.faint}`)
}

if (write) {
  fs.writeFileSync(FILE, out, 'utf8')
  console.log(`\nwrote ${FILE} (${changed} theme(s) adjusted)`)
} else {
  console.log(`\n${changed} theme(s) would change; re-run with --write`)
}
