/**
 * Extract user-visible English strings into `t(key, 'English')` calls.
 *
 *   node scripts/extract-i18n.cjs            # dry run: report what would change
 *   node scripts/extract-i18n.cjs --write    # rewrite the files, emit the catalog
 *
 * Run with the compiler API rather than regexes: "is this string a JSX text node
 * or a `label:` property?" is a syntax question, and a regex that guesses wrong
 * either misses strings or wraps something that must not be translated (test ids,
 * CSS class names, IPC channel names).
 *
 * What is translated:
 *   - JSX text children:            <h2>Save settings</h2>
 *   - JSX string attributes:        title="Add host"  placeholder="Filter"
 *   - UI-named object properties:   { id: 'connect', label: 'Connect' }
 *
 * What is not, on purpose: test ids, class names, IPC channels, keys of any kind,
 * font names, and template literals with substitutions (their word order is a
 * sentence, not a string — those are translated by hand where they matter).
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')
const WRITE = process.argv.includes('--write')
const TARGETS = [path.join(ROOT, 'src', 'renderer', 'src')]

/** Attributes whose value is shown to the user. */
const UI_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'aria-label',
  'label',
  'alt',
  'aria-description'
])

/** Property names whose string value is shown to the user. */
const UI_PROPERTIES = new Set([
  'label',
  'title',
  'subtitle',
  'placeholder',
  'description',
  'hint',
  'text',
  'message',
  'confirmLabel',
  'cancelLabel',
  'emptyText',
  'tooltip',
  'ariaLabel',
  'question',
  'body'
])

/**
 * Something worth translating: at least two letters in a row, at least one
 * lowercase, and not shaped like an identifier.
 *
 * "Terminal" and "Hosts" are labels and must move; "monospace", "id_rsa",
 * "github.com" and "td-hint" are values and must not — a lowercase word with no
 * space is a value, whatever it happens to contain. "OK" and "+" have no lowercase
 * letter at all and stay put for the same reason.
 */
function translatable(text) {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  if (!/[A-Za-z]{2}/.test(trimmed)) return false
  if (!/[a-z]/.test(trimmed)) return false
  if (!/ /.test(trimmed) && /^[a-z]/.test(trimmed)) return false
  // Paths and selectors. A leading full stop is *not* one: sentences split by an
  // inline <code> element arrive as ". Someone could be intercepting…".
  if (/^(\.{1,2}\/|\/|#)/.test(trimmed)) return false
  if (/^\.(js|ts|tsx|json|css|md|exe|zip|sh|conf|log|txt)\b/i.test(trimmed)) return false
  return true
}

function slug(text) {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (base || 'text').slice(0, 28).replace(/_+$/, '')
}

function areaOf(file) {
  return path
    .basename(file)
    .replace(/\.tsx?$/, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase()
}

const catalog = {}
const used = new Map()
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
for (const target of TARGETS) walk(target)

let changed = 0
let extracted = 0

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const area = areaOf(file)
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  /** node start -> replacement text, applied back to front. */
  const edits = []

  const keyFor = (english) => {
    const base = `${area}.${slug(english)}`
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    const key = count === 0 ? base : `${base}_${count + 1}`
    catalog[key] = english
    return key
  }

  const visit = (node) => {
    // JSX text: replace the whole text node with an expression container.
    if (ts.isJsxText(node)) {
      const raw = node.getText(sf)
      if (translatable(raw)) {
        const english = raw.replace(/\s+/g, ' ').trim()
        const key = keyFor(english)
        const expr = `{t('${key}', '${escape(english)}')}`
        /*
         * Keep the file's shape. A text node spanning lines keeps its own leading
         * whitespace — `getStart()` skips it, so the edit begins after it — and the
         * replacement only has to bring the closing tag back to its own line.
         */
        const trailing = raw.match(/\n([ \t]*)$/)
        const text =
          raw.includes('\n') && trailing ? `${expr}\n${trailing[1]}` : expr
        edits.push({ start: node.getStart(sf), end: node.getEnd(), text })
      }
      return
    }

    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf)
      if (UI_ATTRIBUTES.has(name) && ts.isStringLiteral(node.initializer)) {
        const english = node.initializer.text
        if (translatable(english)) {
          const key = keyFor(english)
          edits.push({
            start: node.initializer.getStart(sf),
            end: node.initializer.getEnd(),
            text: `{t('${key}', '${escape(english)}')}`
          })
        }
      }
      return
    }

    // A UI-named property only counts inside an object literal or a JSX prop
    // object; `label:` on a form element's own props is handled by the JSX case.
    if (ts.isPropertyAssignment(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf).replace(/['"]/g, '')
      if (UI_PROPERTIES.has(name) && translatable(node.initializer.text)) {
        const english = node.initializer.text
        const key = keyFor(english)
        edits.push({
          start: node.initializer.getStart(sf),
          end: node.initializer.getEnd(),
          text: `t('${key}', '${escape(english)}')`
        })
      }
      return
    }

    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)

  if (edits.length === 0) continue

  let out = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }

  // Make sure `t` is imported.
  if (!/\bimport\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*i18n'/.test(out)) {
    const rel = path.relative(path.dirname(file), path.join(ROOT, 'src', 'renderer', 'src', 'i18n'))
      .replace(/\\/g, '/')
    const spec = rel.startsWith('.') ? rel : './' + rel
    const depth = countImports(out)
    out = insertImport(out, `import { t } from '${spec}'`, depth)
  }

  changed += 1
  extracted += edits.length
  if (WRITE) fs.writeFileSync(file, out)
  console.log(`${WRITE ? 'wrote' : 'would'} ${path.relative(ROOT, file)} (+${edits.length})`)
}

function escape(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * The last line of the file's leading comment + import preamble.
 *
 * Tracks brace depth, because an import block that spans lines
 * (`import {\n  A,\n} from 'x'`) must be entered as a whole — inserting after its
 * first line puts the statement *inside* the braces, which is what happened the
 * first time this ran on App.tsx.
 */
function countImports(source) {
  const lines = source.split('\n')
  let last = -1
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      if (depth === 0) continue
      last = i
      continue
    }
    const isComment = /^\s*(\/\*|\*|\/\/)/.test(line)
    if (isComment && depth === 0 && last < 0) {
      last = i
      continue
    }
    const startsImport = /^\s*import\b/.test(line)
    const continuesImport = depth > 0 || /from\s+'[^']*'/.test(line)
    if (!startsImport && !continuesImport) break
    last = i
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
  }
  return last
}

function insertImport(source, statement, afterLine) {
  const lines = source.split('\n')
  const at = afterLine < 0 ? 0 : afterLine + 1
  lines.splice(at, 0, statement)
  return lines.join('\n')
}

if (WRITE) {
  const pending = path.join(ROOT, 'src', 'renderer', 'src', 'i18n', 'pending.json')
  const sorted = {}
  for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key]
  fs.writeFileSync(pending, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`\ncatalog: ${Object.keys(sorted).length} string(s) -> ${path.relative(ROOT, pending)}`)
}
console.log(`${changed} file(s), ${extracted} string(s) ${WRITE ? 'rewritten' : 'found'}`)
