# 交接：换到 Mac 之后从这里接手

> **这份文档的用途**：开发机从 Windows（`D:\project\dsh-workspace\termdeck`）换成 Mac，
> 你要在新机器上把仓库跑起来、继续 macOS 适配与验收、并从这里发版。
>
> 三份文档的分工，别混：
>
> | 文档 | 什么时候看 |
> | --- | --- |
> | **本文** | 换机第一天：装环境、跑闸门、知道什么能在 Mac 上做什么 |
> | `docs/交接-下一批需求.md` | 工程细节与铁律的**唯一事实来源**（现状、铁律、待办、按批次的历史） |
> | `docs/交接-macOS适配.md` | macOS 适配**逐条清单**（§9 是真机验收，§10 是已知的 mac 小事） |
>
> 本文最初写于 **v2.6.0 发版时**（Windows 上），已按 **v2.6.1**（换到 Mac 之后发的一版）更新；
> Mac 上第一次打开请先跑一遍 §2 的三条命令确认基线。

## 1. 一句话现状

- 仓库：`github.com:lblacklewis/termdeck.git`（GitHub 私有/公开以仓库实际为准），默认分支 `master`。
- 版本：**v2.6.1** —— 两处 macOS 修复：macOS 26 上字体族名解析（设置里的字体下拉不再显示 `.ttf` 文件名）、
  mac 打包配置锁死架构（命令行的 `--arm64` / `--x64` 被顶掉）。界面与功能与 v2.6.0 一致。
- 上一版 v2.6.0（REST 工具页整体重做：集合树 / 环境变量 / 四个请求分页 / 响应 Cookie / cURL 导入，
  外加三处终端修复）；再上一版 v2.5.0（后台窗格活动标识 + 两处高亮修复）。
- 闸门：Windows 上的口径停在 v2.6.0 发版那一次 —— **原版 `npm run verify`（56 个套件）与
  `verify:fast`（56 步）都全绿**。**Mac 上整套闸门目前跑不绿**（56 步 **30 过 / 25 挂**，
  `smoke:deps` 跳过；三类原因见 §7、§8），Mac 上能当依据的是 `npm run smoke:mac`（102 条）
  与打包版自检（见 §2、§7）。
- 产物：Windows 三件（Setup / 单文件 / 便携 zip）在 Windows 机器上打，**2.6.1 的三件还没产出**
  （Mac 上打不了，原因见 §8）。mac 侧的 arm64 已在本机打出 `TermDeck-2.6.1-arm64.dmg` + `.zip`
  + `SHA256SUMS-2.6.1-mac-arm64.txt`；Intel 那份等 CI（`.github/workflows/mac.yml` 的
  `macos-15-intel` runner）—— 配置里锁死架构、runner 打错架构的老问题已在 v2.6.1 修掉（见 §4）。

## 2. 在 Mac 上把仓库跑起来（先做这三步）

```bash
git clone git@github.com:lblacklewis/termdeck.git ~/projects/termdeck
cd ~/projects/termdeck
git switch master

npm ci                              # 有 package-lock.json，用 ci 而不是 install
node -e "require('@lydell/node-pty'); console.log('pty ok')"     # 不报错才算过
node -e "require('serialport'); console.log('serial ok')"

rm -rf node_modules/.smoke-data && npm run verify      # 期望「0 条 FAIL」+ 退出码 0，但这台 Mac 上会停在 smoke:deps（见 §3 / §7）
npm run smoke:mac                                      # mac 分支的真机断言（102 条；Windows / Linux 口径 100 条）
```

- Node：Windows 开发机上是 **v24**；Mac 上 20 / 22 / 24 都可以，`npm ci` 能装完就行。
- **`@lydell/node-pty` 是按平台+架构分的可选依赖**（`-darwin-arm64` / `-darwin-x64`），
  `npm ci` 只会装当前架构那一个 —— 这是"两个 runner 分别打包"的原因（见 §3）。
  如果它在你机器上装不上，见 §5 的降级方案。
- `npm run smoke:mac` 是本地的 mac 分支断言；它**不是**真机验收的全部（§5 才是）。
- 跑打包版相关的断言前先 `env -u ELECTRON_RUN_AS_NODE npm run smoke:mac`：环境里若带
  `ELECTRON_RUN_AS_NODE=1`，打包版会以纯 Node 模式启动，报 `bad option: --remote-debugging-port=…`。

