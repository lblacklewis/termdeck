# 交接：macOS 适配（历史基线 v2.0.0 → v2.1.0；已按 v2.6.0 复核）

> 仓库：`D:\project\dsh-workspace\termdeck`（开发机是 Windows）。版本基线 **v2.0.0** → 交付 **v2.1.0**（历史记录；仓库当前是 v2.6.0，口径见下方「本页现状」）。
> 这份文档原本是"开工前方案"，现在按实际实现更新过：**§2 是什么状态、§8 还剩什么只能在 Mac 上做**。
> 拿到 Mac 之后直接跳到 **§9 验收清单**逐条打勾。

## 本页现状（v2.6.0 复核）

本页最初写于 **v2.1.0**，后面又补过 **v2.2.0** 的键位改动，所以通篇带历史语境；仓库现在是
**v2.6.0**（`package.json` 的 version = 2.6.0，HEAD `71cdcfc` = tag `v2.6.0`）。本次只做
**引址与口径校正**，不改结构、不改结论：

- §0–§1、§5、§7 以及 §9 的清单：仍是有效内容，但 §9 要靠真机逐条打勾。
- §2「已就绪」表：文件行号已按 v2.6.0 重新核对；打包配置的架构写法已更新。
- §3 字体那条：补了 macOS 26 上的**第二次**教训（族名在 `typefaces[].family`）。
- §4 断言条数：更新为当前口径（Mac 102 条 / Windows·Linux 100 条）。
- §6：整表是 PowerShell 版，mac 上照 `docs/交接-换到Mac继续.md` §7 的命令做。
- §9：产物名与版本号已从 2.2.0 改为当前版本；串口那条改成手填路径连接。

> 本次提到的三处修复（字体族名解析、`build.mac` 架构锁死、`smoke/mac.cjs` 的 fixture 断言）
> **目前只在工作区里，还没有提交**。`release/v2.2.0` 分支与 `v2.2.0` 标签（`b0c6d61`）已冻结，不再动。

## 0. 一句话

让 TermDeck 在 macOS 上**能装上、能开、本地 shell 能起、快捷键符合 mac 习惯、能打包成 dmg/zip**。
Windows 上现有的全部套件闸门**一条都没挂**。

## 1. 硬边界（这台机器能做什么）

| 在 Windows 上就能做完并验证 | 必须 Mac 或 CI |
| --- | --- |
| 平台分支代码（`process.platform === 'darwin'`） | 打出 `.dmg`（要 `hdiutil`） |
| 平台差异抽成**纯函数** + 注入平台参数的探针 | 真跑 mac 版：开窗、起 zsh、开 SSH、串口 |
| 全部套件闸门（证明没改坏 Windows） | 代码签名 / 公证（没有 Apple 开发者账号） |
| `mac` 打包配置、`dist:mac`、CI workflow | Gatekeeper 提示、Keychain 凭据行为 |

## 2. 这一批实际做了什么（每条都在 Windows 上有探针）

