# 交接：macOS 适配（基于 v2.0.0）

> **这份文档是给"新开一个会话专门做 macOS 适配"用的**，自包含：不读别的文档也能开工。
> 仓库：`D:\project\dsh-workspace\termdeck`（Windows 机器上）。版本基线 **v2.0.0**。
> 先读本文件的「0. 一句话」和「1. 硬边界」，再按「4. 待做清单」逐项做。

## 0. 一句话

让 TermDeck 在 macOS 上**能装上、能开、本地 shell 能起、快捷键符合 mac 习惯、能打包成 dmg/zip**。
Windows 上现有的 46 套件闸门**一条都不许挂**。

## 1. 硬边界（先认清，别做无用功）

**这台机器是 Windows，没有 macOS 工具链。** 所以：

| 能做（在这台机器上就能完成并验证） | 不能做（必须 Mac 或 CI） |
| --- | --- |
| 写平台分支代码（`process.platform === 'darwin'`） | 打出 `.dmg`（要用 `hdiutil`，只有 mac 有） |
| 把平台差异抽成**纯函数**，用注入的平台参数写探针断言 | 真跑 mac 版：开窗、起 zsh、开 SSH |
| 跑现有 46 套件闸门（保证没改坏 Windows） | 代码签名 / 公证（需要 Apple 开发者账号） |
| 加 `mac` 打包配置、`dist:mac` 脚本、CI workflow | 验证 Gatekeeper 提示、Keychain 凭据行为 |

**结论**：这一批交付"**代码 + 配置 + 可在 Windows 上判对错的探针 + CI 构建**"；
**真机验收必须在 Mac 上再跑一次**（或者让 CI 在 `macos-latest` 上跑）。

## 2. 现状：已经 mac-aware 的部分（不用重做）

| 位置 | 现状 | 说明 |
| --- | --- | --- |
| `src/main/index.ts:119` | 有 `app.on('activate')` | Dock 点击重开窗口已经有了 |
| `src/main/index.ts:126-129` | `window-all-closed` 里 `if (process.platform !== 'darwin') app.quit()` | 关窗不退出，已经对 |
| `src/main/ssh/KnownHosts.ts:15,145` | 用 `homedir()` + `join('.ssh','known_hosts')`，写盘 `mode: 0o600` | 路径与权限跨平台 |
| `src/main/fonts.ts:41` | 候选字体里有 `Menlo` | 检测不到系统字体时也有可用回退 |
| `src/main/ipc.ts:1696` | `app:info` 返回 `platform: process.platform` | 界面拿得到平台 |
| `src/main/sessions/SshShellBackend.ts:132` | 优先 `SSH_AUTH_SOCK`，Windows 才回退 pageant | mac 上 ssh-agent 正常 |

## 3. Windows 专有 / macOS 缺失清单（带证据）

```
src/main/fonts.ts:61            win32 走注册表(PowerShell)、:82 linux 走 fc-list，darwin 没有分支
src/main/sessions/LocalShellBackend.ts:46,72   本地 shell 检测与参数：win32 走 COMSPEC/ConPTY、powershell 加 -NoLogo…
src/main/shortcuts.ts:20       Menu.setApplicationMenu(null)      ← mac 上这条是致命的，见 4.2
src/main/sessions/SerialBackend.ts              serialport（原生模块）
scripts/zipdist.cjs:2,62,65    写死 win-unpacked / TermDeck-<v>-win-x64-portable.zip
package.json:123-139           build.win 有 target，build.mac 不存在；npmRebuild: false
package.json:95,97,98          electron 33 / electron-vite；React 19
```

## 4. 待做清单

### 4.1 本地 shell（必须，否则 mac 上开了窗格没 shell）

- `LocalShellBackend.ts`：平台分支里补 darwin —— 取 `process.env.SHELL`（mac 默认 `/bin/zsh`），
  回退顺序 `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`；**不要传 Windows 那套参数**
  （`-NoLogo` 之类是 PowerShell 的），mac 上交互式登录 shell 一般直接用 argv 空数组或 `['-l']`。
- 环境：把 `TERM=xterm-256color`、`LANG`（mac 常见 `en_US.UTF-8`）、以及 `PATH` 的常见补充
  （`/opt/homebrew/bin`、`/usr/local/bin`）带上 —— 否则 Mac 用户 `brew` 装的东西在 TermDeck 里"不存在"。
