# TermDeck

A Termius-style SSH client for the desktop. Its defining feature is that every
session lives in a **dockable pane**: drag a tab to a pane edge to split, drag it
onto another pane's centre to stack tabs into a group, and rearrange everything
with the sashes.

This is a from-scratch application, not a fork. It exists because WindTerm's
public repository is only *partially* open source — its window, session and
layout layers were never released — so the docking behaviour had to be built
rather than patched into it.

## Status

Working end-to-end: SSH (password / private key / agent), local shells, xterm
rendering, and drag-to-split / drag-to-group docking.

| Area | State |
| --- | --- |
| SSH sessions (`ssh2`) | ✅ password, private key, passphrase, agent, keyboard-interactive |
| Local shells (ConPTY / PTY) | ✅ via `@lydell/node-pty` |
| Terminal | ✅ xterm.js, configurable font/cursor/scrollback, auto-fit on resize/show |
| Docking | ✅ drag to edge = split, drag to centre = tab group, floating groups |
| Host key verification | ✅ `known_hosts`, hashed entries, change/mismatch warning |
| Credentials | ✅ saved per session, AES-256-GCM at rest, prompt with "remember" on connect |
| Appearance | ✅ 11 themes with live preview, 80–150% interface scale, audited contrast |
| Shell | ✅ navigation rail → list column → main area, with right-hand drawers |
| Known Hosts | ✅ browse every stored key and forget one |
| Saved sessions | ✅ multi-level folders, tags, filtering, drag-to-move, per-session auth |
| Settings page | ✅ appearance, terminal, clipboard, shortcuts, host keys, credentials |
| Clipboard | ✅ copy-on-select, right-click / middle-click paste, multi-line paste guard |
| Context menus | ✅ right-click a session, a folder or empty space in the tree |
| Connections window | ✅ every open connection with Focus / Close |
| Snippet bar | ✅ save, group, edit, duplicate and send commands verbatim |
| `~/.ssh/config` import | ⬜ not yet |
| SFTP, port forwarding | ⬜ not yet |

## How credentials are stored

Connecting to a saved session that has no password asks for one in place, with a
**Save this password** box ticked by default — there is no need to open the editor
just to add a credential. There is no master password and no unlock step.

- Each field is sealed with **AES-256-GCM**; the key comes from Electron's
  `safeStorage`, which is backed by the OS keychain (DPAPI on Windows, Keychain
  on macOS, libsecret on Linux).
- If a platform exposes no keychain, the app falls back to a randomly generated
  seed file with owner-only permissions. Settings → Credentials states which
  backend is in use, because the two have different threat models.
- Secrets live in `credentials.json`, separate from the session tree, and are
  **never sent to the renderer**: the tree carries only `hasPassword` booleans.
  The session editor's "Show" button performs an explicit, per-session reveal.
- A tampered ciphertext fails its authentication tag and reads as absent rather
  than decrypting to garbage.

### Shell layout

Two columns, one of which can shrink to icons:

```
┌──────┬────────────────┬──────────────────────────────┐
│ rail │ list column    │ main area                    │
│      │ (the rail's    │                              │
│ Term │  drawer)       │ dockview: the terminal page  │
│ Hosts│                │ (splits, tab groups)         │
│ Keys │ Sessions tree  │                              │
│ …    │ or the page    │                              │
│ ◦    │ for the rail   │                              │
└──────┴────────────────┴──────────────────────────────┘
        └ snippet bar (terminal page only) ┘
```

The rail and its list are **one column, not two**: they share a background, the
edge is drawn once (by whichever is last), and the drawer sits against the rail
with a soft inner shadow rather than a hairline between them. A border on both
made the pair read as two unrelated panels, which is exactly how it looked.

The rail switches what the drawer shows: **Terminal** (the dockview workspace),
**Hosts**, **Known Hosts**, **Snippets** and **Logs**. Settings is a drawer rather
than a page, since it has no list of its own.

**Clicking the section you are already on toggles the drawer**, and so does the
small switch at the rail's bottom-left: the drawer collapses away entirely and
the rail keeps its icons, so the same control both hides and shows the list.
`Ctrl+B` does the same thing, and the state is remembered. Picking a *different*
section always brings the drawer back, because that is what was asked for.