| 项 | 位置 | 做法 |
| --- | --- | --- |
| 本地 shell | `src/main/sessions/shellChoice.ts`（新）、`LocalShellBackend.ts` | `chooseShell(platform, env, exists?)` 纯函数：darwin 走 `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`（挑**真的存在**的那个），参数恒为 `[]`；环境补 `TERM`/`LANG`/`PATH`（`/opt/homebrew/bin`、`/usr/local/bin`，已有的不重复加）。Windows 分支逐字保留原行为 |
| 应用菜单 | `src/main/menu.ts`（新）、`index.ts` | darwin 建 App / Edit / Window 三菜单；其它平台仍然 `setApplicationMenu(null)`。Edit 的 role 是 `Cmd+C/V/X/A/Z` 的**唯一来源** |
| 退出确认 | `src/main/quit.ts`、`index.ts` | 菜单的退出项**不是 `role:'quit'`**，而是走渲染端确认；`before-quit` 的会话拆解加了 `isQuitting()` 门控（Dock 菜单的"退出"会直接 `app.quit()`，然后被关窗确认取消） |
| 键位 | `src/shared/platform.ts`（新）、`stores/Stores.ts`、`SettingsDialog.tsx` | `defaultBindings(platform)`：darwin 把 `Ctrl+…` 换成 `Meta+…`，并让 **`Cmd+W` = 关闭当前窗格**；`migrateBindingKeys` 只改写"恰好等于旧默认"的存盘值；设置里的"恢复默认"按平台 |
| 关闭窗口 | `menu.ts` | 系统关窗从 `Cmd+W` 挪到 `Cmd+Shift+W`，把 `Cmd+W` 让给应用自己的绑定 |
| 字体 | `src/main/fonts.ts`、`platform.ts` | darwin 分支读 `system_profiler SPFontsDataType -json`（解析器是纯函数，用 fixture 断言）；默认族名 darwin = `"SF Mono", Menlo, Monaco, "Roboto Mono", "JetBrains Mono", monospace`（不止三个），其它平台**一个字没改** |
| 打包 | `package.json`、`scripts/zipdist.cjs` | `build.mac`（dmg + zip，**配置里不写 arch**，架构交给命令行 `--arm64`/`--x64` 或 runner；产物名 `TermDeck-<ver>-<arch>.<ext>`）、`dist:mac`；`zipdist` 平台化并改成 `require` 安全（darwin/linux 上明确拒绝，mac 的 zip 交给 electron-builder） |
| CI | `.github/workflows/mac.yml`（新） | 两个 runner 分别打包：`macos-15`（arm64）与 `macos-15-intel`（x64） |

### 为什么是两个 runner 而不是一个

`build.npmRebuild` 是 **false**：electron-builder 不会为目标架构重编原生模块。而
`@lydell/node-pty` 是按平台/架构分的**可选依赖包**（`@lydell/node-pty-darwin-arm64` /
`-darwin-x64`，`npm ci` 只装当前架构那个）。所以在 arm64 机器上打 `--x64`，包里带的是 arm64 的
`.node`，x64 那个包一开本地 shell 就废。两个架构必须各自在对应架构的 runner 上装依赖再打包。

> 这个道理在 v2.1.0/v2.2.0 时**被配置顶掉了**：`build.mac.target` 里写死了 `arch: ["arm64","x64"]`，
> 它会覆盖命令行的 `--arm64`/`--x64` —— 实测在 arm64 机器上跑 `npm run dist:mac -- --arm64`
> 仍然把 x64 包一起打了，而那个 x64 包里的原生模块（`pty.node`、ssh2 的 `sshcrypto.node`、
> `cpu-features` 的 `cpufeatures.node`）是 arm64 的，到 Intel 机器上本地 shell 和 SSH 都是坏的。
> 现在配置里只留 `target: ["dmg","zip"]`，架构交给命令行/runner（改后同样的命令只产出 arm64 的
> dmg + zip，已验证），所以 `.github/workflows/mac.yml` 里的
> `npm run dist:mac -- --${{ matrix.arch }}` 才真正是"一个 runner 只打一个架构"。

> runner 标签也是查过的：`macos-13`（Intel）**2025-12-04 已下线**，标准 runner 的 Intel 替代是
> `macos-15-intel`；`macos-latest`/`macos-15` 是 arm64。

### v2.2.0：键位按 Mac 的真实习惯重做（不是把 Ctrl 换成 Cmd）

v2.1.0 的 mac 默认值是 `metaChord()` 机械换出来的（`Cmd+Shift+C` 复制、`F11` 全屏），
v2.2.0 改成一张逐条决定的表 `MAC_BINDING_DEFAULTS`（`src/shared/platform.ts`，参照 iTerm2 与
Terminal.app）：