## 3. Mac 上能做 / 不能做

| 能在 Mac 上做完 | 只能在 Windows 或 CI 做 |
| --- | --- |
| 改代码、`npm run build` / `typecheck` / `check:*`、`npm run smoke:mac`（102 条）与单个 `smoke:*` 套件 | **整套闸门** `npm run verify` / `verify:fast` —— 现在写死了 Windows 前提，mac 上跑不起来 / 跑不完（§7） |
| `npm run dev` 手工过界面与键位 | **Windows 三件产物**（NSIS 安装版）—— 要留在那台 Windows 机器上打 |
| `npm run dist:mac -- --arm64`（本机打 dmg + zip，`hdiutil` 在 Mac 上） | 需要 mac 的 `hdiutil` 才能打的 dmg |
| 键位表、菜单、字体、本地 shell、串口、钥匙串的真机验收 | 代码签名 / 公证（要 Apple 开发者账号 $99/年） |

发版时如果两台机器都在手边：**Mac 上跑 `smoke:mac` + 真机验收 + 打 mac 产物，Windows 上跑整套闸门
+ 打 Windows 产物**，两边的 SHA256 各自记进 `SHA256SUMS-<版本>.txt` 与 `SHA256SUMS-<版本>-mac-<arch>.txt`。

## 4. macOS 适配已经做了什么（不用重做）

细节在 `docs/交接-macOS适配.md` §2，一句话版：

- **本地 shell**：`chooseShell()` 按 `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh` 挑真实存在的那个，
  环境补 `TERM`/`LANG`/`PATH`（含 `/opt/homebrew/bin`）；
- **应用菜单**：darwin 建 App / Edit / Window 三菜单，Edit 的 role 是 `Cmd+C/V/X/A/Z` 的唯一来源；
- **键位**：`MAC_BINDING_DEFAULTS`（v2.2.0 起照 iTerm2 / Terminal.app 逐条定过，不是机械把 Ctrl 换 Cmd）：
  `Cmd+C/V` 复制粘贴、`Ctrl+Cmd+F` 全屏、`Cmd+Shift+]`/`[` 换标签、`Cmd+Alt+←/→` 换会话、
  `Cmd+数字` 跳会话、`Cmd+W` 关当前窗格、设置与退出交给应用菜单；
- **习惯差异只在 darwin 生效**：选中不自动复制、无中键粘贴、输入框里的 `Cmd+C/V` 交回系统、
  界面上显示 `Cmd+…` 而不是 `Meta+…`；
- **字体**：darwin 读 `system_profiler SPFontsDataType -json`（解析器是纯函数，有 fixture 断言）；
  v2.6.1 起优先取 `typefaces[].family`（macOS 26 的顶层 `_name` 是字体文件名），回退 `_name` 并过滤文件名；
- **打包**：`build.mac`（dmg + zip，架构交给命令行 / runner，配置里不锁死）、`dist:mac`、
  `scripts/zipdist.cjs` 平台化；
- **CI**：`.github/workflows/mac.yml`，`macos-15`（arm64）与 `macos-15-intel`（x64）两个 runner。

## 5. 真机验收清单（v2.6.1 版，还没打勾）

`docs/交接-macOS适配.md` **§9** 是按 v2.2.0 写的，机械照做仍然有效（键位、菜单、钥匙串、串口、
打包版自检那几块都没变）。**除了那些，下面这些是 v2.3.0–v2.6.1 新增的、要在 Mac 上确认的点**：

### 5.1 安装与启动（照详档 §9.1）

- [ ] 双击 dmg 安装 → 右键「打开」能过 Gatekeeper → `xattr -dr com.apple.quarantine` 后能正常双击
- [ ] `Cmd+Q` 先弹退出确认，点取消后**窗格与会话都还在**；关掉所有窗口应用不退，点 Dock 图标能重开
- [ ] 菜单栏三个菜单、App 菜单里的 Settings… / Quit 都在

### 5.2 终端行为（v2.5.0 / v2.6.0 的改动）

- [ ] **点标签切窗格之后直接能打字**（v2.6.0 修的：以前鼠标点完还要再点一下终端）
- [ ] **点一下标签再按 Delete / Backspace：不会关掉会话**（v2.6.0 修的），
      键字进了终端；真要关会话用标签上的关闭按钮