- 探针：把"给定平台 + 给定 env → 决定用哪个 shell、传什么参数"抽成**纯函数**
  （例如 `src/main/sessions/shellChoice.ts` 导出 `chooseShell(platform, env)`），
  探针注入 `('darwin', { SHELL: '/bin/zsh' })` 断言选择与参数 **不含 Windows 参数** ✓
  这样在 Windows 上就能判对错。

### 4.2 应用菜单（**mac 上不做这个，复制粘贴全废**）

现在 `src/main/shortcuts.ts:20` 是 `Menu.setApplicationMenu(null)`。这在 Windows 上是对的
（自绘快捷键 + 捕获阶段匹配），但 macOS 上：

- **`Cmd+C` / `Cmd+V` / `Cmd+X` / `Cmd+A` / `Cmd+Z` 是 Edit 菜单的 role 提供的**，
  没有菜单就没有这些快捷键（不是"我们没绑"，是系统不给）；
- `Cmd+Q`（退出）、`Cmd+H`（隐藏）、`Cmd+M`（最小化）来自 App / Window 菜单；
- `Cmd+W` 来自 Window 菜单的 close role。

做法：`if (process.platform === 'darwin')` 时 `Menu.setApplicationMenu(Menu.buildFromTemplate([...]))`，
模板最小集：App 菜单（about/services/hide/quit）、Edit（undo/redo/cut/copy/paste/selectAll）、
Window（minimize/zoom/close/front）；其它平台继续 `null`。
**注意**：Edit 的 role 只管原生输入框；xterm 的复制粘贴是应用自己处理的（现有快捷键已覆盖），
两者要**都留着**、别互相抢。

### 4.3 快捷键的 Modifier（需要用户拍板，见 §7）

现有默认键位是 `Ctrl+...`（`src/shared/types.ts` 的 `DEFAULT_KEYBINDINGS`）。mac 习惯是 `Cmd`。
建议：**匹配器同时认两者太随意**；更稳的是按平台给默认值（darwin 用 `Meta`／`Cmd`），
并且沿用 v1.13.0 的老键位迁移思路（`RETIRED_BINDING_DEFAULTS`，只在值等于旧默认时改写）。

另：**`Ctrl+W` 在 mac 的 readline 里同样是"删前一个词"**，v1.13.0 已经把它默认解绑 ✓ 这个决定
在 mac 上继续成立，别"顺手加回来"。

### 4.4 字体

`fonts.ts` 补 darwin：用 `system_profiler SPFontsDataType`（慢）或直接给一份 mac 常见等宽字体
候选（`SF Mono` / `Menlo` / `Monaco` / `JetBrains Mono` / `Hack`），并且
`DEFAULT_TERMINAL_SETTINGS` 的字体默认值**按平台给**（Windows 现在是 Cascadia/Consolas）。
探针同样走纯函数注入平台。

### 4.5 原生模块（mac 上最容易"装上但起不来"）

`node-pty`（`@lydell/node-pty`，本地 shell 必需）与 `serialport` 是原生模块，
而 `package.json` 的 `build.npmRebuild` 是 **false** —— 打包时**不会**为构建目标重编原生模块。

- 结论：**在 mac 上要先 `npm install`**（拉 darwin 预编译产物；装不到就要 Xcode CLT 现编），
  再 `npm run dist:mac`。别指望在 Windows 上打出一个能在 mac 跑的包。
- 要确认 `@lydell/node-pty` 是否有 **darwin arm64/x64** 预编译；没有的话要换回官方 `node-pty`
  或自己编（这条建议在 Mac 上第一件事就验）。

### 4.6 打包与分发

- `package.json` 加：
  ```jsonc
  "mac": {
    "target": [{ "target": "dmg", "arch": ["arm64", "x64"] },
               { "target": "zip", "arch": ["arm64", "x64"] }],
    "category": "public.app-category.developer-tools",
    "artifactName": "TermDeck-${version}-${arch}.${ext}"
  }
  ```
  并加脚本 `"dist:mac": "npm run build && electron-builder --mac"`。