| 键位 | v2.1.0 | v2.2.0 | 说明 |
| --- | --- | --- | --- |
| 复制 / 粘贴 | `Meta+Shift+C` / `V` | **`Meta+C` / `Meta+V`** | Mac 的复制粘贴就是这两个；`Ctrl+C` 仍是 shell 的 SIGINT |
| 全屏 | `F11` | **`Ctrl+Meta+F`** | Mac 没有 `F11` 习惯，全系统都是 `Ctrl+Cmd+F` |
| 换标签 | `Ctrl+Tab` → `Meta+Tab` | **`Meta+Shift+]` / `[`** | Terminal.app / iTerm2 的手势 |
| 换会话 | `Alt+[` → `Meta+[` | **`Meta+Alt+ArrowLeft/Right`** | iTerm2 的换标签键位；注意 `event.key` 是 `ArrowLeft`，写成 `Left` 永远匹配不上 |
| 跳会话 | `Alt+数字` | **`Cmd+数字`**（`sessionJumpModifier`） | `Option`+数字在 Mac 输入框里是打符号 |
| 打开设置 | 键位 `Meta+,` | **应用菜单「Settings…」** | 键位表里置空，避免和菜单抢 |
| 退出 | 键位 `Meta+Shift+Q` | **应用菜单「Quit」** | 同上，`Cmd+Q` 由菜单提供 |
| 锁屏 | `Meta+Alt+L` | **`Ctrl+Meta+L`** | 与 Windows `Ctrl+Alt+L` 对位；不占系统的 `Ctrl+Cmd+Q` |
| 关已结束的窗格 | `Meta+D` | **不绑** | `Cmd+W` 关任何窗格；`Cmd+D` 在 mac 终端里是分屏 |

另外三处"使用习惯"的差异，都是**只在 darwin 上生效**：

- `defaultClipboardSettings('darwin')`：`copyOnSelect: false`（Mac 的习惯是选中后按 `Cmd+C`）、
  `pasteOnMiddleClick: false`（没有中键）；右键粘贴两边都保留（还没有终端右键菜单可用）。
- `isNativeEditTarget()`：`Cmd+C` / `Cmd+V` 在**输入框**里交回系统（焦点在终端里才归应用）。
  没有它，设置里的每个输入框在 mac 上都按不了复制粘贴。
- `displayChord()`：存储用 `Meta+…`、显示用 `Cmd+…`；抽屉提示、重连提示、设置里的快捷键列表
  都走它，所以界面上不会再出现 `Meta+R` 这种话。

迁移因此有两代来源：Windows 默认值、以及 **v2.1.0 存进用户机器里的 mac 默认值**，两者都只在
"值恰好等于旧默认"时改写（`retiredBindingDefaults` 现在每个 id 是一个规则列表）。

### 已经就绪、不用重做的部分

| 位置 | 现状 |
| --- | --- |
| `src/main/index.ts:137` | `app.on('activate')`：Dock 点击重开窗口 |
| `src/main/index.ts:144-148` | `window-all-closed` 里 `if (process.platform !== 'darwin') app.quit()`（darwin 判断在 :147） |
| `src/main/ssh/KnownHosts.ts` | `homedir()` + `.ssh/known_hosts`，写盘 `0o600` |
| `src/main/ipc.ts`、`src/main/store/CredentialStore.ts:19` | `app:info` 返回 `platform`；`safeStorage` 在 mac 走 Keychain（实现落在 CredentialStore） |
| `src/main/sessions/SshShellBackend.ts:131` | 优先 `SSH_AUTH_SOCK`（Windows 才回退 pageant） |

## 3. 本轮踩到/避开的坑（下一轮别重踩）

- **`role:'quit'` 不能直接用**：它直接 `app.quit()`，而退出确认挂在窗口 `close` 上 ——
  用户点"取消"时，`before-quit` 里已经把会话全拆了。所以退出项是自定义项（走渲染端确认），
  且 `before-quit` 只在 `isQuitting()` 为真时才拆会话。
- **`Cmd+W` 不能被菜单占**：`role:'close'` 默认就是 `Cmd+W`，会和应用自己的"关闭窗格"抢。
  菜单里给它显式 `accelerator: 'Command+Shift+W'`。
- **`system_profiler` 的 JSON 解析不能只认一层，也不能只认 `_name`**：第一版只遍历数组和
  `_items`，结果是**空表** ——探针当场抓住（顶层对象 `SPFontsDataType` 这个键没被走）。
  改成遍历文档里所有 `_name` 之后，在 macOS 26 上又踩了一次：顶层 `_name` 是字体**文件名**
  （本机 294 个条目里 292 个带扩展名，如 `Times New Roman Bold.ttf`），真正的族名在
  `typefaces[].family`（342 个）。后果是字体下拉里显示的是文件名，真机探针那条（枚举出的名字
  不含 `.ttf`）也必红 ——修前实跑 100/101、EXIT=1。所以 `parseMacFontFamilies` 现在优先取
  `typefaces[].family`，回退 `_name` 并过滤文件名/含 `/` 的名字。
