/**
 * The full gate, without the 49 rebuilds.
 *
 *   node scripts/verifyfast.cjs [--list] [--only rest,s3] [--jobs N]
 *                               [--skip-build] [--no-checks] [--timeout MIN]
 *
 * `npm run verify` rebuilds the app before every suite: 49 suites at 6-8 s a
 * build is most of an hour of pure wait. The suites never change `out/`, so
 * this runner builds ONCE and then executes each suite's own command (taken
 * from package.json, with the `npm run build && ` prefix stripped) against the
 * same output. Order comes from the `verify` script itself, so the two stay in
 * step by construction.
 *
 * Output discipline: one summary line per step on the console, the full detail
 * of every step in node_modules/.verify/<step>.log (gitignored, never ships),
 * and a failing step prints its FAIL lines plus a short tail.
 *
 * Going narrow: `--only rest,s3` runs the four checks plus the named suites.
 * That is for fixing something unrelated to the rest of the app; the risk
 * tiers live in docs/交接-下一批需求.md and the floor is fixed: a full run
 * before pushing to origin, the original `npm run verify` before a release.
 *
 * Parallelism is opt-in (--jobs N) because most suites reach the same test
 * SSH box. Suites are tagged serial from evidence, not from a hand-kept list:
 * their source mentions the chain host, or their command has no isolated
 * --user-data-dir, or they are known load-sensitive. A serial suite runs
 * alone; everything else fills the worker slots in the documented order.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const LOG_DIR = path.join(ROOT, 'node_modules', '.verify')
const SMOKE_DATA = path.join(ROOT, 'node_modules', '.smoke-data')
/** The suites that share one real SSH box or dislike load, from the handover. */
const CHAIN_HOST = '82.156.226.192'
const LOAD_SENSITIVE = ['smoke:memory', 'smoke:gesture', 'smoke:geom']

/* ---- the plan ----------------------------------------------------------- */

function readPlan() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const chain = (pkg.scripts.verify || '').split(' && ').map((s) => s.trim())
  const steps = []
  for (const raw of chain) {
    if (!raw.startsWith('npm run ')) {
      throw new Error('verify 里有一步不是 npm run 形式，跑批器解析不了: ' + raw)
    }
    const name = raw.slice('npm run '.length)
    const script = pkg.scripts[name]
    if (!script) throw new Error('verify 引用了不存在的脚本: ' + name)
    steps.push({ name, script })
  }
  return steps
}

/** The command a suite really runs: its own script minus the per-suite build. */
function suiteCommand(step) {
  const cmd = step.script.replace(/^npm run build && /, '')
  const tokens = cmd.split(/\s+/)
  const bin = tokens[0]
  const args = tokens.slice(1)
  if (bin === 'electron') return { kind: 'electron', args }
  if (bin === 'node') return { kind: 'node', args }
  return null
}

function suiteFile(cmd) {
  const first = cmd.args[0] || ''
  return first.endsWith('.cjs') ? path.join(ROOT, first) : null
}

function serialReason(step, cmd) {
  if (LOAD_SENSITIVE.indexOf(step.name) >= 0) return '负载敏感（交接页口径）'
  if (!cmd) return '命令不是 electron/node 直接可跑，保守串行'
  if (cmd.kind === 'electron' && !cmd.args.some((a) => a.startsWith('--user-data-dir'))) {
    return '没有独立 --user-data-dir，并行会共用默认数据目录'
  }
  const file = suiteFile(cmd)
  if (file && fs.existsSync(file)) {
    const source = fs.readFileSync(file, 'utf8')
    if (source.indexOf(CHAIN_HOST) >= 0) return '真连测试链路 ' + CHAIN_HOST
  }
  return null
}

/* ---- the runner --------------------------------------------------------- */

function ms(seconds) {
  return seconds >= 60
    ? Math.floor(seconds / 60) + 'm' + (seconds % 60).toFixed(0) + 's'
    : seconds.toFixed(1) + 's'
}

/** The app:isFullScreen spam the probe windows cannot help producing. */
function isNoise(line) {
  return line.indexOf('app:isFullScreen') >= 0
}

function cleanLines(text) {
  const out = []
  let suppressStack = false
  for (const line of text.split('\n')) {
    if (isNoise(line)) {
      suppressStack = true
      continue
    }
    if (suppressStack && /^\s+at /.test(line)) continue
    suppressStack = false
    out.push(line)
  }
  return out.join('\n')
}

function tally(logText) {
  const hits = logText.match(/(\d+)\/(\d+) checks passed/g)
  if (!hits) return null
  const last = hits[hits.length - 1].match(/(\d+)\/(\d+)/)
  return { pass: Number(last[1]), total: Number(last[2]) }
}

