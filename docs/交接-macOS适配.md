# 交接：macOS 适配（基于 v2.0.0，交付 v2.1.0）

> 仓库：`D:\project\dsh-workspace\termdeck`（开发机是 Windows）。版本基线 **v2.0.0** → 交付 **v2.1.0**。
> 这份文档原本是"开工前方案"，现在按实际实现更新过：**§2 是什么状态、§8 还剩什么只能在 Mac 上做**。
> 拿到 Mac 之后直接跳到 **§9 验收清单**逐条打勾。

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
| 字体 | `src/main/fonts.ts`、`platform.ts` | darwin 分支读 `system_profiler SPFontsDataType -json`（解析器是纯函数，用 fixture 断言）；默认族名 darwin = `SF Mono/Menlo/Monaco`，其它平台**一个字没改** |
| 打包 | `package.json`、`scripts/zipdist.cjs` | `build.mac`（dmg + zip，arm64 与 x64 分开，产物名 `TermDeck-<ver>-<arch>.<ext>`）、`dist:mac`；`zipdist` 平台化并改成 `require` 安全（darwin/linux 上明确拒绝，mac 的 zip 交给 electron-builder） |
| CI | `.github/workflows/mac.yml`（新） | 两个 runner 分别打包：`macos-15`（arm64）与 `macos-15-intel`（x64） |

### 为什么是两个 runner 而不是一个

`build.npmRebuild` 是 **false**：electron-builder 不会为目标架构重编原生模块。而
`@lydell/node-pty` 是按平台/架构分的**可选依赖包**（`@lydell/node-pty-darwin-arm64` /
`-darwin-x64`，`npm ci` 只装当前架构那个）。所以在 arm64 机器上打 `--x64`，包里带的是 arm64 的
`.node`，x64 那个包一开本地 shell 就废。两个架构必须各自在对应架构的 runner 上装依赖再打包。

> runner 标签也是查过的：`macos-13`（Intel）**2025-12-04 已下线**，标准 runner 的 Intel 替代是
> `macos-15-intel`；`macos-latest`/`macos-15` 是 arm64。

### 已经就绪、不用重做的部分

| 位置 | 现状 |
| --- | --- |
| `src/main/index.ts:119` | `app.on('activate')`：Dock 点击重开窗口 |
| `src/main/index.ts:126-129` | `window-all-closed` 里 `if (process.platform !== 'darwin') app.quit()` |
| `src/main/ssh/KnownHosts.ts` | `homedir()` + `.ssh/known_hosts`，写盘 `0o600` |
| `src/main/ipc.ts` | `app:info` 返回 `platform`；`safeStorage` 在 mac 走 Keychain |
| `src/main/sessions/SshShellBackend.ts:132` | 优先 `SSH_AUTH_SOCK`（Windows 才回退 pageant） |

## 3. 本轮踩到/避开的坑（下一轮别重踩）

- **`role:'quit'` 不能直接用**：它直接 `app.quit()`，而退出确认挂在窗口 `close` 上 ——
  用户点"取消"时，`before-quit` 里已经把会话全拆了。所以退出项是自定义项（走渲染端确认），
  且 `before-quit` 只在 `isQuitting()` 为真时才拆会话。
- **`Cmd+W` 不能被菜单占**：`role:'close'` 默认就是 `Cmd+W`，会和应用自己的"关闭窗格"抢。
  菜单里给它显式 `accelerator: 'Command+Shift+W'`。
- **`system_profiler` 的 JSON 解析不能只认一层**：第一版只遍历数组和 `_items`，结果是**空表**
  ——探针当场抓住（顶层对象 `SPFontsDataType` 这个键没被走）。现在遍历文档里所有 `_name`。
- **探针不许用反引号**：`scripts/checkprobes.cjs` 按反引号计数判断模板字面量边界，
  注释里多一个就会让整个探针"解析失败"。`smoke/mac.cjs` 全程用单引号拼字符串。
- **本机的 `npm run build` / `verify` 需要在非受限沙箱下跑**：esbuild 起服务进程用管道 stdio，
  受限沙箱下是 `spawn EPERM`（`check:probes` 的 `spawnSync` 同理）。这不是项目问题。