- **探针不许用反引号**：`scripts/checkprobes.cjs` 按反引号计数判断模板字面量边界，
  注释里多一个就会让整个探针"解析失败"。`smoke/mac.cjs` 全程用单引号拼字符串。
- **本机的 `npm run build` / `verify` 需要在非受限沙箱下跑**：esbuild 起服务进程用管道 stdio，
  受限沙箱下是 `spawn EPERM`（`check:probes` 的 `spawnSync` 同理）。这不是项目问题。
- **探针不能和打包放在同一个 CI job 里**：v2.1.0 就是这么丢掉了 mac 产物 —— 探针在真机上红了一条，
  打包被跳过，Actions 上只剩一个红叉。现在 `probe` 与 `package` 是两个独立 job：产物照出，
  探针的红绿单独可见，失败的检查项用 `::error::` 注解出来（REST API 也能读到，不必去下日志 zip）。
- **`system_profiler` 要绝对路径 + 足够超时**：GUI 启动的应用拿到的是 launchd 的 PATH
  （不保证有 `/usr/sbin`），冷启动枚举字体也可能超过 20 秒。现在用 `/usr/sbin/system_profiler`、
  60 秒超时；`listInstalledFonts()` 自己**不缓存**，把结果缓存整个进程生命周期的是调用方
  `src/main/ipc.ts:1404-1405`。
- **迁移表的 Windows 规则别预置进 darwin 表**：第一版把 `closeSession: Ctrl+W → ''` 无条件预置，
  于是 mac 上 `Ctrl+W` 命中的是"解绑"那条、而不是"→ `Cmd+W`"那条 —— 探针当场抓出来
  （`migrateBindingKeys('darwin','closeSession','Ctrl+W')` 应为 `Meta+W`）。

## 4. 探针（`npm run smoke:mac`，已挂进 `verify`）

`smoke/mac.cjs` 当前共 **99 条平台无关断言 + 3 条真机断言**：macOS 实跑 **102 条**，
Windows/Linux 上是 **100 条**（99 + 1 条 SKIP）。下面是这些断言覆盖的范围；它们在 v2.0.0 的
实现上必然失败（那些函数/分支当时都不存在）：

- `chooseShell('darwin', …)`：选 zsh、`args` 为空且不含 `-NoLogo`、补 `TERM`/`LANG`/Homebrew PATH、
  已有值不覆盖、`$SHELL` 不存在时回退；Windows 分支（`%COMSPEC%`、`-NoLogo`、不注入 env）逐条不变；
- `defaultBindings('darwin')`：`Cmd+W` = 关闭窗格、一个 `Ctrl+` 都不剩、条数与基础表一致；
  `defaultBindings('win32')` 与 `DEFAULT_KEYBINDINGS` **完全相等**；
- `migrateBindingKeys`：mac 上旧 `Ctrl+W`/`Ctrl+T` → `Meta+…`；用户自设的 `Ctrl+Shift+T` 不动；
  Windows 上 `Ctrl+W` → 空（v1.13.0 的决定保留）；
- `menuTemplateFor`：`win32`/`linux` 返回 `null`；darwin 有 6 个 Edit role、不占 `Cmd+W`、
  关窗在 `Cmd+Shift+W`、退出项会调 `askQuit`、并且 `Menu.buildFromTemplate` 真能建起来；
- 字体：`parseMacFontFamilies` 用 fixture 断言（含去重、去空白、坏 JSON、嵌套，以及一条
  「macOS 26 形状」的：顶层 `_name` 是文件名、族名在 `typefaces[].family` ——旧实现必然失败）；
  `defaultFontFamily('win32')` 与旧串**逐字相等**；
- 打包：`package.json` 的 mac target（dmg+zip、**不锁死架构** —— arch 只来自命令行/runner，
  锁死会让 `--arm64`/`--x64` 失效并打出坏包）、产物名格式、`dist:mac`、
  zipdist 在 darwin/linux 上拒绝、CI workflow 的 runner 与 `npm ci`。