Editing flows open as **drawers** sliding in from the right — the session
editor, quick connect, snippet editor, settings and the connections window — so
the list you were working in stays visible. They close on Escape, the close
button, or a click on the backdrop.

Collapsing hands the terminal the drawer's width — about 30 extra columns at a
typical window size.

**Known Hosts** lists every stored key with its fingerprint and lets you forget
one. That is the fix for the case that bites people: a rebuilt (or impersonated)
host no longer matches, and the only way forward used to be editing
`~/.ssh/known_hosts` by hand. Hashed entries are listed as such, because the
hostname genuinely cannot be recovered from them.

## Layout persistence

The window reopens the way you left it: pane splits and tab groups, which rail
section was showing, whether the rail was shrunk, and whether the snippet bar was
visible. The arrangement is written to `layout.json` in the app's user-data
directory.

An older file that predates the rail/drawer merge is still understood: the
retired `sidebarVisible` / `sidebarCollapsed` pair is read as "whether the rail
was collapsed", so upgrading does not silently reopen a sidebar you had hidden.

**Sessions are deliberately not reconnected.** A restored pane comes back as a
placeholder with a **Reconnect** button, because silently spawning local shells
or opening SSH connections on launch would be a surprise — and the local-shell
case would leak processes. If the saved session has since been deleted, the pane
says so instead of failing quietly.

## Appearance

**Interface scale.** Settings → Appearance → *Interface scale* offers 80% to
150%. It is applied with `webContents.setZoomFactor`, so the rail, sidebar,
dialogs, spacing and the terminal font all grow together instead of only the
text. Picking one previews it immediately and the hint says it is a preview;
closing the drawer by **any** route (Close, the header ✕, the backdrop, Escape)
puts the stored value back, and only *Save settings* keeps it.

Electron resets the zoom on every reload, so the value is stored in
`settings.json` and applied by the **main process** before the window is first
shown. The renderer deliberately does *not* re-send it on its first render:
`setZoomFactor` updates zoom asynchronously, so a push landing inside the first
layout pass made dockview re-measure mid-resize and cache a 100×100 placeholder
as the size of its grid — every pane collapsed to about 65px with a blank
terminal, while the buffer still held the shell's output.

That failure mode has a second half worth knowing. A zoom change does **not**
alter the container's CSS size, so the `ResizeObserver` watching it stays silent
while dockview's grid is left at the placeholder — nothing in the app notices
zoom moved. So every scale change (including the drawer's live preview, which is
why the preview is applied through the shell rather than the dialog) re-asserts
the layout once the zoom has landed. `smoke:repeat` alternates the plain launch
with a mid-run scale change so neither path can regress quietly.

On a first run the default follows the display: 100% up to 1800 logical pixels
wide, 105% to 2200, and 115% above that — a 2560px desktop monitor makes the
same 13px text look miniature next to a laptop panel. It uses *logical* width,
so an OS-level 200% scale on a 4K panel is already accounted for. As soon as the
user picks a value it is stored and used from then on.

The initial **window size** likewise comes from the primary display's work area
(82% of its width, 86% of its height, clamped to 1100–1900 × 700–1300) rather
than a fixed 1440×900, which was cramped on a large monitor and oversized on a
laptop panel.

**Fonts.** Settings → Terminal → *Font family* lists the monospaced fonts
actually installed on this machine, read from the platform. Clicking a chip
applies it, the field stays free-text, and a live preview shows the choice
before it is saved. Choosing a family rebuilds the fallback stack rather than
replacing it, so a font missing a glyph still falls back correctly.

**Cursor.** The blink rate is selectable (or off). This is ours rather than
xterm's because xterm toggles its blink class on an internal tick and ships no
CSS for it, which reads as a flicker; the pane animates it from the setting
instead. `prefers-reduced-motion` turns blinking off entirely.

## Broadcast input

With several panes open, the `⇶` button in the sidebar footer sends every
keystroke to **all** open sessions at once — for running the same command across
a set of hosts. `Ctrl+Shift+B` toggles it.

The button fills with the accent colour while it is on, deliberately: typing
into several hosts at once is not something to be unsure about. The pane you type
in receives each character exactly once.

## Pane tabs