## 4. 探针（`npm run smoke:mac`，已挂进 `verify`）

`smoke/mac.cjs` 共 72 条断言，**在 v2.0.0 的实现上必然失败**（那些函数/分支当时都不存在）：

- `chooseShell('darwin', …)`：选 zsh、`args` 为空且不含 `-NoLogo`、补 `TERM`/`LANG`/Homebrew PATH、
  已有值不覆盖、`$SHELL` 不存在时回退；Windows 分支（`%COMSPEC%`、`-NoLogo`、不注入 env）逐条不变；
- `defaultBindings('darwin')`：`Cmd+W` = 关闭窗格、一个 `Ctrl+` 都不剩、条数与基础表一致；
  `defaultBindings('win32')` 与 `DEFAULT_KEYBINDINGS` **完全相等**；
- `migrateBindingKeys`：mac 上旧 `Ctrl+W`/`Ctrl+T` → `Meta+…`；用户自设的 `Ctrl+Shift+T` 不动；
  Windows 上 `Ctrl+W` → 空（v1.13.0 的决定保留）；
- `menuTemplateFor`：`win32`/`linux` 返回 `null`；darwin 有 6 个 Edit role、不占 `Cmd+W`、
  关窗在 `Cmd+Shift+W`、退出项会调 `askQuit`、并且 `Menu.buildFromTemplate` 真能建起来；
- 字体：`parseMacFontFamilies` 用 fixture 断言（含去重、去空白、坏 JSON、嵌套）；
  `defaultFontFamily('win32')` 与旧串**逐字相等**；
- 打包：`package.json` 的 mac target（dmg+zip、arm64+x64、无 universal）、`dist:mac`、
  zipdist 在 darwin/linux 上拒绝、CI workflow 的 runner 与 `npm ci`。

在**真的 macOS** 上跑同一个探针时（CI 或你自己的 Mac），最后一段会换成真实平台断言
（真 `$SHELL`、真 `system_profiler` 字体枚举）；在 Windows 上这条会**显式写成 SKIP**，不假装通过。

## 5. 需要在 Mac 上做的（见 §9）

代码先行、真机验收后补。唯一无法在 Windows 上判对错的是：**PTY 真起不起得来**、
**system_profiler 真输出的形状**、**Gatekeeper 与钥匙串的真实行为**、**串口设备枚举**。

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
npm run dist:mac        # dmg + zip，arm64 与 x64
npm run dist:mac -- --arm64    # 只打一个架构（CI 就是这么调的）
```

---

## 9. Mac 验收清单（拿到 Mac 后照着做，逐条打勾）

> 前置：macOS 上装 Node 20+ 与 Xcode 命令行工具（`xcode-select --install`）。

### 9.1 从 CI 拿产物（最快的一条路）

1. 打开 `https://github.com/lblacklewis/termdeck/actions`，选 **mac** workflow，
   最近一次 `release/v2.1.0` 的 run；
2. 下载 `TermDeck-mac-arm64` 与 `TermDeck-mac-x64` 两个 artifact（各含 dmg + zip）；
3. 校验：`shasum -a 256 TermDeck-2.1.0-arm64.dmg`，与发布页的 `SHA256SUMS-2.1.0.txt` 核对；
4. 装：

   ```bash
   hdiutil attach TermDeck-2.1.0-arm64.dmg        # 或直接双击
   cp -R /Volumes/TermDeck/TermDeck.app /Applications/
   xattr -dr com.apple.quarantine /Applications/TermDeck.app   # 未签名，解除隔离
   open /Applications/TermDeck.app
   ```

   - [ ] **双击**会提示"无法验证开发者"；**右键 → 打开**能进去（这条要亲眼看一遍）
   - [ ] `xattr -dr` 之后可以正常双击
   - [ ] 应用能起、窗口正常、标题栏是标准样式（这一批没做 hiddenInset）
   - [ ] `Cmd+Q` 会先弹退出确认；点"取消"后**窗格和会话都还在**（这是 before-quit 门控那条）
   - [ ] 关掉所有窗口后应用不退出；点 Dock 图标能重新开窗