在**真的 macOS** 上跑同一个探针时（CI 或你自己的 Mac），会在通用断言之外**额外追加 3 条**
真实平台断言（真 `$SHELL`、字体枚举非空、枚举出的是族名而不是 `*.ttf` 文件名）。
Windows/Linux 上这 3 条不跑，只留 1 条说明项；严格说这条的 `ok` 传的是 `true`，所以 report 里
显示成 **PASS**、只有 `detail` 写着 `SKIP on <platform>` ——**它并不是真的跳过**，别当成验过了。

## 5. 需要在 Mac 上做的（见 §9）

代码先行、真机验收后补。唯一无法在 Windows 上判对错的是：**PTY 真起不起得来**、
**system_profiler 真输出的形状**、**Gatekeeper 与钥匙串的真实行为**、**串口真机能不能连通**
（应用没有串口设备枚举，是手填 `/dev/cu.*` 路径去连）。

## 6. 铁律（照搬，别重新踩）

| 事 | 做法 |
| --- | --- |
| 验证 | `Remove-Item -Recurse -Force node_modules\.smoke-data` 后跑 `npm run verify`，要求 **EXITCODE=0 且 0 条 FAIL**。偶发失败先单独重跑该套件确认 |
| 探针 | 每项改动要有**能区分对错**的断言（旧实现必然失败）；探针里**不能出现反引号和 `\s`**，换行用 `String.fromCharCode(10)`；跑 `npm run check:probes` |
| 提交 | 中文：`新增:` / `修复:` / `改进:` / `文档:` / `发布:`；功能与文档**各一个提交** |
| 发布 | 版本号 → 文档 → `dist:win` + `pack:zip` → 打包版自检 → `SHA256SUMS-<版本>.txt` → 分支 `release/v<版本>` + 标签 `v<版本>`（停在构建提交）→ 推 origin |
| 中文文件 | **别用 PowerShell `Get-Content`/`Set-Content` 读写中文**（会乱码/加 BOM）；用 read/write/edit 工具 |
| 提交信息 | 别用 `git commit -m` 带英文引号（PowerShell 会拆参数）；写进文件用 `git commit -F` |
| 自检脚本 | 打包版自检结束后按进程名杀干净（`Stop-Process -Name TermDeck`），否则占着 `release/win-unpacked` 会让下一次打包 `EBUSY` |
| Mac 命令 | 上表是 **Windows/PowerShell 版**（`Remove-Item`、`Stop-Process`、引号陷阱）；mac 上的对应写法（`rm -rf`、`pkill`、`git commit -F` 等）照 `docs/交接-换到Mac继续.md` §7「铁律（换成 mac 命令后仍然成立）」 |

## 7. 用户这一批拍的板（2026-10-23，实现照此）

1. **快捷键**：mac 上用 `Cmd`（`Meta`）作默认修饰键，**按平台给默认值**，并沿用 v1.13.0 的
   `RETIRED_BINDING_DEFAULTS` 思路做迁移 —— **只在存盘值恰好等于旧默认时改写**。
   （"Ctrl 也同时认"没有采用：匹配器仍要求修饰键精确相等。）
2. **`Cmd+W`**：绑"关闭当前窗格"；系统关窗让给 `Cmd+Shift+W`。
3. **窗口外观**：保持标准标题栏，先不做 `hiddenInset`。
4. **签名**：这一批不做（没有 Apple 开发者账号），走"未签名 + 右键打开 / `xattr -dr com.apple.quarantine`"。
5. **包结构**：arm64 与 x64 两个包，不做 universal。

## 8. 本批用到的命令（Mac 上打包时照抄）

```bash
npm run dist:mac               # dmg + zip，只打当前机器架构（配置里不写 arch 了）
npm run dist:mac -- --arm64    # 只打 arm64（CI 就是这么调的；以前配置会顶掉这个参数）
```

---

## 9. Mac 验收清单（拿到 Mac 后照着做，逐条打勾）

> 前置：macOS 上装 Node 20+ 与 Xcode 命令行工具（`xcode-select --install`）。

### 9.1 从 CI 拿产物（最快的一条路）

1. 打开 `https://github.com/lblacklewis/termdeck/actions`，选 **mac** workflow，
   最近一次 `release/v2.6.0` 的 run（`release/v2.2.0` 分支与 `v2.2.0` 标签已冻结，别再看那个）；
   - `package (macos-15, arm64)` 与 `package (macos-15-intel, x64)` 两个 job 各出一个架构；
   - 同一个 run 里还有 `probe (...)` 两个 job —— 那是真机探针，**红的话把失败的检查项抄下来**
     （它们会以注解形式挂在 run 页面上）；它红不影响产物，但说明 mac 分支有问题。
