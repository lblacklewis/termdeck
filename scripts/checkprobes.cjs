/**
 * Parse-check every probe before a suite run.
 *
 *   node scripts/checkprobes.cjs
 *
 * Each probe builds the code it runs in the renderer as a template literal, so a
 * stray backtick inside that literal — the natural way to quote a selector in a
 * comment — ends the literal early. The file then fails to parse, and because the
 * suites are run through a pipe the only symptom is a run that hangs until it is
 * killed. `node --check` turns that into an immediate, named failure.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SMOKE = path.join(__dirname, '..', 'smoke')
const files = fs.readdirSync(SMOKE).filter((f) => f.endsWith('.cjs')).sort()

let problems = 0
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', path.join(SMOKE, file)], { encoding: 'utf8' })
  if (res.status !== 0) {
    const message = (res.stderr || '').split('\n').find((l) => /Error|error/.test(l)) || 'parse failed'
    console.log(`FAIL  ${file} — ${message.trim()}`)
    problems++
  }
}

if (problems > 0) {
  console.log(`\n${problems} probe file(s) do not parse`)
  process.exit(1)
}
console.log(`probe scripts parse cleanly (${files.length} files)`)