### 9.2 从源码跑（要改代码时）

```bash
git clone git@github.com:lblacklewis/termdeck.git && cd termdeck
git switch release/v2.1.0
npm install
node -e "require('@lydell/node-pty'); console.log('pty ok')"      # 不报错才算过
node -e "require('serialport'); console.log('serial ok')"
rm -rf node_modules/.smoke-data && npm run verify                  # 期望 0 条 FAIL
npm run smoke:mac                                                  # mac 分支的真机断言
```

- [ ] `npm run verify` 全绿（有失败先判断：真 bug，还是探针写死了 Windows —— 本地 shell / 串口 /
      字体这三类最可能；**不许靠放宽断言"修好"**）
- [ ] `npm run smoke:mac` 全绿，尤其是最后几条真实平台断言（`$SHELL`、字体枚举 > 20 个族名）
- [ ] 如果 `@lydell/node-pty` 装不上（没有预编译、又编不过），换回官方 `node-pty` 并记录原因

### 9.3 开发版人工过一遍（`npm run dev`）

- [ ] 开本地 shell：起的是 **zsh**、提示符正常；`which brew`、`ls /opt/homebrew/bin` 找得到
- [ ] 设置里的输入框：`Cmd+C` / `Cmd+V` / `Cmd+A` / `Cmd+Z` 可用（**Edit 菜单 role 生效**）
- [ ] 终端里 `Cmd+W` 关掉当前窗格；`Cmd+Shift+W` 关窗口（会先问一句）
- [ ] 终端里按 `Ctrl+W`：**删掉光标前一个词**、不关窗格（v1.13.0 的决定在 mac 同样成立）
- [ ] 字体不是方块、中文能显示；设置 → 终端里的字体下拉里有真实装了的面（SF Mono / Menlo / …）
- [ ] 钥匙串：连一次带密码的主机，重启应用后密码还在；把 app 移到别处再试一次
      （未签名/被移动时 `safeStorage` 可能取不回密文，这是要写进发布说明的行为）
- [ ] 串口页能列出 `/dev/cu.*` 设备
- [ ] 全屏（`F11`）能进能出；mac 上系统也可能吃掉 `F11`，若不行就在设置里改成 `Ctrl+Cmd+F`

### 9.4 打包版自检（照 Windows 的 `.packcheck-*.cjs` 套路）

```bash
/Applications/TermDeck.app/Contents/MacOS/TermDeck \
  --remote-debugging-port=9360 --user-data-dir=/tmp/td-check
```

用 CDP 断言：版本号显示 2.1.0、能开出一个本地 shell、菜单快捷键生效（`Cmd+T` 开新建连接）。

- [ ] 版本号正确
- [ ] 打包版能起本地 shell（**这条才是 `npmRebuild: false` 与原生模块的真验收**）
- [ ] 打包版能连 SSH

### 9.5 记录结论

哪些过了、哪些挂了（带日志与截图），下一轮照着修；**别用"看起来没问题"结案**。

---

## 10. 顺带记下的、下一批可以做的 mac 小事

- 界面里还有写死 `Ctrl+…` 的提示文案：`DrawerFooter` 底部"新建连接"的 `title`
  （`app.new_connection_ctrl_t`）、重连说明段落里的 `Ctrl+R`（`settingsdialog` 与 zh 词表）。
  mac 上应为 `Cmd+…`。要改得一起动词表（`check:i18n` 会因为"词表里没被用到"而失败）。
- `toggleFocus`（F11）在 mac 上没换成 `Ctrl+Cmd+F`，先保持原样。
- 窗口外观没做 `hiddenInset`（用户这次明确说保持标准标题栏）。
- 签名与公证：需要 Apple 开发者账号（$99/年）+ `notarytool`。这一批不做。
  arm64 上如果 ad-hoc 签名都没有、装完起不来，第一步先 `codesign --force --deep -s - TermDeck.app`
  试一次，再决定要不要走正式签名。