2. 下载 `TermDeck-mac-arm64` 与 `TermDeck-mac-x64` 两个 artifact（各含 dmg、zip 和
   `SHA256SUMS-<版本>-mac-<架构>.txt`，当前版本是 `2.6.0`）；
3. 校验：`shasum -a 256 TermDeck-<版本>-arm64.dmg`，和 artifact 里的那份 txt 核对；
4. 装：

   ```bash
   hdiutil attach TermDeck-<版本>-arm64.dmg        # 或直接双击
   cp -R /Volumes/TermDeck/TermDeck.app /Applications/
   xattr -dr com.apple.quarantine /Applications/TermDeck.app   # 未签名，解除隔离
   open /Applications/TermDeck.app
   ```

   > 本机（arm64）已实际出过一轮产物：`TermDeck-2.6.0-arm64.dmg` 与 `.zip`（各约 100MB）、
   > `SHA256SUMS-2.6.0-mac-arm64.txt`；dmg 能挂载，里面是可执行的 arm64、版本 2.6.0。

   - [ ] **双击**会提示"无法验证开发者"；**右键 → 打开**能进去（这条要亲眼看一遍）
   - [ ] `xattr -dr` 之后可以正常双击
   - [ ] 应用能起、窗口正常、标题栏是标准样式（这一批没做 hiddenInset）
   - [ ] 菜单栏有 **TermDeck / Edit / Window** 三个菜单，App 菜单里有「Settings…」与「Quit TermDeck」
   - [ ] `Cmd+Q` 会先弹退出确认；点"取消"后**窗格和会话都还在**（这是 before-quit 门控那条）
   - [ ] 关掉所有窗口后应用不退出；点 Dock 图标能重新开窗

### 9.2 从源码跑（要改代码时）

```bash
git clone git@github.com:lblacklewis/termdeck.git && cd termdeck
git switch release/v2.6.0
npm install
node -e "require('@lydell/node-pty'); console.log('pty ok')"      # 不报错才算过
node -e "require('serialport'); console.log('serial ok')"
rm -rf node_modules/.smoke-data && npm run verify                  # 期望 0 条 FAIL
env -u ELECTRON_RUN_AS_NODE npm run smoke:mac                       # 真机断言；实测 102/102，EXIT=0
```

- [ ] `npm run verify` 全绿（有失败先判断：真 bug，还是探针写死了 Windows —— 本地 shell / 串口 /
      字体这三类最可能；**不许靠放宽断言"修好"**）
- [ ] `npm run smoke:mac` 全绿（**102 条** = 99 条通用 + 3 条真机；Windows/Linux 上是 100 条），
      本机实测输出 `102/102 checks passed`、EXIT=0，尤其是最后几条真实平台断言（`$SHELL`、字体枚举非空）
- [ ] 如果 `@lydell/node-pty` 装不上（没有预编译、又编不过），换回官方 `node-pty` 并记录原因

### 9.3 开发版人工过一遍（`npm run dev`）

键位这一批（v2.2.0）改的就是这些，逐条按下去看：

- [ ] 终端里选中一段 → **`Cmd+C`** 复制、**`Cmd+V`** 粘贴（**不是** `Cmd+Shift+C`）
- [ ] 设置 / 对话框的**输入框**里 `Cmd+C` / `Cmd+V` 可用（这一条走系统，不是应用处理）
- [ ] 终端里**选中不会自动进剪贴板**（Mac 习惯）；设置 → 剪贴板 里的 "选中即复制" 默认是关的
- [ ] `Cmd+1` … `Cmd+9` 跳到第 N 个会话；`Cmd+Shift+]` / `[` 换标签；`Cmd+Alt+→` / `←` 换会话
- [ ] `Ctrl+Cmd+F` 进 / 出专注模式（`F11` 不再是默认键）
- [ ] 应用菜单：**Settings…**（`Cmd+,`）打开设置抽屉；**Quit TermDeck**（`Cmd+Q`）先问一句
- [ ] 设置 → 快捷键 里显示的是 `Cmd+…`（不是 `Meta+…`）；抽屉底部"新建连接"的悬浮提示是 `Cmd+T`
- [ ] 开本地 shell：起的是 **zsh**、提示符正常；`which brew`、`ls /opt/homebrew/bin` 找得到
- [ ] 终端里 `Cmd+W` 关掉当前窗格；`Cmd+Shift+W` 关窗口（会先问一句）
- [ ] 终端里按 `Ctrl+W`：**删掉光标前一个词**、不关窗格（v1.13.0 的决定在 mac 同样成立）
- [ ] 字体不是方块、中文能显示；设置 → 终端里的字体下拉里是**族名**（本机枚举出 342 个，如
      Times New Roman、圆体-繁），**不是 `Times New Roman Bold.ttf` 这类文件名**
