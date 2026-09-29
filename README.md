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
| Appearance | ✅ 11 themes with live preview, three-column shell, audited contrast |
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

The window is three columns:

```
┌──────┬────────────────┬──────────────────────────────┐
│ rail │ list column    │ main area                    │
│      │                │                              │
│ Term │ Sessions tree  │ dockview: the terminal page  │
│ Hosts│ or the page    │ (splits, tab groups)         │
│ Keys │ for the rail   │                              │
│ …    │ selection      │                              │
└──────┴────────────────┴──────────────────────────────┘
        └ snippet bar (terminal page only) ┘
```

The rail switches which list/main pair is showing: **Terminal** (the dockview
workspace), **Hosts**, **Known Hosts**, **Snippets** and **Logs**. Settings is a
drawer rather than a page, since it has no list of its own.

Editing flows open as **drawers** sliding in from the right — the session
editor, quick connect, snippet editor, settings and the connections window — so
the list you were working in stays visible. They close on Escape, the close
button, or a click on the backdrop.

**Known Hosts** lists every stored key with its fingerprint and lets you forget
one. That is the fix for the case that bites people: a rebuilt (or impersonated)
host no longer matches, and the only way forward used to be editing
`~/.ssh/known_hosts` by hand. Hashed entries are listed as such, because the
hostname genuinely cannot be recovered from them.

## Layout persistence

The window reopens the way you left it: pane splits and tab groups, which rail
section was showing, and whether the sidebar and snippet bar were visible.
The arrangement is written to `layout.json` in the app's user-data directory.

**Sessions are deliberately not reconnected.** A restored pane comes back as a
placeholder with a **Reconnect** button, because silently spawning local shells
or opening SSH connections on launch would be a surprise — and the local-shell
case would leak processes. If the saved session has since been deleted, the pane
says so instead of failing quietly.

## Appearance

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

Settings → Terminal → *Show a timestamp column beside each pane* adds a gutter
showing when each line was written. Times are recorded per line as output
arrives, and lines older than an hour drop the seconds to keep the column
narrow. They are not persisted, because scrollback is not either.

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
npm run smoke:snippet   # snippets send verbatim; a line break is what runs them
npm run smoke:layout    # layout persists across a real restart
npm run smoke:contrast  # WCAG contrast audit across every theme and page
npm run verify          # all of the above
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