- [ ] 多窗格时，后台窗格有新输出 → **标签头与会话行出现提示点**，切过去就消失（v2.5.0）
- [ ] 输出里有 IPv6 / MAC / 长硬件地址 → **整段高亮**；**远端本来带颜色的输出不被覆盖**（v2.5.0 / 2.6.0）
- [ ] `Ctrl+W` 在终端里删词、不关窗格；`Cmd+W` 关窗格、`Cmd+Shift+W` 关窗口

### 5.3 工具页（v2.3.0–v2.6.0）

- [ ] **REST 工作台**（v2.6.0）：集合树增删改与移动、环境变量替换、变量缺失时拒发并点名、
      Params 与 URL 双向同步、Body 的表单 / JSON / 文本、Auth 的 Bearer / Basic / API Key、
      响应的 Cookie 分页、**导入 cURL**（随便找个服务的文档命令粘进去）
- [ ] **`~/.ssh/config` 导入**（v2.4.0）：Mac 上路径就是 `~/.ssh/config`，导入后主机、端口、
      用户名、密钥路径、备注都对；`Include` / `Match` 不支持（行为写在发行说明里）
- [ ] **S3 页与端口转发页**：功能可用即可，**这两页现在仍是英文界面**（已知边界）
- [ ] 串口页能列出 `/dev/cu.*`；钥匙串里存的密码重启后还在

### 5.4 打包版自检（照详档 §9.4）

```bash
/Applications/TermDeck.app/Contents/MacOS/TermDeck --remote-debugging-port=9360 --user-data-dir=/tmp/td-check
```

- [ ] 版本号显示 **2.6.1**
- [ ] 打包版能开本地 shell（这条才是 `npmRebuild: false` 与原生模块的真验收）
- [ ] 打包版能连 SSH

### 5.5 设置里的字体下拉（v2.6.1 修的）

- [ ] 打开 设置 → 字体：下拉里是**真族名**（`Times New Roman`、`圆体-繁`…），**不是 `.ttf` 文件名**
      （macOS 26 把文件名放在顶层 `_name`、族名放在 `typefaces[].family`，旧实现读的是前者）

**结论要写下来**（哪条过了、哪条挂了、日志与截图），别用"看起来没问题"结案 ——
下一轮接手的人是照着你的结论改的。

## 6. 从 Mac 上发版

顺序与铁律一致，只是命令换成 mac 版：

```bash
# 1. 版本号
#    package.json 的 version 改成 vX.Y.Z（最近一次是 2.6.0 → 2.6.1；下一个按语义化版本）
# 2. 发行说明：docs/发行说明-vX.Y.Z.md（照上一版的结构：下载表 / 更新内容 / 已知边界 / 校验）
# 3. 发版闸门：Windows 机器上用「原版」而不是 verify:fast（mac 上跑不完，见下方说明）
rm -rf node_modules/.smoke-data && npm run verify      # 要求 0 条 FAIL + 退出码 0
# 4. mac 产物（本机）
npm run dist:mac -- --arm64                            # 只出本机架构的 dmg + zip（另一架构交给 CI 的 runner）
# 5. 校验值
cd release && shasum -a 256 TermDeck-X.Y.Z-*.dmg TermDeck-X.Y.Z-*.zip > SHA256SUMS-X.Y.Z-mac-$(uname -m).txt
# 6. 提交、标签、分支、推送
git add -A && git commit -m "发布: vX.Y.Z"
git tag vX.Y.Z && git branch release/vX.Y.Z
git push origin master && git push origin vX.Y.Z && git push origin release/vX.Y.Z
```

- **标签与分支停在"构建提交"上**（版本号 + 发行说明那一笔），不是后面的文档笔。
- **Windows 三件产物在 Mac 上打不了** —— 要么在那台 Windows 机器上 `npm run dist:win` +
  `npm run pack:zip`，要么以后补一条 Windows CI（证据与原因见 §8）。发行说明里的 Windows 下载表照实写。
- **Mac 上原版 `npm run verify` 现在跑不完**（会停在 `smoke:deps`，见 §7）：本机发版只能拿
  `npm run smoke:mac`（102 条）+ 打包版自检 + `check:probes` / `check:i18n` / `check:s3` /
  `typecheck` 当依据，整套闸门回 Windows 机器补跑。
- 打包前**先退出正在运行的 TermDeck.app**（Windows 上是 `release\win-unpacked` 锁着 app.asar，
  mac 上同理：运行中的 app 会让 `release/` 下的重写失败）。