Right-click a pane tab for: **copy tab name**, **copy all output**, **save
output to file**, **close**, **close other tabs**, **close tabs to the right**
and **close all tabs**. Actions that make no sense in the current position are
disabled rather than hidden — "close to the right" is disabled on the last tab.

Copy and save read the **whole scrollback**, not just what is on screen, and
strip ANSI escape codes, so a saved file is plain readable text.

## Timestamps

A timestamp gutter beside each pane is **on by default**; Settings → Terminal →
*Show a timestamp column beside each pane* turns it off. Each line is stamped as
it arrives, in the bracketed `[HH:MM:SS]` form the reference client (WindTerm)
uses, and the format never changes width.

The gutter is drawn as an overlay aligned to xterm's own measured row height
rather than written into the buffer, so it can never end up inside a selection or
in copied/saved output. Times are not persisted, because scrollback is not
either.

Its width is **measured from a rendered stamp**, not derived from an `em`
multiple, and the stamps are recorded from xterm's `onWriteParsed` rather than
straight after `write()`. Both were wrong in ways that produced the same
symptom — a full-height gutter with nothing in it, or a stamp with its closing
bracket cut off — and neither showed up as anything but "the gutter exists".
`smoke:chrome` now asserts that written lines carry a complete, unclipped stamp.

The gutter carries no border and no panel background, and sits at 72% opacity, so
it reads as part of the terminal rather than as a boxed sidebar beside it.
Right-click a pane tab to show or hide it — the choice saves immediately.

## Quick connect

Connections made from the quick-connect drawer are **saved automatically** into
Sessions as an unfiled entry, with the password you typed going into the same
encrypted vault as any other session. Reconnecting to a host that is already
saved does not create a duplicate.

On first contact the host-key prompt still appears, showing the fingerprint and
offering to remember it. That decision is per host, not per session.

## Snippets

A snippet is sent to the terminal **exactly as written**. Nothing is appended —
whether the shell runs it depends on whether your text ends with a line break:

| Stored command | What happens when you click it |
| --- | --- |
| `whoami` | typed into the prompt, not run |
| `whoami` + Enter in the editor | run, because of that line break |

Use `\r\n` as the terminator: a bare `\n` is accepted by the terminal but does
not submit a line in `cmd.exe`. The editor states which case the command is in,
so the behaviour is visible before you save it.

In the snippet bar, **right-click** opens a menu (send, edit, duplicate, move to
Ungrouped, delete) and **left-drag** moves a chip: drop it on another chip to
reorder, or on a group tab to change its group without opening the editor.

The menu is the shared portalled context menu, not an absolutely-positioned child
of the bar. The bar scrolls horizontally, and a menu drawn inside it was clipped
at the bar's edge — which is what "the display is broken" was.

## Reconnecting

A pane that is still on screen but no longer usable — the usual case being an
idle SSH connection the server has timed out — can be recovered from the pane
tab's right-click menu: **Reload / reconnect**. The pane is re-pointed at a fresh
session in place, so its position in the arrangement and its tab title survive.
A pane backed by a saved session reconnects to that session; one with nothing
behind it (a quick connect, or a local shell) gets a new session and the old
process is closed.

## Themes

Themes restyle the application shell and the terminal together. A theme is plain
data (`src/shared/themes.ts`); `useTheme` maps it onto CSS custom properties on
`<html>`, and the terminal palette is passed straight to xterm. Adding a theme
needs no CSS changes.

Two things are derived rather than authored:

- **Semantic surfaces.** `--td-surface`, `--td-elevated` and friends are computed
  from the theme's own background and scheme. They used to fall back to
  hardcoded dark values, which made light themes render dark boxes with dark
  text.
- **Ink on accent.** `readableOn()` picks black or white by comparing contrast
  ratios, because a bright accent like Gruvbox yellow only reaches 1.7:1 against
  white.

Picking a theme previews it immediately; closing the dialog without saving puts
the stored theme back.

Contrast is verified rather than eyeballed: `npm run smoke:contrast` switches
through every theme and fails if any non-decorative text falls below 3:1 against
its effective background. `scripts/tunecontrast.cjs` derives compliant muted-text
colours from each theme's own foreground.


## Security notes

