/**
 * One-off codemod: repoint hardcoded colours in global.css at theme variables.
 *
 * Run with `node scripts/themetokens.cjs`. Kept in the repo because it documents
 * the mapping and can be re-run if new hardcoded colours creep in.
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles', 'global.css')

/** Longest keys first so `#1e2531` is not clobbered by a shorter prefix. */
const MAP = {
  '#2a1a1c': 'var(--td-danger-soft)',
  '#ffb3b8': 'var(--td-danger-text)',
  '#56302f': 'var(--td-danger-border)',
  '#2a2318': 'var(--td-warn-soft)',
  '#4a3c22': 'var(--td-warn-border)',
  '#e6c07b': 'var(--td-warn-text)',
  '#1a1f28': 'var(--td-bg-raised)',
  '#1b212b': 'var(--td-bg-raised)',
  '#1d2430': 'var(--td-bg-raised)',
  '#212836': 'var(--td-surface)',
  '#263041': 'var(--td-elevated)',
  '#2b3342': 'var(--td-elevated-hover)',
  '#2b3240': 'var(--td-surface-hover)',
  '#1e2531': 'var(--td-surface-hover)',
  '#1f2531': 'var(--td-surface-hover)',
  '#28303f': 'var(--td-surface-hover)',
  '#2b3543': 'var(--td-surface-hover)',
  '#23303f': 'var(--td-elevated)',
  '#212b3a': 'var(--td-elevated)',
  '#1d2b3f': 'var(--td-elevated)',
  '#1e2733': 'var(--td-surface-hover)',
  '#3c4759': 'var(--td-border-strong)',
  '#2b3purple': 'var(--td-elevated)',
  '#fff': 'var(--td-on-accent)'
}

let css = fs.readFileSync(FILE, 'utf8')
let replaced = 0

/**
 * Token definitions must not be rewritten: `--td-surface: #1a1f28` and a rule
 * using `border: 1px solid #1a1f28` share the same literal, and replacing both
 * turns the former into a self-reference.
 */
function isTokenDefinition(line) {
  return /^\s*--td-[a-z-]+\s*:/.test(line)
}

const lines = css.split('\n')
for (let i = 0; i < lines.length; i++) {
  if (isTokenDefinition(lines[i])) continue
  let line = lines[i]
  for (const [from, to] of Object.entries(MAP).sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(from + '(?![0-9a-fA-F])', 'g')
    const matches = line.match(re)
    if (matches) {
      replaced += matches.length
      line = line.replace(re, to)
    }
  }
  lines[i] = line
}
css = lines.join('\n')

fs.writeFileSync(FILE, css, 'utf8')

const remaining = [...css.matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0])
const counts = {}
for (const hex of remaining) counts[hex] = (counts[hex] || 0) + 1

console.log(`replaced ${replaced} hardcoded colours`)
console.log('remaining hex values (these should only be token definitions):')
for (const [hex, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}x ${hex}`)
}