- GitHub 发布页只能你自己在浏览器里建：`https://github.com/lblacklewis/termdeck/releases/new?tag=vX.Y.Z`。
  **目前还欠 v2.2.0 / v2.3.0 / v2.4.0 / v2.5.0 / v2.6.0 / v2.6.1 六页**（正文都在
  `docs/发行说明-*.md`，产物也在）—— 其中 **v2.6.1 是本次要建的**：正文已备好
  （`docs/发行说明-v2.6.1.md`），产物在本机 `release/`（arm64 的 dmg + zip +
  `SHA256SUMS-2.6.1-mac-arm64.txt`），Intel 那份等 CI。

## 7. 铁律（换成 mac 命令后仍然成立）

| 事 | 做法 |
| --- | --- |
| 验证分级 | 分级口径不变：**日常**定向 `npm run verify:fast -- --only <套件>`、**推 origin 前** `verify:fast` 全量、**发版/打标签前**原版 `npm run verify`（先 `rm -rf node_modules/.smoke-data`，要 0 FAIL 且退出码 0）。但这两条命令**目前只能在 Windows 上跑**：`verify:fast` 在 macOS 上第一步就 `spawn cmd.exe ENOENT`（`scripts/verifyfast.cjs:147` 没有平台判断），原版 `verify` 会停在 `smoke:deps`（它要 `~/.ssh/id_rsa` 与本机 sshd）。**Mac 上诚实的替代**：`npm run build` + 单个 `smoke:<套件>` + `npm run smoke:mac`（102 条）+ `check:probes` / `check:i18n` / `check:s3` / `typecheck`，整套闸门回 Windows 机器补；要平台化见 §8。动了 `src/shared/`、`src/main/store`、preload、ipc、`App.tsx`、i18n 机制的**不许定向跑** |
| 探针 | 每个改动都要有"旧实现必然失败"的断言；探针文件里**一个反引号都别写**（`check:probes` 按反引号判断模板字面量边界，注释里的也算）；换行用 `String.fromCharCode(10)`；改完跑 `npm run check:probes` |
| 提交 | 中文，前缀 `修复:` / `新增:` / `改进:` / `文档:` / `发布:`；一次功能一个提交，文档与版本号单独一笔 |
| 产物 | `release/` 已 gitignore；口径是**只留当前版本 + 上一版** |
| 环境 | 长命令别用同步等待等它跑完（工具单次上限 10 分钟）：挂后台，3–5 分钟看一次；把退出码写进日志文件（`echo "EXIT=$?"`），别只看控制台 |
| 换行 | 仓库里**没有 `.gitattributes`**、存的是 LF：Mac 上 clone 出来就是 LF，这是对的。**不要**把 `core.autocrlf` 设成 `true`；如果 `git status` 突然显示全仓库被改，先查这个 |

## 8. 还没做的（接手后可挑）

1. **s3page / tunnelspage 两页仍是英文**：词表里 `s3page.*` 43 条、`tunnelspage.*` 23 条一条都没有，
   另有约 20 条散落的没翻。`npm run check:i18n` 会把它们列在 "note untranslated" 里。
   **做法照第十八批**：光补词表不算翻完 —— 共享数据、主进程文案、硬编码兜底要各自想办法。
2. **GitHub 发布页**六页（v2.2.0–v2.6.1，见 §6）。
3. **`release/` 清理**：Windows 那边攒了十代产物，按口径该清到只留当前版本 + 上一版。
4. **macOS 真机验收**：§5 的清单。
5. **`交接-macOS适配.md` §10 的 mac 小事**：终端右键菜单（Copy / Paste / Select All）、
   `Cmd+K` 清缓冲区、`hiddenInset` 标题栏（用户明确要标准标题栏，别自作主张改）、正式签名与公证。
6. **候选新需求**（用户还没点头，别一次全做）：见 `交接-下一批需求.md` 的待办一节。
7. **Windows 产物在这台 Mac 上打不了**：`node_modules/@lydell/` 下只有 `node-pty` 与
   `node-pty-darwin-arm64`（**没有 win32 的 node-pty**），`cpu-features` 与 `sshcrypto` 是 arm64
   Mach-O，`scripts/zipdist.cjs` 明确拒绝非 win32（`pack:zip` 三件里的便携 zip 因此产不出）。
   v2.6.1 的 Windows 三件要么回那台 Windows 机器上 `npm run dist:win` + `npm run pack:zip`，
   要么补一条 windows CI（照 `.github/workflows/mac.yml` 的形状写）。
