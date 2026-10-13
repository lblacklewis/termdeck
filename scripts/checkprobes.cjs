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
 *
 * The second check is for escapes inside those literals. A template literal eats
 * them: `\/` arrives as `/` and `/^\//` becomes `/^//`, which is a syntax error
 * *in the renderer* — where `executeJavaScript` only reports "script failed to
 * execute" and the probe dies at runtime with no clue. The line numbers are not
 * recoverable from the outside, so this is a straight text scan.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SMOKE = path.join(__dirname, '..', 'smoke')
const files = fs.readdirSync(SMOKE).filter((f) => f.endsWith('.cjs')).sort()

/**
 * Escapes that a template literal would swallow, with the ones that are fine.
 *
 * `\n` and `\r` are deliberate almost everywhere (they are how a probe builds a
 * string with a newline), `\u001b` is used for control bytes, and `\$` is how a
 * literal dollar sign survives a template literal at all; everything else is a
 * trap. `\s`/`\d`/`\w`/`\/` are the ones that have actually bitten.
 */
const SWALLOWED = /\\[^nrt"'`\\0-9ux$]/g

let problems = 0
for (const file of files) {
  const full = path.join(SMOKE, file)
  const res = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
  if (res.status !== 0) {
    const message = (res.stderr || '').split('\n').find((l) => /Error|error/.test(l)) || 'parse failed'
    console.log(`FAIL  ${file} — ${message.trim()}`)
    problems++
    continue
  }

  const source = fs.readFileSync(full, 'utf8')

  /*
   * An odd number of backticks means one is unbalanced, and the usual cause is a
   * backtick inside a probe template — a comment quoting a selector — which ends
   * the template early. `node --check` can miss it: the rest of the injected script
   * then parses as ordinary statements, so the file is valid and the mistake only
   * surfaces at runtime as "x is not defined" in the middle of a suite.
   */
  const ticks = source.split('`').length - 1
  if (ticks % 2 !== 0) {
    console.log(
      `FAIL  ${file} — ${ticks} backticks (odd): a template literal is probably ending ` +
        'early; take the backticks out of the probe source'
    )
    problems++
  }

  const lines = source.split('\n')
  /** Only the injected templates are examined: a regex in ordinary code is fine. */
  let inTemplate = false
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!inTemplate) {
      const opens = /[=(]\s*`\s*$/.test(line) || /executeJavaScript\(\s*`\s*$/.test(line)
      if (opens) inTemplate = true
      return
    }
    // The closing backtick sits alone on its line (optionally with `)` or `,`).
    if (/^`\s*[),]?\s*$/.test(trimmed)) {
      inTemplate = false
      return
    }
    const hits = line.match(SWALLOWED)
    if (hits) {
      console.log(
        `FAIL  ${file}:${index + 1} — ${hits.join(', ')} inside a probe string is ` +
          'eaten by the template literal; build it without the backslash'
      )
      problems++
    }
  })
}

if (problems > 0) {
  console.log(`\n${problems} probe file(s) do not parse`)
  process.exit(1)
}
console.log(`probe scripts parse cleanly (${files.length} files)`)