- [ ] 钥匙串：连一次带密码的主机，重启应用后密码还在；把 app 移到别处再试一次
      （未签名/被移动时 `safeStorage` 可能取不回密文，这是要写进发布说明的行为）
- [ ] 串口页**手填** `/dev/cu.*` 路径能连上（应用没有串口设备枚举，全库没有 `SerialPort.list()`；
      输入框默认 `COM1`、提示文案是 `/dev/ttyUSB0`，mac 上自己填设备路径）
- [ ] `Ctrl+Cmd+F` 能进能出全屏

### 9.4 打包版自检（Windows 那份 `.packcheck-*.cjs` **不在仓库里**，要自带）

> Windows 上那个 `.packcheck-*.cjs` 从来没入库（git 全历史 0 命中，只存在于 Windows 本机
> gitignore 的 `release/` 里），没有"照抄"可言：要么自己带一份，要么照下面用 CDP 手做。

```bash
# 环境里若设了 ELECTRON_RUN_AS_NODE=1（某些 Electron 宿主 shell 会设），打包版会退化成
# 纯 Node 启动并报 bad option: --remote-debugging-port=...，所以先 env -u 掉
env -u ELECTRON_RUN_AS_NODE \
  /Applications/TermDeck.app/Contents/MacOS/TermDeck \
  --remote-debugging-port=9360 --user-data-dir=/tmp/td-check
```

用 CDP 断言：版本号显示 **2.6.0**、`platform` 是 darwin、能开出一个本地 shell 并在里面执行命令
（写出 `TD_PTY_OK_42`）、菜单快捷键生效（`Cmd+T` 开新建连接）。本机（arm64）已按这套跑过
**7/7**：版本 2.6.0、platform darwin、localShellAvailable=true、本地 shell 起得来且能执行命令。

- [ ] 版本号正确
- [ ] 打包版能起本地 shell（**这条才是 `npmRebuild: false` 与原生模块的真验收**）
- [ ] 打包版能连 SSH

### 9.5 记录结论

哪些过了、哪些挂了（带日志与截图），下一轮照着修；**别用"看起来没问题"结案**。

---

## 10. 顺带记下的、后面可以做的 mac 小事

- ~~界面里写死 `Ctrl+…` 的提示文案~~ **v2.2.0 已修**：`DrawerFooter` 的"新建连接"、重连提示、
  设置里的快捷键列表、重连说明段落，全部走 `displayChord(键位, 平台)`；词表用的是 `{chord}` 占位符。
- 还没有**终端右键菜单**（Copy / Paste / Select All）。现在右键 = 粘贴（两个平台都是），
  mac 用户可能预期弹菜单；因为还没有菜单，这一批没把右键粘贴关掉（关掉就等于什么都没发生）。
- `toggleFocus` 在 mac 上是 `Ctrl+Cmd+F`；系统"进入全屏"也是这个键，但我们的 View 菜单里没有
  `togglefullscreen` role，所以不冲突。以后若加了那个 role，要处理两者抢键。
- `Cmd+K`（清屏）是 Mac 终端的常见习惯，这个应用还没有"清空缓冲区"这个命令，所以没绑。
- 窗口外观没做 `hiddenInset`（用户 2026-10-23 明确说保持标准标题栏）。
- 签名与公证：需要 Apple 开发者账号（$99/年）+ `notarytool`。这一批不做。
  arm64 上如果 ad-hoc 签名都没有、装完起不来，第一步先 `codesign --force --deep -s - TermDeck.app`
  试一次，再决定要不要走正式签名。