8. **整套闸门在 mac 上的平台化**：① `scripts/verifyfast.cjs:147` 无平台判断地 `spawn('cmd.exe', ...)`，
   mac 上第一步就 `spawn cmd.exe ENOENT`；② 探针把 Windows 写法写死了 —— `smoke/activity.cjs`、
   `smoke/highlight.cjs`、`smoke/restcore.cjs` 硬编码 `D:\project\dsh-workspace\termdeck`（`src/` 里
   没有这种硬编码），断言层面 `smoke:keys` 期望 `closeSession` 不带 `Ctrl+W`、`smoke:nav` 按 `Alt+N`、
   `smoke:wellbeing` 按 `Ctrl+Alt+L`、`smoke:features` 期望 `copyOnSelect=true`、`smoke:features3` 按
   `Ctrl+D` / `Ctrl+=`（mac 上按设计是 `Meta+W` / `Cmd+N` / 选中不自动复制）；③ 原版 `verify` 卡在
   `smoke:deps`（这台机器只有 `id_ed25519`、22 端口是关的），连带 `smoke:ssh / ui / regress / ui2 /
   features2 / duplicate / reconnect / transport / tunnel / drawer / layout / quit` 一批挂在同一个
   前提上。另有 `smoke:memory` 一条负载敏感的阈值抖动。

## 9. 常用命令速查

```bash
npm run dev              # 开发模式（改代码时用这个）
npm run build            # 只构建（探针脚本自己会调它）
npm run typecheck        # tsc 两个工程
npm run verify           # 原版全量闸门（发版前）—— 目前只能在 Windows 上跑（见 §7）
npm run verify:fast      # 单次构建 + 全量套件（推 origin 前）—— 同上，macOS 上跑不起来
npm run verify:fast -- --only rest      # 只跑某个套件（日常）—— 同上；mac 上改用 npm run build + npm run smoke:<套件>
npm run smoke:mac        # mac 分支的真机断言（102 条；前面加 env -u ELECTRON_RUN_AS_NODE）
npm run smoke:rest       # REST 工作台真界面（148 条）
npm run smoke:restcore   # REST 纯函数 + 存储迁移（58 条）
npm run check:probes     # 探针文件本身的规则检查
npm run check:i18n       # 词表一致性（未使用键 = FAIL）
npm run dist:mac         # 本机打 mac 产物（架构给命令行：--arm64 / --x64）
npm run dist:win         # 只能在 Windows 上跑
```

## 10. 交接时（v2.6.1）的确切状态

- `master` 最新提交 = **发布 v2.6.1 的构建提交**（版本号 + 发行说明），标签 `v2.6.1` + 分支
  `release/v2.6.1` 都停在同一个提交上；**目前只在本地提交，还没推送**（后面的文档提交不移动标签）。
- Mac 上能跑的验证（v2.6.1 本机实测，macOS 26.6.2 / arm64 / Node 24.14.0）：`npm run smoke:mac`
  **102/102、EXIT=0**；`check:probes` / `check:i18n` / `check:s3` / `typecheck` 全过；用 CDP 驱动
  **打包版**自检 **7/7**（版本 2.6.1、platform darwin、`localShellAvailable=true`、开得出本地 shell，
  且那个 shell 真的执行了命令写出 `TD_PTY_OK_42`）。
- **整套闸门在 Mac 上跑不绿**：56 步 **30 过 / 25 挂**（`smoke:deps` 跳过），三类原因见 §7、§8；
  Windows 上「全绿」的口径停在 v2.6.0 发版那一次（原版 `npm run verify` 56 个套件 + `verify:fast`
  56 步，都 0 条 FAIL）。
- 产物：本机打出 `release/TermDeck-2.6.1-arm64.dmg` + `.zip` + `SHA256SUMS-2.6.1-mac-arm64.txt`
  （`release/` 已 gitignore，不会跟着仓库走）；Intel 那份等 CI；**Windows 三件 2.6.1 还没产出**
  （Mac 上打不了，见 §8）。
- 本文件与 `docs/发行说明-v2.6.1.md`、`docs/交接-下一批需求.md` 的第三十五批小节是同一次会话写的，
  三处内容互相引用，改动时保持同步。