- **Host keys are verified.** A changed key is never accepted automatically,
  even under "trust on first use" — that is precisely the case a
  man-in-the-middle produces. New entries are hashed (`HashKnownHosts` style)
  so the file does not leak which hosts you connect to.
- **Saved credentials are encrypted at rest** (see above) and never cross into
  the renderer. Credentials typed for a one-off connection are not persisted.


## Requirements

- Node.js 20+ (developed against 24)
- No C++ toolchain needed: `ssh2` is pure JS and `@lydell/node-pty` ships
  prebuilt binaries.

## Getting started

```bash
npm install
npm run dev      # hot-reloading development window
```

To run a production build:

```bash
npm run build
npm start        # preview the built bundles
```

## Building a downloadable app

Three commands, in increasing order of convenience for whoever downloads it:

```bash
npm run pack:win    # release/win-unpacked/ — runs by double-clicking TermDeck.exe
npm run pack:zip    # + release/TermDeck-<version>-win-x64-portable.zip (~114 MB)
npm run dist:win    # + an NSIS installer and a single-file portable .exe
```

`pack:zip` builds the unpacked app and zips it with a small script
(`scripts/zipdist.cjs`) so there is no extra dependency. Unzipped, the app is
about 273 MB — mostly the Electron runtime, which is normal.

`dist:win` additionally produces a **Setup .exe** (installer) and a
**portable .exe** (single file, no install). Those two require electron-builder
to download the NSIS toolchain on first run, so they need network access;
`pack:zip` does not.

The app icon is currently Electron's default. To set one, add a 256×256
`build/icon.ico` — electron-builder picks it up automatically.

### Publishing a GitHub release

A release is a tagged snapshot plus files people can download.

1. **Build the artefacts** you want to attach:

   ```bash
   npm run pack:zip      # portable zip
   npm run dist:win      # installer + portable exe
   ```

2. **Make sure the version is right.** `release` uses the `version` field in
   `package.json`; bump it first if this is a new release, and commit that.

3. **Push your commits and a tag:**

   ```bash
   git add -A
   git commit -m "发布: v0.1.0"
   git tag v0.1.0
   git push origin master
   git push origin v0.1.0
   ```

   The tag is what a release hangs off. `v0.1.0` matches the version, which is
   the convention GitHub expects.

4. **Create the release** in the browser:

   - Go to `https://github.com/<you>/termdeck/releases`
   - Click **Draft a new release**
   - **Choose a tag** → pick the `v0.1.0` you just pushed (or create it there)
   - **Release title**: e.g. `TermDeck v0.1.0`
   - **Describe this release** — the notes shown on the release page
   - **Attach binaries** by dragging files into the box, or click
     *Attach binaries by dropping them here*. Add:
     - `release/TermDeck-Setup-0.1.0.exe`
     - `release/TermDeck-0.1.0-x64.exe` (portable)
     - `release/TermDeck-0.1.0-win-x64-portable.zip`
   - Click **Publish release**

   The download URLs then look like
   `https://github.com/<you>/termdeck/releases/download/v0.1.0/TermDeck-Setup-0.1.0.exe`.

   Note that GitHub rejects individual assets over 2 GB; these are ~114 MB, so
   that is a non-issue here.

5. **Later releases** are the same: bump the version, build, commit, tag, push
   the tag, draft a release, attach the files. Tag push does not create a release
   by itself — uploading assets is a separate step.

A Windows SmartScreen warning is expected on first launch for an unsigned build:
the binary has no code-signing certificate, so Windows cannot vouch for the
publisher. "More info → Run anyway" proceeds. Buying a certificate and setting
`CSC_LINK` / `CSC_KEY_PASSWORD` removes the warning.

### If the installer step fails

`electron-builder` may report `Can't open output file` and leave a ~0.2 MB
`TermDeck-Setup-*.exe` behind. This is a transient file-lock, not a
configuration problem. Delete the partial file and build that one target again:

```bash
rm release/TermDeck-Setup-*.exe        # PowerShell: Remove-Item release\TermDeck-Setup-*.exe
npx electron-builder --win nsis --x64
npx electron-builder --win portable --x64
```

`npm run pack:zip` is unaffected and is the most reliable route.

## Verification

