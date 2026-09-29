/**
 * Second pass: sweep the remaining surface tints onto theme variables.
 * Run with `node scripts/themetokens2.cjs` after `themetokens.cjs`.
 */
const fs = require('node:fs')
const path = require('node:path')

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles', 'global.css')

/** Colours that only appeared inside component rules, not as token values. */
const MAP = {
  '#3a2226': 'var(--td-danger-soft)',
  '#5d3038': 'var(--td-danger-border)',
  '#4a2a30': 'var(--td-danger-soft)',
  '#7a3d47': 'var(--td-danger-border)',
  '#e8c9cb': 'var(--td-text)',
  '#141821': 'var(--td-bg)',
  '#151a22': 'var(--td-surface)',
  '#161a21': 'var(--td-bg-sunken)',
  '#33415a': 'var(--td-border-strong)',
  '#1d222c': 'var(--td-border)',
  '#1d232e': 'var(--td-surface)',
  '#3a4861': 'var(--td-border-strong)'
}

const isToken = (line) => /^\s*--td-[a-z-]+\s*:/.test(line)

const lines = fs.readFileSync(FILE, 'utf8').split('\n')
let replaced = 0
for (let i = 0; i < lines.length; i++) {
  if (isToken(lines[i])) continue
  let line = lines[i]
  for (const [from, to] of Object.entries(MAP)) {
    const re = new RegExp(from + '(?![0-9a-fA-F])', 'g')
    const m = line.match(re)
    if (m) {
      replaced += m.length
      line = line.replace(re, to)
    }
  }
  lines[i] = line
}
fs.writeFileSync(FILE, lines.join('\n'), 'utf8')

const rest = [...lines.join('\n').matchAll(/#[0-9a-fA-F]{3,6}\b/g)].map((m) => m[0])
const counts = {}
for (const hex of rest) counts[hex] = (counts[hex] || 0) + 1
console.log(`replaced ${replaced}`)
console.log('remaining (expect only token definitions):')
console.log(Object.entries(counts).map(([h, c]) => `${c}x ${h}`).join('  '))
