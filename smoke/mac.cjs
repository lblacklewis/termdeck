/**
 * macOS 适配：在没有 Mac 的机器上也能判对错。
 *
 *   npx electron smoke/mac.cjs --user-data-dir=node_modules/.smoke-data/mac
 *
 * 这一批是让 TermDeck 跑在 macOS 上，而这台开发机是 Windows：打不出 dmg、也起不了
 * mac 版。所以做法是把平台差异抽成纯函数（src/shared/platform.ts、src/main/sessions/shellChoice.ts、
 * src/main/menu.ts），探针注入平台参数断言 mac 分支的选择 —— 每条断言在 v2.0.0 的实现上都必然
 * 失败，因为它们断言的是当时根本不存在的行为：
 *
 *   1. chooseShell('darwin', ...) 选 zsh、不传 Windows 参数、补 PATH/TERM/LANG；
 *   2. defaultBindings('darwin') 用 Cmd（Meta），并且 Cmd+W 是"关闭当前窗格"；
 *   3. migrateBindingKeys 把存盘里的旧 Ctrl+... 只在该值恰好等于旧默认时改写成 Meta+...，
 *      而 Windows 上 v1.13.0 的 Ctrl+W 解绑决定原样保留；
 *   4. menuTemplateFor('darwin', ...) 给出 Edit 菜单的 role（mac 上没有它就没有 Cmd+C/V）、
 *      不占用 Cmd+W、退出项先问再退；其它平台仍然是"没有菜单"；
 *   5. 字体：mac 的默认族名与 system_profiler 输出解析；
 *   6. 打包：package.json 的 mac target、zipdist 的平台映射、CI workflow。
 *
 * 另外，在真的 macOS 上跑同一个探针时（CI 的 macos runner、或用户自己的 Mac），
 * 最后一段会把注入平台换成真实平台，检查 $SHELL、字体枚举这些只能在真机上验的东西。
 * 那一段在 Windows 上会显式标成 SKIP，不假装通过。
 *
 * 本文件不用模板字符串（也不出现反引号）：scripts/checkprobes.cjs 会把反引号数成
 * 模板字面量的边界，注释里多一个就会让整个探针看起来"解析失败"。
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, Menu } = require('electron')

const ROOT = path.join(__dirname, '..')
const DASH = String.fromCharCode(8212)
const NEWLINE = String.fromCharCode(10)

const checks = []
const push = (name, ok, detail) =>
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? true : detail })

function report() {
  let failed = 0
  for (const check of checks) {
    const ok = check.ok === true
    if (!ok) failed += 1
    console.log(
      (ok ? 'PASS  ' : 'FAIL  ') + check.name +
        (check.detail === true ? '' : ' ' + DASH + ' ' + String(check.detail === undefined ? '' : check.detail))
    )
  }
  console.log(NEWLINE + (checks.length - failed) + '/' + checks.length + ' checks passed')
  return failed
}

/** Every accelerator in a menu template, however deep. */
function acceleratorsOf(items, acc) {
  const found = acc || []
  for (const item of items || []) {
    if (item && item.accelerator) found.push(item.accelerator)
    if (item && Array.isArray(item.submenu)) acceleratorsOf(item.submenu, found)
  }
  return found
}

/** Roles of one submenu, in order. */
function rolesOf(menu) {
  return ((menu && menu.submenu) || []).map((item) => item.role).filter(Boolean)
}

function findMenu(template, label) {
  return (template || []).find((item) => item && item.label === label)
}