The test suites drive the real application inside Electron — real PTYs, real
SSH connections, real DOM — rather than mocking them.

```bash
npm run typecheck       # strict TypeScript, main + renderer
npm run smoke:deps      # node-pty spawn/stream + ssh2 connect/exec
npm run smoke:ssh       # backend emits, buffers and replays shell output
npm run smoke:ui        # built renderer: local shell, SSH via the dialog, split/group
npm run smoke:features  # vault, session tree, host keys, settings, clipboard
npm run smoke:regress   # host-key replace + session drag-and-drop regressions
npm run smoke:ui2       # sidebar connect, context menus, connections window, snippets
npm run smoke:ui3       # saved credentials, themes, live preview, rounded styling
npm run smoke:ui4       # password prompt, sidebar layout, menus and the snippet toggle
npm run smoke:ui5       # navigation rail, pages, drawers, Known Hosts, new themes
npm run smoke:ctxmenu   # context menu geometry inside a drawer
npm run smoke:tabmenu   # pane-tab menu actions
npm run smoke:features2 # timestamp gutter, saving output, auto-saved quick connect
npm run smoke:features3 # font picker, cursor blink, broadcast input
npm run smoke:scale     # interface scale: applies, previsualises, persists, reverts
npm run smoke:snippet   # snippets send verbatim; a line break is what runs them
npm run smoke:layout    # layout persists across a real restart
npm run smoke:repeat    # 6 alternating pane-geometry passes, incl. a scale change
npm run smoke:contrast  # WCAG contrast audit across every theme and page
npm run smoke:screen    # what display geometry and scaling the app is running undernpm run verify          # all of the above
```

A note on the UI probes: several of them run the window with `show: true`. That is
deliberate — Chromium suppresses rendering, and with it computed-style
resolution, for hidden windows, which makes background-colour and visibility
assertions read stale values. Context-menu and theme checks therefore use hit
testing and resolved CSS variables rather than painted pixel values.

## Gotchas worth knowing

These each cost real debugging time; they are recorded so they are not
rediscovered.

- **Anything that must outlive page navigation has to stay mounted.** The
  docking workspace is hidden with CSS rather than unmounted, because
  unmounting disposes the docking component and a session connected from another
  page then creates its pane in a detached container — it appears in the session
  list but never renders.
- **`dockview`'s `toJSON()` result is not structured-cloneable.** It cannot cross
  IPC directly; serialise it to a string first or the save fails silently.
- **`panel.api.updateParameters()` does not notify the content renderer.**
  dockview offers no `onDidParametersChange` on the init params, and
  `IContentRenderer` has no `update` method, so `ReactRenderer.tsx` keeps its own
  registry and the app calls `refreshPanelParams(panelId)`.
- **A transformed ancestor becomes the containing block for `position: fixed`.**
  That is what pushed the first context-menu right-click inside a drawer hundreds
  of pixels off-screen; menus are portalled to `<body>`.
- **Never edit source files with PowerShell.** `Set-Content -Encoding UTF8`
  writes a BOM (which broke `package.json` outright) and corrupts non-ASCII text.
  Use the editor tools.
- **A pane can end up correct while its terminal stays at the default 80×24.**
  Two independent races produced the same symptom — a terminal painting 456px tall
  inside a 791px pane — and both are worth knowing:

  1. *dockview's grid keeps the size it was constructed with.* Verified in
     isolation: a `DockviewComponent` built while its container is a 100×100
     placeholder keeps its grid pinned there, and the grid carries **inline**
     `width`/`height`, so CSS alone cannot correct it. `dock.layout(w, h, true)`
     releases it, but a `ResizeObserver` alone is not enough — on some runs the
     container reaches its real size with no event reaching the observer at all.
     So the sync polls **real geometry**: it stops the moment dockview's own grid
     matches the container and otherwise gives up after a bounded run of ticks.
     A fixed polling window was not enough either, because it expires while the
     window is still settling — which is what a zoom change causes. The watchdog
     is therefore re-armed after every scale change, since zoom is the one thing
     that can move the container's CSS size without dockview hearing about it.
     dockview's own CSS also omits a height on `.dv-view`, so the pane collapses
     to its content when that inline height is absent; `global.css` states it.

  2. *`FitAddon.fit()` is a silent no-op before the renderer has measured.*
     `proposeDimensions()` returns early when `dimensions.css.cell.height` is 0,
     so calling `fit()` again in that window cannot help — it exits before
     measuring anything. The pane's own height is already correct, which is what
     makes this look like the pane being wrong. `useTerminal` now checks that the
     renderer has reported a cell before fitting, and retries until it has.

  3. *Zoom does not change the container's CSS size.* A `setZoomFactor` change
     leaves `host.clientWidth`/`clientHeight` identical, so the `ResizeObserver`
     watching the container never fires — while dockview's grid is reset to its
     100×100 placeholder. Nothing in the app notices that zoom moved, so every
     scale change re-asserts the layout itself once the zoom has landed, and the
     settings drawer's live preview is applied through the shell rather than
     calling the bridge directly, because only the shell can reach the layout.

  All three are covered by `smoke:repeat`, which alternates a plain launch with a
  mid-run scale change: a fix that passes "sometimes" is not a fix, and single
  runs hid every one of these.

