/**
 * Catalog consistency.
 *
 *   node scripts/check-i18n.cjs
 *
 * Two failure modes worth catching, both of which are silent at runtime because a
 * missing translation falls back to English: a key in the catalog that no longer
 * exists in the source (a rename or a deleted string), and a key used in the source
 * twice with *different* English text (which would translate to the wrong sentence).
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')
const CATALOG = path.join(SRC, 'i18n', 'zh.ts')

const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'i18n') continue
      walk(full)
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full)
    }
  }
}
walk(SRC)

const used = new Map()
const conflicting = []
/** Prefixes used with a computed key, e.g. t('keybinding.' + binding.id, …). */
const prefixes = new Set()
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/t\(\s*'([A-Za-z0-9_]+\.)'\s*\+/g)) prefixes.add(match[1])
  const re = /t\(\s*'([^']+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g
  let match
  while ((match = re.exec(source))) {
    const [, key, english] = match
    const text = english.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    if (used.has(key) && used.get(key) !== text) {
      conflicting.push(`${key}: "${used.get(key)}" vs "${text}" (${path.relative(ROOT, file)})`)
    }
    used.set(key, text)
  }
}

const catalogSource = fs.readFileSync(CATALOG, 'utf8')
const catalogKeys = new Set(
  [...catalogSource.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
)

const stale = [...catalogKeys]
  .filter((key) => !used.has(key))
  .filter((key) => ![...prefixes].some((prefix) => key.startsWith(prefix)))
  .sort()
const missing = [...used.keys()].filter((key) => !catalogKeys.has(key)).sort()

console.log(`source keys: ${used.size}`)
console.log(`catalog keys: ${catalogKeys.size}`)
if (conflicting.length > 0) {
  console.log(`\nFAIL  one key, two English strings:`)
  for (const line of conflicting) console.log(`  ${line}`)
}
if (stale.length > 0) {
  console.log(`\nFAIL  catalog keys with no source use (${stale.length}):`)
  for (const key of stale) console.log(`  ${key}`)
}
if (missing.length > 0) {
  console.log(`\nnote  untranslated (${missing.length}) — these show English:`)
  for (const key of missing) console.log(`  ${key} = ${used.get(key)}`)
}

const failed = conflicting.length > 0 || stale.length > 0
console.log(failed ? '\ncatalog check failed' : '\ncatalog check passed')
process.exit(failed ? 1 : 0)