- `scripts/zipdist.cjs` 要平台化（现在写死 `win-unpacked` 与 `-win-x64-portable.zip`）；
  mac 的 zip target 由 electron-builder 自己出，可以不改这个脚本、只让 Windows 用它。
- **签名与公证**：需要 Apple 开发者账号（$99/年）+ `notarytool`。**这一批不做**，
  但发布说明必须写清：未签名 → Gatekeeper 提示"无法验证开发者" → 右键"打开"，
  或 `xattr -dr com.apple.quarantine /Applications/TermDeck.app`。
- `safeStorage` 在 mac 走 **Keychain**：应用未签名/被移动时，已存的密文可能取不回来 ——
  发布说明里提醒用户"换位置后可能需重新输入密码"。

### 4.7 串口 / known_hosts / 其它

- `SerialBackend`：mac 下设备名是 `/dev/tty.usbserial-*` / `/dev/cu.*`，枚举逻辑要能列出它们
  （现在依赖 serialport 的列表 ✓ 大概率可用，但要在 Mac 上真验一次）。
- `SshShellBackend:132`：mac 上若没有 `SSH_AUTH_SOCK`，可回退读 `/private/tmp/com.apple.launchd.*/Listeners`
  或用 1Password 的 agent socket（可选，先记着）。

## 5. 验证策略（关键：怎么在没有 Mac 的情况下判对错）

1. **Windows 上必须做的**：`Remove-Item -Recurse -Force node_modules\.smoke-data` 后
   `npm run verify` → **EXITCODE=0 且 0 条 FAIL**（46 套件）。所有平台分支改动都不许弄坏 Windows。
2. **平台差异抽成纯函数**（`chooseShell` / `defaultFontFamily` / `defaultBindings(platform)` /
   `menuTemplate(platform)`），探针**注入平台参数**断言 mac 分支的选择 ——
   这类断言在 Windows 上跑，旧实现必然失败（例如"darwin 下不得出现 `-NoLogo`"）。
3. **必须 Mac 上跑的**（写进 CI 或让用户在 Mac 上执行）：
   `npm run verify` 全量 + 打包版自检（`release/mac*/TermDeck.app` 用 `--remote-debugging-port` + CDP，
   照 v1.13.x 的 `.packcheck-*.cjs` 套路）。
4. **CI（建议这一批顺手加）**：仓库现在**没有 `.github/`**。加
   `.github/workflows/mac.yml`：`runs-on: macos-latest`，`npm ci` + `npm run check:probes` +
   `check:i18n` + `typecheck` + `npm run dist:mac`，先只出未签名产物（能跑起来就是胜利）。
   macOS runner 能起 GUI 应用，后面可再加"跑探针子集"。

## 6. 铁律（照搬，别重新踩）

| 事 | 做法 |
| --- | --- |
| 探针 | 每项改动要有**能区分对错**的断言（旧实现必然失败）；探针模板里**不能出现反引号和 `\s`**，换行用 `String.fromCharCode(10)`；跑 `npm run check:probes` |
| 提交 | 中文：`新增:` / `修复:` / `改进:` / `文档:` / `发布:`；功能与文档**各一个提交** |
| 发布 | 版本号 → 文档 → `dist:win` + `pack:zip` → 打包版自检 → `SHA256SUMS-<版本>.txt` → 分支 `release/v<版本>` + 标签 `v<版本>`（停在构建提交）→ 推 origin |
| 中文文件 | **别用 PowerShell `Get-Content`/`Set-Content` 读写中文**（会乱码/加 BOM）；用 `read`/`write`/`edit` 工具或 `[System.IO.File]::ReadAllText(...,UTF8)` |
| 提交信息 | 别用 `git commit -m` 带英文引号（PowerShell 会拆参数）；写进文件用 `git commit -F` |
| 自检脚本 | 打包版自检结束后**按进程名杀干净**（`Stop-Process -Name TermDeck`），否则占着 `release/win-unpacked` 会让下一次打包 `EBUSY` |

## 7. 需要用户拍板的（开工前问，别自己定）

1. **快捷键**：mac 上用 `Cmd`（`Meta`）作为默认修饰键？还是保持 `Ctrl` 不变？两者都认吗？
2. **`Cmd+W`**：绑"关闭当前窗格"还是留给系统（关窗口）？
3. **窗口外观**：保持标准标题栏，还是做 `titleBarStyle: 'hiddenInset'`（内容延伸到红绿灯旁边）？
4. **签名**：有没有 Apple 开发者账号？没有的话发布说明就走"未签名 + 右键打开"的路子。
5. **包结构**：arm64 + x64 两个包，还是一个 universal（体积翻倍）？