class Run {
  constructor(options) {
    this.options = options
    this.children = new Set()
    this.interrupted = false
    this.failures = []
    this.durations = []
    this.t0 = process.hrtime.bigint()
  }

  logDir() {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    return LOG_DIR
  }

  /** Spawn one step; resolve { ok, seconds, logPath }. */
  runStep(step, cmd) {
    const started = process.hrtime.bigint()
    return new Promise((resolve) => {
      const logPath = path.join(this.logDir(), step.name.replace(/[^a-z0-9_-]/gi, '_') + '.log')
      const stream = fs.createWriteStream(logPath)
      let child
      if (!cmd) {
        // npm script（四项检查走这里）：过 shell，杀进程树用 taskkill。
        child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run ' + step.name], {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } else if (cmd.kind === 'electron') {
        child = spawn(require('electron'), cmd.args, {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } else {
        child = spawn(process.execPath, cmd.args, {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      }
      this.children.add(child)
      let buf = ''
      const feed = (chunk) => {
        buf += chunk.toString('utf8')
        stream.write(chunk)
      }
      child.stdout.on('data', feed)
      child.stderr.on('data', feed)
      let timedOut = false
      const limit = this.options.timeout * 60 * 1000
      const timer = setTimeout(() => {
        timedOut = true
        this.kill(child)
      }, limit)
      const settle = (code) => {
        clearTimeout(timer)
        this.children.delete(child)
        stream.end()
        const seconds = Number(process.hrtime.bigint() - started) / 1e9
        stream.on('close', () => resolve({ ok: code === 0 && !timedOut, timedOut, seconds, logPath }))
      }
      child.on('error', (err) => {
        stream.write(String.fromCharCode(10) + 'spawn failed: ' + String(err) + String.fromCharCode(10))
        settle(1)
      })
      child.on('close', (code) => settle(code))
    }).then((result) => {
      const text = fs.readFileSync(result.logPath, 'utf8')
      result.text = text
      result.logPath = path.relative(ROOT, result.logPath)
      return result
    })
  }

  kill(child) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  }

  stopAll() {
    for (const child of this.children) this.kill(child)
  }

  async npmScript(name) {
    return this.runStep({ name, script: '' }, null)
  }
}

/* ---- reporting ---------------------------------------------------------- */

function reportStep(index, total, step, result) {
  const mark = result.ok ? '✓' : result.timedOut ? '⏱' : '✗'
  const count = tally(result.text)
  const bits = [
    '[' + String(index).padStart(3) + '/' + total + '] ' + step.name + ' ' + mark
  ]
  if (count) bits.push(count.pass + '/' + count.total)
  bits.push(ms(result.seconds))
  console.log(bits.join('  '))
  if (!result.ok) {
    console.log('    log: ' + result.logPath)
    const lines = cleanLines(result.text).split('\n')
    const fails = lines.filter((l) => /^FAIL/.test(l))
    if (fails.length) console.log(fails.join('\n'))
    const tail = lines.filter((l) => l.trim() !== '').slice(-8)
    console.log('    ' + tail.join('\n    '))
  }
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  const argv = process.argv.slice(2)
  const options = {
    only: null,
    jobs: 1,
    list: false,
    skipBuild: false,
    noChecks: false,
    timeout: 15
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--list') options.list = true
    else if (a === '--only') options.only = (argv[++i] || '').split(',').map((s) => s.trim())
    else if (a === '--jobs') options.jobs = Math.max(1, Number(argv[++i]) || 1)
    else if (a === '--skip-build') options.skipBuild = true
    else if (a === '--no-checks') options.noChecks = true
    else if (a === '--timeout') options.timeout = Number(argv[++i]) || 15
    else if (a === '-h' || a === '--help') options.list = 'help'
    else throw new Error('不认识的参数: ' + a)
  }

  const all = readPlan()
  const checks = all.filter((s) => !s.name.startsWith('smoke:'))
  const suitesRaw = all.filter((s) => s.name.startsWith('smoke:'))
  const suites = suitesRaw.map((step) => {
    const cmd = suiteCommand(step)
    if (!cmd) {
      throw new Error(
        '套件 ' + step.name + ' 的命令解析不了（既不是 electron 也不是 node 开头）: ' + step.script
      )
    }
    return { step, cmd, serial: serialReason(step, cmd) }
  })

  let selected = suites
  if (options.only) {
    const wanted = options.only.map((n) => (n.startsWith('smoke:') ? n : 'smoke:' + n))
    const missing = wanted.filter((w) => !suites.some((s) => s.step.name === w))
    if (missing.length) {
      console.error(
        '--only 里有不存在的套件: ' + missing.join(', ') +
          '\n可用的套件名（去掉 smoke: 前缀）:\n  ' +
          suites.map((s) => s.step.name.replace(/^smoke:/, '')).join('  ')
      )
      process.exit(2)
    }
    selected = suites.filter((s) => wanted.indexOf(s.step.name) >= 0)
  }

  if (options.list) {
    console.log('检查（顺序照 verify 脚本）:')
    for (const c of checks) console.log('  ' + c.name + '  <- ' + c.script)
    console.log('套件 ' + suites.length + ' 个（* = 串行）:')
    for (const s of suites) {
      console.log(
        '  ' + (s.serial ? '*' : ' ') + ' ' + s.step.name +
          (s.serial ? '  <- ' + s.serial : '')
      )
    }
    console.log(
      '\n用法: npm run verify:fast -- [--only rest,s3] [--jobs N] [--skip-build] [--no-checks] [--timeout MIN]'
    )
    console.log('底线: 推 origin 前 verify:fast 全量；发版/打标签前原版 npm run verify。')
    return
  }

  const plan = []
  if (!options.noChecks) plan.push(...checks.map((step) => ({ kind: 'check', step, cmd: null })))
  plan.push(...selected.map((s) => ({ kind: 'suite', step: s.step, cmd: s.cmd, serial: s.serial })))

  const jobs = options.jobs
  const serialCount = plan.filter((p) => p.serial).length
  console.log(
    'verify:fast  ' + plan.length + ' 步（构建 1 次' +
      (options.skipBuild ? '，本次跳过' : '') + '），jobs=' + jobs +
      '，串行 ' + serialCount + ' 步，详细日志在 node_modules/.verify/'
  )
  if (jobs > 1) {
    console.log(
      '注意: 并行是选择加入的。串行套件（连测试链路/负载敏感/无独立数据目录）仍会独占跑，' +
        '其余并行——出现偶发红先单独重跑该套件再定性。'
    )
  }

  const run = new Run(options)
  process.on('SIGINT', () => {
    run.interrupted = true
    process.exitCode = 1
    run.stopAll()
  })

  fs.rmSync(SMOKE_DATA, { recursive: true, force: true })

  if (!options.skipBuild) {
    process.stdout.write('[  0/' + plan.length + '] build  …' + String.fromCharCode(13))
    const r = await run.npmScript('build')
    console.log('')
    reportStep(0, plan.length, { name: 'build (一次，供全部套件共用)' }, r)
    if (!r.ok) {
      console.log('构建失败，后面的都不用跑了。')
      process.exit(1)
    }
  }

  let index = 0
  let cursor = 0
  let bad = false
  const active = new Set()

  const start = (entry) => {
    index += 1
    console.log('→ ' + entry.step.name + ' (' + index + '/' + plan.length + ')' +
      (entry.serial ? ' [串行]' : ''))
    const running = run.runStep(entry.step, entry.cmd)
    active.add(running)
    running.then((result) => {
      active.delete(running)
      reportStep(index, plan.length, entry.step, result)
      run.durations.push({ name: entry.step.name, seconds: result.seconds })
      if (!result.ok) {
        bad = true
        run.failures.push({ name: entry.step.name, timedOut: result.timedOut })
        if (run.interrupted) return
      }
      pump()
    })
  }

  const pump = () => {
    while (cursor < plan.length && active.size < (plan[cursor] && plan[cursor].serial ? 1 : jobs)) {
      const entry = plan[cursor]
      if (entry.serial) {
        if (active.size === 0) {
          cursor += 1
          start(entry)
        }
        break // 串行步是屏障：等跑批器清空再独占
      }
      cursor += 1
      start(entry)
    }
    if (cursor >= plan.length && active.size === 0) {
      finish()
    }
  }

  const finish = () => {
    const total = Number(process.hrtime.bigint() - run.t0) / 1e9
    if (bad) {
      console.log(
        '\n== ' + run.failures.length + ' 步未过（' + ms(total) + '）：' +
          run.failures.map((f) => f.name + (f.timedOut ? '（超时）' : '')).join(', ')
      )
      for (const f of run.failures) {
        console.log('   单独重跑: npm run verify:fast -- --only ' + f.name.replace(/^smoke:/, ''))
      }
      process.exit(1)
    }
    const slowest = run.durations
      .slice()
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 5)
      .map((d) => d.name + ' ' + ms(d.seconds))
      .join(', ')
    console.log('\n== 全部通过：' + plan.length + ' 步 · ' + ms(total) + '。最慢五步: ' + slowest)
    if (options.only) {
      console.log('这是定向跑（--only ' + options.only.join(',') + '）。推 origin 前请跑一次全量 verify:fast。')
    }
    process.exit(0)
  }

  pump()
}

main().catch((err) => {
  console.error('verifyfast: ' + (err && err.message ? err.message : err))
  process.exit(2)
})