- **A probe reads the pane it means to read, or it grades the wrong one.** Every
  terminal renders identical markup, so `document.querySelector('.xterm-rows')`
  returns whichever pane comes first in DOM order; two suites were reporting a
  healthy neighbouring pane while the pane under test was broken. `useTerminal`
  now stamps `data-terminal-id` on the terminal root and the terminal object is
  reachable as `window.__tdTerminals[sessionId]`, both so a probe can name its
  target.

- **Probes share the real `userData` directory, so they must reset it.** A suite
  that asserts "this store contains exactly what I just created" passes on a fresh
  machine and fails on the second run. `smoke/clearstore.cjs` deletes the store
  files **before** the first `storeAccess()` (the stores are constructed lazily and
  read their file in the constructor); deleting them afterwards would swap the file
  out from under objects the app already holds.

- **A probe must not create states the app cannot reach.** `smoke:scale` used to
  set the zoom factor after the first page load, so the renderer observed a zoom
  change during its own boot — something a real launch never does, because the
  main process applies the stored scale once before the window exists. That
  artificial state pinned dockview's grid, and the probe was then reporting a
  product bug that only its own setup could produce. It now starts from a wiped
  profile and lets the app boot normally.

- **A probe's injected script is a template literal, so escaping is not safe.**
  `\d` written there arrives as a bare letter (a regex that silently matches
  nothing, which looks exactly like the bug it was meant to catch) and a backtick
  inside a comment ends the literal early — a parse error whose only symptom is a
  suite that hangs until it is killed. Probes use character comparisons instead of
  escaped regexes, and `scripts/checkprobes.cjs` parses every probe before the
  suites run so that failure is immediate and named.

- **Inside a template literal, a regex needs double escaping.** `/\[\d{2}/`
  written directly inside an injected script becomes `/[d{2}/` once the template
  is processed, which throws at runtime and surfaces only as "Script failed to
  execute". Use `new RegExp('\\\\[\\\\d{2}')` or a character class.

The UI suites run against a throwaway `--user-data-dir`, so they never touch
your real settings, session tree or vault. `smoke:ssh`, `smoke:ui` and
`smoke:features` connect to a live host; point them elsewhere with
`TD_SSH_HOST`, `TD_SSH_USER` and `TD_SSH_KEY`.

## Architecture