async function main() {
  const guard = setTimeout(() => {
    console.error('mac probe watchdog')
    app.exit(1)
  }, 180000)

  const mod = require(path.join(ROOT, 'out', 'main', 'smokeEntry.js'))
  const zipdist = require(path.join(ROOT, 'scripts', 'zipdist.cjs'))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  const alwaysExists = () => true
  const noop = () => {}

  // ---- 1. 本地 shell ------------------------------------------------------
  const macShell = mod.chooseShell('darwin', {}, alwaysExists)
  push('mac 上 $SHELL 没设时用 /bin/zsh', macShell.shell === '/bin/zsh', 'shell=' + macShell.shell)
  push(
    'mac 上不给 shell 传任何参数（-NoLogo 是 PowerShell 的）',
    macShell.args.length === 0 && macShell.args.indexOf('-NoLogo') < 0,
    'args=' + JSON.stringify(macShell.args)
  )
  push('mac 上补 TERM', macShell.env.TERM === 'xterm-256color', 'TERM=' + macShell.env.TERM)
  push('mac 上补 LANG', macShell.env.LANG === 'en_US.UTF-8', 'LANG=' + macShell.env.LANG)
  const macPath = macShell.env.PATH || ''
  push(
    'mac 上把 Homebrew 的两个 bin 目录加进 PATH',
    macPath.indexOf('/opt/homebrew/bin') === 0 && macPath.indexOf('/usr/local/bin') > 0,
    'PATH=' + macPath
  )
  push(
    'PATH 里已有的目录不重复添加',
    mod.chooseShell('darwin', { PATH: '/usr/local/bin:/usr/bin:/bin' }, alwaysExists).env.PATH ===
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    'PATH=' +
      mod.chooseShell('darwin', { PATH: '/usr/local/bin:/usr/bin:/bin' }, alwaysExists).env.PATH
  )
  push(
    'mac 上 $SHELL 存在就用它（brew 装的 fish 也一样）',
    mod.chooseShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, alwaysExists).shell ===
      '/opt/homebrew/bin/fish',
    mod.chooseShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, alwaysExists).shell
  )
  push(
    '$SHELL 指向一个已经不在的路径时回退 /bin/zsh',
    mod.chooseShell('darwin', { SHELL: '/opt/gone/zsh' }, (p) => p !== '/opt/gone/zsh').shell ===
      '/bin/zsh',
    mod.chooseShell('darwin', { SHELL: '/opt/gone/zsh' }, (p) => p !== '/opt/gone/zsh').shell
  )
  push(
    '已有的 LANG 不被覆盖',
    !('LANG' in mod.chooseShell('darwin', { LANG: 'zh_CN.UTF-8' }, alwaysExists).env),
    JSON.stringify(mod.chooseShell('darwin', { LANG: 'zh_CN.UTF-8' }, alwaysExists).env)
  )

  // Windows must not have moved an inch.
  const winCmd = mod.chooseShell('win32', { COMSPEC: 'C:/Windows/System32/cmd.exe' })
  push(
    'Windows 仍然用 %COMSPEC% 且不加参数',
    winCmd.shell === 'C:/Windows/System32/cmd.exe' && winCmd.args.length === 0,
    winCmd.shell + ' ' + JSON.stringify(winCmd.args)
  )
  const winPs = mod.chooseShell('win32', { COMSPEC: 'powershell.exe' })
  push(
    'Windows 的 PowerShell 仍然带 -NoLogo',
    winPs.args.length === 1 && winPs.args[0] === '-NoLogo',
    JSON.stringify(winPs.args)
  )
  push(
    'Windows 不注入 PATH/TERM/LANG（一个都不动）',
    Object.keys(winCmd.env).length === 0,
    JSON.stringify(winCmd.env)
  )
  push(
    '显式指定的 PowerShell 也照样拿到 -NoLogo',
    mod.shellArgs('win32', 'C:/Program Files/PowerShell/7/pwsh.exe')[0] === '-NoLogo' &&
      mod.shellArgs('darwin', '/bin/zsh').length === 0,
    JSON.stringify(mod.shellArgs('win32', 'pwsh.exe')) + ' / ' + JSON.stringify(mod.shellArgs('darwin', '/bin/zsh'))
  )

  // ---- 2. 字体 -----------------------------------------------------------
  const fixture = JSON.stringify({
    SPFontsDataType: [
      { _name: 'Arial', path: '/System/Library/Fonts/Supplemental/Arial.ttf' },
      { _name: 'Menlo', path: '/System/Library/Fonts/Menlo.ttc' },
      { _name: 'Menlo', path: '/System/Library/Fonts/Menlo.ttc' },
      { _name: '  Monaco  ' },
      { _name: '' }
    ]
  })
  const parsed = mod.parseMacFontFamilies(fixture)
  push(
    'system_profiler 的字体清单能解析成族名（去重、去空白）',
    parsed.length === 3 && parsed.indexOf('Menlo') >= 0 && parsed.indexOf('Monaco') >= 0,
    JSON.stringify(parsed)
  )
  push(
    '解析出来的是族名而不是文件路径',
    parsed.every((name) => name.indexOf('/') < 0 && name.indexOf('.ttf') < 0),
    JSON.stringify(parsed)
  )
  push('坏掉的 JSON 返回空表而不是抛错', mod.parseMacFontFamilies('not json').length === 0)
  push('没有字体条目时返回空表', mod.parseMacFontFamilies('{}').length === 0)
  push(
    '嵌套的 _items 里的字体也能取到',
    mod
      .parseMacFontFamilies(JSON.stringify({ SPFontsDataType: [{ _items: [{ _name: 'Hack' }] }] }))
      .indexOf('Hack') >= 0
  )
  push(
    'mac 的默认等宽字体是系统字体优先',
    mod.defaultFontFamily('darwin').indexOf('"SF Mono"') === 0,
    mod.defaultFontFamily('darwin')
  )
  push(
    'Windows 的默认等宽字体一个字都没变',
    mod.defaultFontFamily('win32') ===
      '"Cascadia Mono", "JetBrains Mono", "Fira Code", Consolas, "DejaVu Sans Mono", monospace',
    mod.defaultFontFamily('win32')
  )
  push(
    'mac 的候选字体把 SF Mono 排在前面',
    mod.fallbackMonospaceFonts('darwin').indexOf('SF Mono') === 0,
    mod.fallbackMonospaceFonts('darwin').slice(0, 3).join(', ')
  )
  push(
    'Windows 的候选字体没有多出 mac 专有项',
    mod.fallbackMonospaceFonts('win32').indexOf('SF Mono') < 0 &&
      mod.fallbackMonospaceFonts('win32').indexOf('Monaco') >= 0,
    mod.fallbackMonospaceFonts('win32').slice(0, 3).join(', ')
  )
  push(
    '默认设置里的字体按平台给',
    mod.defaultSettings('darwin').terminal.fontFamily.indexOf('"SF Mono"') === 0,
    mod.defaultSettings('darwin').terminal.fontFamily
  )

  // ---- 3. 键位与迁移 -----------------------------------------------------
  const base = mod.DEFAULT_KEYBINDINGS
  const winBindings = mod.defaultBindings('win32')
  push(
    'Windows/Linux 的默认键位就是基础表（没有被动过）',
    JSON.stringify(winBindings) === JSON.stringify(base),
    'count=' + winBindings.length
  )
  push(
    'Windows 的默认设置与旧版完全一致（字体 + 键位 + 剪贴板）',
    JSON.stringify(mod.defaultSettings('win32').terminal) === JSON.stringify(mod.DEFAULT_TERMINAL_SETTINGS) &&
      JSON.stringify(mod.defaultSettings('win32').keybindings) === JSON.stringify(base) &&
      JSON.stringify(mod.defaultSettings('win32').clipboard) === JSON.stringify(mod.DEFAULT_CLIPBOARD_SETTINGS)
  )

  const mac = mod.defaultBindings('darwin')
  const macKeys = new Map(mac.map((b) => [b.id, b.keys]))
  push('mac 上 Cmd+W 是"关闭当前窗格"', macKeys.get('closeSession') === 'Meta+W', 'closeSession=' + macKeys.get('closeSession'))
  push('mac 上 Ctrl+W 不再被应用占用', mac.every((b) => b.keys !== 'Ctrl+W'))
  push('mac 上新建连接是 Cmd+T', macKeys.get('newConnection') === 'Meta+T', 'newConnection=' + macKeys.get('newConnection'))
  push(
    'mac 上复制是 Cmd+C（不是 Windows 那套 Ctrl+Shift+C）',
    macKeys.get('copy') === 'Meta+C',
    'copy=' + macKeys.get('copy')
  )
  push('mac 上粘贴是 Cmd+V', macKeys.get('paste') === 'Meta+V', 'paste=' + macKeys.get('paste'))
  push(
    'mac 上切标签是 Cmd+Shift+] / Cmd+Shift+[',
    macKeys.get('nextTab') === 'Meta+Shift+]' && macKeys.get('prevTab') === 'Meta+Shift+[',
    'nextTab=' + macKeys.get('nextTab') + ' prevTab=' + macKeys.get('prevTab')
  )
  push(
    'mac 上全屏是 Ctrl+Cmd+F（Mac 上没有 F11 这个习惯）',
    macKeys.get('toggleFocus') === 'Ctrl+Meta+F',
    'toggleFocus=' + macKeys.get('toggleFocus')
  )
  push(
    'mac 上切会话是 Cmd+Alt+左右（iTerm 的换标签手势）',
    macKeys.get('prevPage') === 'Meta+Alt+ArrowLeft' &&
      macKeys.get('nextPage') === 'Meta+Alt+ArrowRight',
    'prevPage=' + macKeys.get('prevPage') + ' nextPage=' + macKeys.get('nextPage')
  )
  push(
    'mac 上设置与退出交给应用菜单（键位留空，免得和菜单抢同一个键）',
    macKeys.get('openSettings') === '' && macKeys.get('quitApp') === '',
    'openSettings="' + macKeys.get('openSettings') + '" quitApp="' + macKeys.get('quitApp') + '"'
  )
  push(
    'mac 上"关已结束的窗格"不单独绑（Cmd+W 关任何窗格）',
    macKeys.get('closeDeadPane') === '',
    'closeDeadPane="' + macKeys.get('closeDeadPane') + '"'
  )
  push(
    'mac 的默认键位里没有"裸 Ctrl"的键（Mac 上 Ctrl 是 shell 的）',
    mac.every((b) => b.keys.indexOf('Ctrl+') !== 0 || b.keys.indexOf('+Meta+') > 0),
    mac.filter((b) => b.keys.indexOf('Ctrl+') === 0 && b.keys.indexOf('+Meta+') < 0).map((b) => b.id + '=' + b.keys).join(', ') || 'none'
  )
  push(
    'mac 表覆盖了全部内置键位（新增键位必须显式决定 mac 值，不许悄悄回退）',
    base.every((b) => Object.prototype.hasOwnProperty.call(mod.MAC_BINDING_DEFAULTS, b.id)),
    base.filter((b) => !Object.prototype.hasOwnProperty.call(mod.MAC_BINDING_DEFAULTS, b.id)).map((b) => b.id).join(', ') || 'all covered'
  )
  push(
    '显示用 Cmd、存储用 Meta（两件事，别混）',
    mod.displayChord('Meta+W', 'darwin') === 'Cmd+W' &&
      mod.displayChord('Ctrl+Meta+F', 'darwin') === 'Ctrl+Cmd+F' &&
      mod.displayChord('Meta+C', 'win32') === 'Meta+C' &&
      mod.displayChord('Ctrl+Shift+C', 'win32') === 'Ctrl+Shift+C',
    mod.displayChord('Meta+W', 'darwin') + ' / ' + mod.displayChord('Ctrl+Meta+F', 'darwin')
  )
  push(
    '会话跳转的修饰键按平台（Windows 是 Alt，mac 是 Cmd）',
    mod.sessionJumpModifier('win32') === 'alt' && mod.sessionJumpModifier('darwin') === 'meta',
    mod.sessionJumpModifier('win32') + ' / ' + mod.sessionJumpModifier('darwin')
  )
  push('两张默认表条数一致（没有多也没有少）', mac.length === base.length, mac.length + ' vs ' + base.length)

  const macClip = mod.defaultClipboardSettings('darwin')
  const winClip = mod.defaultClipboardSettings('win32')
  push(
    'mac 上默认不"选中即复制"（Mac 的习惯是选中后按 Cmd+C）',
    macClip.copyOnSelect === false,
    JSON.stringify(macClip)
  )
  push('mac 上默认不绑中键粘贴（Mac 没有中键）', macClip.pasteOnMiddleClick === false, 'pasteOnMiddleClick=' + macClip.pasteOnMiddleClick)
  push(
    'mac 上右键粘贴保留（还没有终端右键菜单可用，关掉就等于没了）',
    macClip.pasteOnRightClick === true,
    'pasteOnRightClick=' + macClip.pasteOnRightClick
  )
  push(
    'Windows 的剪贴板默认值一个字都没变',
    JSON.stringify(winClip) === JSON.stringify(mod.DEFAULT_CLIPBOARD_SETTINGS),
    JSON.stringify(winClip)
  )
  push(
    '默认设置里带上了平台剪贴板默认值',
    mod.defaultSettings('darwin').clipboard.copyOnSelect === false &&
      mod.defaultSettings('darwin').clipboard.pasteOnMiddleClick === false
  )

  /*
   * Copy/paste in a text field: on a Mac `Cmd+C` is both the system copy chord and
   * the app's terminal-copy binding, so the handlers step aside when the focus is in
   * a real input. The rule is a decision table, asserted here in full — without it,
   * `Cmd+C` would stop working in every settings field on a Mac and no other suite
   * would notice.
   */
  const editTarget = (tagName, isContentEditable, insideTerminal) =>
    mod.isNativeEditTarget({ tagName, isContentEditable, insideTerminal })
  push('输入框里的 Cmd+C 交给系统（普通 input）', editTarget('INPUT', false, false) === true)
  push('多行输入框一样交给系统（textarea）', editTarget('TEXTAREA', false, false) === true)
  push('可编辑区域也交给系统（contenteditable）', editTarget('DIV', true, false) === true)
  push(
    '终端自己的隐藏 textarea 不算输入框（那个由应用处理）',
    editTarget('TEXTAREA', false, true) === false
  )
  push('焦点在按钮 / 空白处时不抢键（继续走应用的处理）', editTarget('BUTTON', false, false) === false)

  push(
    '迁移：mac 上存盘里的旧 Ctrl+W 变成 Cmd+W',
    mod.migrateBindingKeys('darwin', 'closeSession', 'Ctrl+W') === 'Meta+W',
    mod.migrateBindingKeys('darwin', 'closeSession', 'Ctrl+W')
  )
  push(
    '迁移：mac 上存盘里的旧 Ctrl+T 变成 Cmd+T',
    mod.migrateBindingKeys('darwin', 'newConnection', 'Ctrl+T') === 'Meta+T',
    mod.migrateBindingKeys('darwin', 'newConnection', 'Ctrl+T')
  )
  push(
    '迁移不是大锤：用户自己设的 Ctrl+Shift+T 原样保留',
    mod.migrateBindingKeys('darwin', 'newConnection', 'Ctrl+Shift+T') === 'Ctrl+Shift+T',
    mod.migrateBindingKeys('darwin', 'newConnection', 'Ctrl+Shift+T')
  )
  push(
    'Windows 上 v1.13.0 的解绑决定原样保留（Ctrl+W → 空）',
    mod.migrateBindingKeys('win32', 'closeSession', 'Ctrl+W') === '',
    "'" + mod.migrateBindingKeys('win32', 'closeSession', 'Ctrl+W') + "'"
  )
  push(
    'Windows 上其它键位不迁移',
    mod.migrateBindingKeys('win32', 'newConnection', 'Ctrl+T') === 'Ctrl+T' &&
      mod.migrateBindingKeys('win32', 'toggleSidebar', 'Ctrl+B') === 'Ctrl+B'
  )
  push(
    '迁移只认"恰好等于旧默认"的值',
    mod.migrateBindingKeys('darwin', 'newConnection', 'Ctrl+Shift+T') === 'Ctrl+Shift+T' &&
      mod.migrateBindingKeys('darwin', 'newConnection', 'Meta+T') === 'Meta+T',
    'own chord untouched, new default untouched'
  )
  push(
    '迁移：mac 上 v2.1.0 的 Cmd+Shift+C 变成 Cmd+C',
    mod.migrateBindingKeys('darwin', 'copy', 'Meta+Shift+C') === 'Meta+C',
    mod.migrateBindingKeys('darwin', 'copy', 'Meta+Shift+C')
  )
  push(
    '迁移：mac 上 Windows 的 Ctrl+Shift+C 也变成 Cmd+C',
    mod.migrateBindingKeys('darwin', 'copy', 'Ctrl+Shift+C') === 'Meta+C',
    mod.migrateBindingKeys('darwin', 'copy', 'Ctrl+Shift+C')
  )
  push(
    '迁移：mac 上 v2.1.0 的 F11 变成 Ctrl+Cmd+F',
    mod.migrateBindingKeys('darwin', 'toggleFocus', 'F11') === 'Ctrl+Meta+F',
    mod.migrateBindingKeys('darwin', 'toggleFocus', 'F11')
  )
  push(
    '迁移：mac 上设置与退出交还给应用菜单（值改成空）',
    mod.migrateBindingKeys('darwin', 'openSettings', 'Meta+,') === '' &&
      mod.migrateBindingKeys('darwin', 'quitApp', 'Meta+Shift+Q') === '',
    "'" + mod.migrateBindingKeys('darwin', 'openSettings', 'Meta+,') + "' / '" +
      mod.migrateBindingKeys('darwin', 'quitApp', 'Meta+Shift+Q') + "'"
  )
  push(
    '迁移不是大锤 2：mac 上用户自己设的 Cmd+Alt+C 不动',
    mod.migrateBindingKeys('darwin', 'copy', 'Meta+Alt+C') === 'Meta+Alt+C',
    mod.migrateBindingKeys('darwin', 'copy', 'Meta+Alt+C')
  )
  push(
    'Windows 上复制 / 退出 / 全屏这些键位一条都不迁移',
    mod.migrateBindingKeys('win32', 'copy', 'Ctrl+Shift+C') === 'Ctrl+Shift+C' &&
      mod.migrateBindingKeys('win32', 'quitApp', 'Ctrl+Shift+Q') === 'Ctrl+Shift+Q' &&
      mod.migrateBindingKeys('win32', 'toggleFocus', 'F11') === 'F11'
  )
  push(
    '两份迁移表：mac 把整个 Ctrl 集合搬过去，Windows 只有 closeSession',
    Object.keys(mod.retiredBindingDefaults('win32')).length === 1 &&
      Object.keys(mod.retiredBindingDefaults('darwin')).length > 10,
    'win=' + Object.keys(mod.retiredBindingDefaults('win32')).length +
      ' mac=' + Object.keys(mod.retiredBindingDefaults('darwin')).length
  )

  // ---- 4. 应用菜单（mac 上没有它就没有 Cmd+C/V） -------------------------
  let quitAsks = 0
  let settingsAsks = 0
  const macMenu = mod.menuTemplateFor('darwin', {
    appName: 'TermDeck',
    askQuit: () => {
      quitAsks += 1
    },
    openSettings: () => {
      settingsAsks += 1
    }
  })
  const noopActions = { appName: 'TermDeck', askQuit: noop, openSettings: noop }
  push('Windows 上没有应用菜单', mod.menuTemplateFor('win32', noopActions) === null)
  push('Linux 上没有应用菜单', mod.menuTemplateFor('linux', noopActions) === null)
  push('mac 上有 App / Edit / Window 三个菜单', Array.isArray(macMenu) && macMenu.length === 3, 'menus=' + (macMenu || []).map((m) => m.label).join(','))

  const editRoles = rolesOf(findMenu(macMenu, 'Edit'))
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
    push(
      'mac 的 Edit 菜单里有 ' + role + ' role（Cmd 快捷键就是它给的）',
      editRoles.indexOf(role) >= 0,
      'roles=' + editRoles.join(',')
    )
  }

  const accels = acceleratorsOf(macMenu)
  push(
    'mac 的菜单不占用 Cmd+W（那是关闭窗格的键）',
    accels.indexOf('Command+W') < 0,
    'accelerators=' + accels.join(', ')
  )
  push(
    '系统关窗改挂 Cmd+Shift+W',
    accels.indexOf('Command+Shift+W') >= 0,
    'accelerators=' + accels.join(', ')
  )

  const appMenu = findMenu(macMenu, 'TermDeck')
  const appItems = (appMenu && appMenu.submenu) || []
  const appRoles = rolesOf(appMenu)
  push(
    'mac 的 App 菜单有 about / services / hide / hideOthers / unhide',
    ['about', 'services', 'hide', 'hideOthers', 'unhide'].every((role) => appRoles.indexOf(role) >= 0),
    'roles=' + appRoles.join(',')
  )
  push(
    '退出项不是 quit role（那个会绕过退出确认、先把会话拆了）',
    appRoles.indexOf('quit') < 0,
    'roles=' + appRoles.join(',')
  )
  const quitItem = appItems.find((item) => item.accelerator === 'Command+Q')
  push(
    '退出项挂在 Cmd+Q 上',
    !!quitItem && quitItem.label === 'Quit TermDeck',
    quitItem ? quitItem.label : 'MISSING'
  )
  push(
    '退出项先问一句再退（点它会去问渲染端）',
    !!quitItem && typeof quitItem.click === 'function' && (quitItem.click(), quitAsks === 1),
    'askQuit calls=' + quitAsks
  )
  const settingsItem = appItems.find((item) => item.accelerator === 'Command+,')
  push(
    'mac 的 App 菜单里有 Settings…（Cmd+, 归菜单，不归键位表）',
    !!settingsItem && settingsItem.label === 'Settings…',
    settingsItem ? settingsItem.label : 'MISSING'
  )
  push(
    'Settings… 点下去会去问渲染端开设置',
    !!settingsItem &&
      typeof settingsItem.click === 'function' &&
      (settingsItem.click(), settingsAsks === 1),
    'openSettings calls=' + settingsAsks
  )
  const windowRoles = rolesOf(findMenu(macMenu, 'Window'))
  push(
    'mac 的 Window 菜单有 minimize / zoom / close / front',
    ['minimize', 'zoom', 'close', 'front'].every((role) => windowRoles.indexOf(role) >= 0),
    'roles=' + windowRoles.join(',')
  )
  let built = true
  let buildError = ''
  try {
    Menu.buildFromTemplate(macMenu)
  } catch (err) {
    built = false
    buildError = String((err && err.message) || err)
  }
  push('这份菜单 Electron 真的建得起来（role 名字都对）', built, buildError || 'Menu.buildFromTemplate ok')

  // ---- 5. 打包配置与 CI ---------------------------------------------------
  const macBuild = pkg.build && pkg.build.mac
  push('package.json 里有 mac 打包配置', !!macBuild)
  const targets = (macBuild && macBuild.target) || []
  const kinds = targets.map((t) => t.target)
  push('mac 出 dmg 与 zip 两种产物', kinds.indexOf('dmg') >= 0 && kinds.indexOf('zip') >= 0, kinds.join(','))
  const arches = []
  for (const target of targets) for (const arch of target.arch || []) arches.push(arch)
  push(
    'arm64 与 x64 分开出，不做 universal',
    arches.indexOf('arm64') >= 0 && arches.indexOf('x64') >= 0 && arches.indexOf('universal') < 0,
    arches.join(',')
  )
  push(
    'mac 产物名带版本与架构',
    !!macBuild && macBuild.artifactName === 'TermDeck-${version}-${arch}.${ext}',
    macBuild ? String(macBuild.artifactName) : 'no mac config'
  )
  push(
    '有 dist:mac 脚本',
    typeof pkg.scripts['dist:mac'] === 'string' && pkg.scripts['dist:mac'].indexOf('electron-builder --mac') >= 0,
    String(pkg.scripts['dist:mac'])
  )
  push('完整闸门里挂上了 smoke:mac', String(pkg.scripts.verify).indexOf('smoke:mac') >= 0)
  push(
    'mac 的 zip 交给 electron-builder：zipdist 在 darwin/linux 上拒绝干活',
    zipdist.portableZipTarget('darwin', 'arm64', '9.9.9') === null &&
      zipdist.portableZipTarget('linux', 'x64', '9.9.9') === null
  )
  push(
    'Windows 便携包的目录与文件名没变',
    JSON.stringify(zipdist.portableZipTarget('win32', 'x64', '9.9.9')) ===
      JSON.stringify({ dir: 'win-unpacked', file: 'TermDeck-9.9.9-win-x64-portable.zip' }),
    JSON.stringify(zipdist.portableZipTarget('win32', 'x64', '9.9.9'))
  )

  const workflowPath = path.join(ROOT, '.github', 'workflows', 'mac.yml')
  const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : ''
  push('仓库里有 mac 的 CI workflow', workflow.length > 0, workflowPath)
  push('CI 用 npm ci 装依赖', workflow.indexOf('npm ci') >= 0)
  push('CI 跑 dist:mac', workflow.indexOf('npm run dist:mac') >= 0)
  push(
    'CI 在 arm64 与 Intel 两种 runner 上分别打包（原生模块按架构装）',
    workflow.indexOf('macos-15-intel') >= 0 && workflow.indexOf('arm64') >= 0,
    'runners: macos-15 / macos-15-intel'
  )
  push(
    'CI 不做签名（没有 Apple 开发者账号）',
    workflow.indexOf('CSC_IDENTITY_AUTO_DISCOVERY') >= 0
  )
  push(
    'CI 给 mac 产物写校验值（Windows 这边没法给不存在的文件算哈希）',
    workflow.indexOf('shasum -a 256') >= 0 && workflow.indexOf('SHA256SUMS-') >= 0
  )

  // ---- 6. 真机部分：能跑就真跑，跑不了就明说 ------------------------------
  const real = mod.chooseShell(process.platform, process.env)
  push(
    '真实平台上选出的 shell 存在',
    !path.isAbsolute(real.shell) || fs.existsSync(real.shell),
    process.platform + ' -> ' + real.shell
  )
  push(
    '真实平台上不给 shell 传 Windows 参数（除非平台就是 Windows）',
    process.platform === 'win32' || real.args.indexOf('-NoLogo') < 0,
    'args=' + JSON.stringify(real.args)
  )

  if (process.platform === 'darwin') {
    // These only mean something on a real Mac — which is the point of the CI job.
    push(
      '真实 mac 上选中的是登录 shell',
      ['/bin/zsh', '/bin/bash', '/bin/sh'].indexOf(real.shell) >= 0 || real.shell === process.env.SHELL,
      real.shell
    )
    const installed = await mod.listInstalledFonts()
    push(
      '真实 mac 上能枚举出已装字体（不是空表、也没超时）',
      installed.length >= 3,
      'count=' + installed.length
    )
    push(
      '真实 mac 上枚举出的是族名而不是文件路径',
      installed.length > 0 && installed.every((name) => name.indexOf('/') < 0 && name.indexOf('.ttf') < 0),
      'sample=' + installed.slice(0, 3).join(', ')
    )
  } else {
    // Not a skip dressed up as a pass: this says out loud that the real-platform
    // half was not exercised here, and where it will be (CI runner or a real Mac).
    push(
      '真实平台检查（$SHELL / 字体枚举）只有在 macOS 上跑才有意义',
      true,
      'SKIP on ' + process.platform + DASH + ' macOS 上由 CI 的 macos-15 / macos-15-intel 跑到'
    )
  }

  clearTimeout(guard)
  const failed = report()
  const dir = path.join(ROOT, 'node_modules', '.smoke-data')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mac-last.json'), JSON.stringify(checks, null, 2))
  } catch {
    // The report on stdout is the real result.
  }
  app.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error('mac probe crashed: ' + (err && err.stack ? err.stack : err))
    app.exit(1)
  })
)