## 8. 建议的开工顺序

1. 读本文件 + 跑一次 `npm run verify` 确认基线绿（46 套件）；
2. **先让它能起来**：`chooseShell` 纯函数 + darwin 分支 + 探针；
3. **菜单**（4.2）—— 不做这个，mac 上连复制粘贴都不可用；
4. 字体默认值按平台（4.4）；
5. `dist:mac` + `package.json` 的 mac 配置 + `scripts/zipdist.cjs` 平台化（4.6）；
6. CI workflow（§5.4），让 mac 构建自动跑；
7. 剩下键位（4.3）与细节（4.7）按用户拍板结果做；
8. 版本号 **v2.1.0**（新增平台支持 = minor），走上面的发布流程 —— 注意产物变成
   Windows 三件 + mac 的 dmg/zip，`SHA256SUMS` 要**都列上**。

## 9. Mac 验收清单（拿到 Mac 后照着做，逐条打勾）

> 本机是 Windows，**下面每一步都必须在一台真的 Mac 上跑**。用户 2026-10-23 说
> "现在没有 mac 验收，晚一些或者明天可以的" —— 所以代码可以先行，验收按这份清单补。

前置：macOS 上装 Node 20+ 与 Xcode 命令行工具（`xcode-select --install`），然后 clone 仓库。

1. **装依赖（必须在 Mac 上装，原生模块才有 darwin 产物）**
   ```bash
   git clone <repo> && cd termdeck && npm install
   node -e "require('@lydell/node-pty'); console.log('pty ok')"   # 不报错才算过
   node -e "require('serialport'); console.log('serial ok')"
   ```
   若 `@lydell/node-pty` 没有 darwin 预编译 → 在这里现编（需要 Xcode CLT），
   编不过就换回官方 `node-pty` 并记录原因。

2. **闸门全绿**
   ```bash
   rm -rf node_modules/.smoke-data && npm run verify     # 期望 EXITCODE=0、0 条 FAIL、46 套件
   ```
   有失败先逐条判断：是**真 bug**，还是**探针写死了 Windows**（本地 shell / 串口 / 字体这三类最可能）。
   后者要把探针改成"按平台断言各自的期望值"，不是放宽断言。

3. **开发版人工过一遍**（`npm run dev`）
   - [ ] 开本地 shell：起的是 zsh、提示符正常、`brew` 装的命令找得到
   - [ ] 设置里的输入框：`Cmd+C` / `Cmd+V` / `Cmd+A` 可用（Edit 菜单 role 生效）
   - [ ] `Cmd+Q` 能退出；`Cmd+W` 是按我们绑定的行为（关窗格）
   - [ ] Dock 图标点击能重新开窗口；关掉所有窗口后应用不退出
   - [ ] 终端里按 `Ctrl+W`：**删掉光标前一个词**、不关窗格（v1.13.0 的决定在 mac 同样成立）
   - [ ] 字体不是方块、中文能显示（默认等宽字体在 mac 上存在）
   - [ ] 钥匙串：连一次带密码的主机，重启应用后密码还在（safeStorage 走 Keychain）

4. **打包**
   ```bash
   npm run dist:mac      # 出 dmg + zip（arm64 与 x64）
   ```
   打开 dmg 拖进 Applications → **右键「打开」**（未签名；或
   `xattr -dr com.apple.quarantine /Applications/TermDeck.app`）。
   验：能起、能连 SSH、能开本地 shell、串口页能列出 `/dev/cu.*`。

5. **打包版自检**（照 Windows 的 `.packcheck-*.cjs` 套路）
   ```bash
   release/mac*/TermDeck.app/Contents/MacOS/TermDeck \
     --remote-debugging-port=9360 --user-data-dir=/tmp/td-check
   ```
   用 CDP 断言：版本号显示正确、能开出一个本地 shell、菜单快捷键生效。

6. **记录结论**：哪些过了、哪些挂了（带日志与截图），下一轮照着修；别用"看起来没问题"结案。