```
src/
  main/                     Electron main process — owns everything privileged
    index.ts                window lifecycle, single-instance lock
    ipc.ts                  the renderer-facing IPC surface
    sessions/
      SessionManager.ts     session registry, event bus, replay buffer
      SshShellBackend.ts    ssh2 client, host-key policy, interactive shell
      LocalShellBackend.ts  node-pty backed local shell
    ssh/KnownHosts.ts       known_hosts parsing, matching and writing
    store/
      Vault.ts              scrypt + AES-256-GCM credential vault
      Stores.ts             settings and saved-session tree (atomic writes)
  preload/index.ts          contextBridge -> window.termdeck
  renderer/src/
    App.tsx                 sidebar + dockview host + shortcut dispatch
    components/
      ReactRenderer.tsx     bridges React into dockview's DOM renderer contract
      TerminalPanel.tsx     one pane: xterm bound to one session
      SessionTree.tsx       multi-level folder tree with tags and drag-to-move
      SessionEditor.tsx     saved-session form (auth, folder, tags)
      ConnectionDialog.tsx  quick-connect form
      SettingsDialog.tsx    terminal / clipboard / shortcuts / host keys / vault
      HostKeyDialog.tsx     fingerprint confirmation and change warning
      ContextMenu.tsx       right-click menu, flipped to stay on screen
      Drawer.tsx            right-hand sliding panel used by every editor
      NavRail.tsx           the section rail (icon + label)
      ModalShell.tsx        shared backdrop; dismisses on click, not mousedown
      HostsPage.tsx         hosted list grouped by folder
      KnownHostsPage.tsx    browse and forget stored host keys
      SnippetsPage.tsx      full-page snippet management
      LogsPage.tsx          session-scoped activity log
      PasswordPrompt.tsx    collect-and-remember a password during connect
      ConnectionsWindow.tsx every open connection with Focus / Close
      SnippetBar.tsx        grouped saved commands, one click to send
      SnippetEditor.tsx     create / edit a snippet and its group
      useTerminal.ts        xterm lifecycle, resize, data flow
      useClipboard.ts       copy-on-select, right/middle-click paste
      useShortcuts.ts       keybinding parsing, matching and recording
      useSettings.ts        per-panel settings subscription
  shared/types.ts           types shared across all three processes
smoke/                      Electron-hosted verification harnesses
```

### Design decisions worth knowing

**The renderer never touches ssh2 or node-pty.** All privileged work happens in
the main process and reaches the UI over IPC with `contextIsolation` on and
`nodeIntegration` off. The preload script exposes one narrow `window.termdeck`
object.

**dockview 7+ has no React binding.** It was split out of the main package, so
`ReactRenderer.tsx` adapts React components to dockview's plain-DOM
`IContentRenderer` contract. That is why the renderer is instantiated by hand
instead of using a `<DockviewReact>` component.

**Panels subscribe to settings instead of receiving them as props.** dockview
builds each pane from a factory that captures its arguments once, so a prop
would freeze at creation time and changing a setting would never affect an
already-open terminal. Terminals call `useSettings()`; the main process
broadcasts `settings:changed` so every window stays in step.

### Output replay

A session starts connecting as soon as it is created, but the panel that will
display it is mounted a moment later — an SSH handshake can produce its banner,
MOTD and first prompt inside that gap. `SessionManager` therefore keeps a rolling
256 KB buffer with a monotonic per-chunk sequence number, and
`useTerminal` requests a replay on mount, discarding any live chunk whose
sequence it has already rendered. Without this, SSH terminals come up blank.

### Host key fingerprints

OpenSSH's `SHA256:` fingerprint is the hash of the canonical
`keytype SP base64(blob)` string, not of the raw key material. `ssh2` hands the
verifier an OpenSSH wire-format blob, so `KnownHosts.parseHostKey` normalises it
before hashing — otherwise every connection would look like a key change.

## Keyboard shortcuts

Defaults; all are re-bindable in Settings → Shortcuts.

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `T` | New connection |
| `Ctrl`/`Cmd` + `W` | Close the active session |
| `Ctrl`/`Cmd` + `,` | Open settings (drawer) |
| `Ctrl`/`Cmd` + `B` | Toggle the sidebar |
| `Ctrl` + `Shift` + `E` | Open the connections drawer |
| `Ctrl` + `Shift` + `S` | Toggle the snippet bar |
| `Ctrl` + `Shift` + `B` | Broadcast input to every pane |
| `Ctrl` + `Shift` + `C` / `V` | Copy / paste |
| `Ctrl` + `Tab` / `Ctrl` + `Shift` + `Tab` | Next / previous tab |
| `Esc` | Close an open drawer |
| Double-click a session | Connect |
| Single-click a session | Select |
| Right-click a session / folder / empty space | Context menu |
| Drag a tab to a pane edge | Split, creating a new pane |
| Drag a tab onto a pane centre | Stack into that pane's tab group |
| Drag a session onto a folder | Move it into that folder |
| Drag a session onto empty tree space | Move it back to the top level |
| Right-click a pane | Paste the clipboard |

## Licence

MIT.
