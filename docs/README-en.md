> **中文说明请看 [README.md](../README.md)** — this file is the engineering-facing English README:
> architecture, verification suites, release process and the reasoning behind the decisions.

# TermDeck

A Termius-style SSH client for the desktop. Its defining feature is that every
session lives in a **dockable pane**: drag a tab to a pane edge to split, drag it
onto another pane's centre to stack tabs into a group, and rearrange everything
with the sashes.

This is a from-scratch application, not a fork. It exists because WindTerm's
public repository is only *partially* open source — its window, session and
layout layers were never released — so the docking behaviour had to be built
rather than patched into it.

> User-facing guide (Chinese): **`docs/使用手册.md`** — 面向使用者的功能手册，
> 按「你会怎么用它」组织：连接、终端、命令补全、SFTP、片段、已知主机、搬移配置、
> 外观、快捷键、常见问题。本 README 讲的是实现与取舍。

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
| Appearance | ✅ 13 themes (incl. the light Blossom and Lavender) with live preview, 80–150% interface scale, English + 简体中文, audited contrast |
| Shell | ✅ navigation rail → list column → main area, with right-hand drawers |
| Known Hosts | ✅ browse every stored key with its fingerprint, filter, multi-select and batch-forget |
| Saved sessions | ✅ multi-level folders (each foldable, plus collapse/expand all), tags, filtering, drag-to-move, per-session auth |
| Settings page | ✅ appearance, terminal, clipboard, shortcuts, host keys, credentials |
| Clipboard | ✅ copy-on-select, right-click / middle-click paste, multi-line paste guard |
| Context menus | ✅ right-click a session, a folder or empty space in the tree |
| Connections window | ✅ every open connection with Focus / Close |
| Snippet bar | ✅ save, colour, group, edit, duplicate and send commands verbatim |
| SFTP | ✅ browse, upload/download with several chunks in flight, drag a file onto the panel to upload |
| File transfers | ✅ a strip above the snippet bar while anything moves: progress, speed, ETA, cancel, history |
| Port forwarding | ✅ local tunnels, managed from the rail |
| `~/.ssh/config` import | ⬜ not yet |

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

The switch at the rail's bottom-left collapses the drawer: the list goes away and
the rail keeps its icons, so the same control both hides and shows it. `Ctrl+B`
does the same thing, and the state is remembered. Picking a *different* section
always brings the drawer back, because that is what was asked for.

**Clicking the section you are already on only ever opens it.** It used to toggle,
which is a real pattern (VS Code's activity bar), but the first thing a new user
does after the welcome screen is click "Terminal" to get their bearings — and with
the app already on that page, the column vanished under the pointer and read as
"the left side is gone". Hiding it is still one deliberate gesture away: the
switch, `Ctrl+B`.

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

Rows have checkboxes, so a batch of stale keys goes in one pass: select, *Forget
selected (n)*, confirm. Removing several entries at once is a separate call
(`hostkey:removeMany`) rather than a loop in the renderer, because entries are
addressed by **line number** — removing them one at a time from the top shifts
every line below it and deletes the wrong keys. The batch sorts each file's lines
descending and writes the file once. `smoke:knownhosts` removes two *non-adjacent*
rows and checks the survivors by name, both in the table and on disk.

The selection is pruned to whatever the filter shows, so "3 selected" always means
three rows you can see; a selection that survived a filter change would let the
button remove entries that are no longer on screen.

**Command history** is kept per session for the History panel (7 days) *and* in one
shared list (`commands.json`) that inline suggestions read. The shared list is what
makes completion useful — the command you want is very often one you ran in another
pane — and it is also what makes the storage rules matter: a line that **starts with
a space** is never stored (the shell convention for "do not keep this", and the
easiest way for a mistyped password to stay out of a plain-text file), nor are empty
lines, immediate repeats, or anything over 240 characters. The list is capped at 400,
newest first, de-duplicated by promotion.

**Inline suggestions** appear as you type: the shared history filtered by what is on
the line. `↑`/`↓` walk the candidates, `Enter` (or `Tab`) brings one into the line
**without running it**, `Escape` dismisses. While the popup is closed those keys are
untouched, so the shell keeps its own history navigation. Completion writes only the
*remainder* — typing `git sta` and picking `git status --short` sends `tus --short` —
because erasing and retyping the line would churn the scrollback.

The mirror of the current line is fed from `term.onData`, i.e. the keystrokes, and it
has to strip escape sequences: a paste arrives wrapped in `ESC [ 200 ~`, a focus
report as `ESC [ I`, and arrows as their own sequences. The first working version
kept the paste markers, so the mirrored prefix was `"[IGet-"` and matched nothing —
which is why `smoke:suggest` types through the same path the keyboard does.

**Arrange panes** (`Ctrl`+`Shift`+`T`, or the tab menu) tiles the open panes into a
grid, columns or rows. It is built on `panel.api.moveTo` rather than on rebuilding the
layout: a panel that is removed takes its terminal and session with it, so a "tile
everything" that re-added panels would close every connection it was arranging. Sizes
are equalised afterwards with `group.api.setSize`, because splitting in a chain gives
the first pane half the window, the next a quarter, and so on — a tiling in a data
structure that looks nothing like one on screen, and one that measures 276px against
296px for the pane that takes the remainder.

## Layout persistence

The window reopens the way you left it: pane splits and tab groups, which rail
section was showing, whether the rail was shrunk, whether the snippet bar was
visible, whether the Hosts page is listing rows or cards, and which of its groups
are folded away. The arrangement is written to `layout.json` in the app's user-data
directory.

Anything the user picks *for a page* belongs in that file rather than in the
page's own state: pages are unmounted when another rail section is showing, so a
choice kept in `useState` lasts exactly until the user looks at something else.
The rows/cards switch was like that — leave Hosts, come back, and it was rows
again. Folded groups are kept the same way, and deliberately **not** in
`SessionFolder.expanded`, which the drawer's session tree uses: those are two views
of one folder tree with different jobs, and collapsing twenty groups to see the
shape of the host library should not fold the quick-connect list under someone on
the terminal page. It also keeps "collapse them all" to a single write.

An older file that predates the rail/drawer merge is still understood: the
retired `sidebarVisible` / `sidebarCollapsed` pair is read as "whether the rail
was collapsed", so upgrading does not silently reopen a sidebar you had hidden.

**Sessions are deliberately not reconnected.** A restored pane comes back as a
placeholder with a **Reconnect** button, because silently spawning local shells
or opening SSH connections on launch would be a surprise — and the local-shell
case would leak processes. If the saved session has since been deleted, the pane
says so instead of failing quietly.

**A pane remembers which saved session it came from.** Its own id is the *live*
session it was showing, which means nothing after a restart, so the saved id is
recorded in the pane's params — the same state the layout is serialised from —
and Reconnect looks that up. A layout written before this was recorded keeps the
dead live id; for those the pane's title is tried, since it is the saved
session's name. Reconnect then connects *into that pane* instead of opening a
second one beside it.

## Appearance

**Interface scale.** Settings → Appearance → *Interface scale* offers 80% to
150%, and `Ctrl`+`Shift`+`=` / `-` steps it. It is applied with
`webContents.setZoomFactor`, so the rail, sidebar, dialogs, spacing and the
terminal font all grow together instead of only the text. Picking one previews it
immediately and the hint says it is a preview; closing the drawer by **any** route
(Close, the header ✕, the backdrop, Escape) puts the stored value back, and only
*Save settings* keeps it.

**Terminal font size** is the plain `Ctrl`+`=` / `-`, and it changes only the text
inside the sessions (`terminal.fontSize`, 8–32px, applied live to every pane). The
two used to be the same gesture — the window zoom — which meant that making a
shell's output readable also shrank the tab bar, the drawer and the dialogs. Scaling
the window is a different intent from enlarging terminal text, so it now has its own
chord; `smoke:features3` asserts both halves (the font moved, `devicePixelRatio`
did not; then the scale moved and the font did not).

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

**Interface language.** Settings → Appearance → *Language*: English or 简体中文.
Picking one redraws the whole shell immediately — the drawer, the rail and the
menus around it included — and *Save settings* keeps it; closing by any route puts
the stored one back, exactly like the theme preview.

The English text is the source of truth and lives **at the call site**:
`t('hostspage.new_host', 'New host…')`. `src/renderer/src/i18n/zh.ts` holds only
the translations, so a key with no translation shows English and a missing entry is
never a blank label. Anything that is not prose is left alone on purpose — product
and font names, `Ctrl`/`Alt`/`Esc`, sample commands and paths.

**A whole page, not just its chrome.** The REST tool page was the last English left inside a Chinese
interface: its 48 strings were already wrapped in `t()`, but the catalog held not a single
`restpage.*` entry, so every one of them fell back — and an untranslated key is only a *note* in
`check:i18n`, never a failure, which is how it survived a release. Three kinds of text on that page
do not go through `t()` at all, and each needed its own route: the built-in templates' names and
descriptions (shared data, translated by id with the English still the fallback for both
languages), the four failures the main process words itself (`RestResponse.errorCode`, translated by
code — raw Node errors such as `ECONNREFUSED` keep their text, which is the useful part), and one
hardcoded fallback. `smoke:i18n` therefore asserts the page as a whole: it lists the English that
used to be there and requires that none of it comes back, which the untranslated page fails outright.
Everything that is not prose stays English on purpose, exactly as elsewhere: `REST`, `URL`, `JSON`,
the sample values and the units. **S3 and port forwarding are still English-only** — they are owed
the same treatment.

```bash
npm run extract:i18n   # after adding UI text: wrap the new strings, list them
npm run check:i18n     # in `verify`: stale keys, and one key with two English texts
```

`extract:i18n` is a real codemod (TypeScript compiler API, not regexes): it wraps
JSX text, UI-named attributes and `label:`/`title:` properties, and knows the
difference between a label ("Terminal") and a value ("monospace"). Two traps it
exists to avoid are in *Gotchas* below — a `t()` call at module scope, and a
preview that repaints only the dialog.

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
actually installed on this machine, read from the platform, plus the faces that
ship inside the app: **Roboto Mono** and **JetBrains Mono**. Clicking a chip
applies it, the field stays free-text, and a live preview shows the choice before
it is saved. Choosing a family rebuilds the fallback stack rather than replacing
it, so a font missing a glyph still falls back correctly.

The bundled pair matters more than it sounds. The list used to append a shortlist
of fonts a desktop "probably" has, so it offered names that were not installed —
picking one changed nothing at all, because the browser silently fell back. Those
names are now offered for autocomplete only and labelled *not installed*, and the
two faces people actually ask for are shipped instead (four weights each, latin
subset, ~50-90 KB total, SIL OFL 1.1 with the licences beside them). A bundled
face is loaded before xterm measures a character cell — measuring the fallback
would leave every pane at the wrong width until something else refitted it.

**Cursor.** Four shapes: outline (the default), block, bar, underline. The default
is the hollow box — transparent inside, outlined in the terminal's text colour, so
it is a black frame on a light palette and a white one on a dark palette — because
a filled block covers the character under it, which is the one the user is about to
overtype.

xterm has no *active* outline cursor: `cursorStyle` takes block, bar and underline,
and the hollow box it can draw is the one it shows while the terminal is unfocused.
So "outline" is handed to xterm as a block and our stylesheet draws it hollow. Two
consequences worth knowing before touching that CSS:

- xterm injects its cursor colours as a stylesheet **generated at runtime** and
  appended to `<head>` after ours, and its rule for a steady block carries
  `!important`. Only specificity beats it, so the hollow rule needs one more class
  than `… .xterm-cursor.xterm-cursor-block:not(.xterm-cursor-blink)`.
- the character under the cursor is drawn inside the cursor element and xterm
  colours it with `cursorAccent` (the background colour) to keep it readable on a
  filled block. Hollow, that would make the character invisible, so it is repainted
  in the text colour (`--td-term-fg`, published by the pane from the palette).

The blink rate is selectable (or off). This is ours rather than xterm's because
xterm only adds its blink class while *its* blink option is on, and we keep that
off so our cadence owns the rate — which also means the animation must target the
cursor element rather than xterm's class. `prefers-reduced-motion` turns blinking
off entirely.

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

## Adding hosts in bulk

New session → **Several hosts** takes a list instead of a single address: one per
line, with the username, port, group, authentication and password shared by all of
them.

| Line | What it creates |
| --- | --- |
| `web1.example.com` | one host |
| `10.17.20.210-215` | six hosts, `.210` through `.215` |
| `node01-04` | `node01` … `node04`, keeping the zero padding |
| `root@10.0.0.5:2222` | that user and port for this line only |
| `# prod`, blank lines | ignored |

A range is only ever the **trailing number** moving, which is why
`web-1.example.com` stays a hostname; a range written backwards is reported
rather than accepted as a host called `10.17.20.215-210`. Up to 256 hosts at a
time, duplicates inside one paste collapse, and anything unreadable is named
rather than dropped — the line under the box counts what will be added, what is
already saved (matched on host **and** user and port, since two logins to one
machine are two sessions) and what could not be read.

The password is sealed once per host, so a host that rejects it is simply asked
again, on its own, at connect time.

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
needs no CSS changes — except that the preview strip in the picker is drawn from
three empty spans inside a `<button>`, and Chromium gives buttons
`align-items: flex-start`, so it needs an explicit `align-self: stretch` or every
card renders as a blank strip.

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

The picker lists the light palettes first, then the dark ones: they are the ones
that share a scheme, and a theme added at the end of the array used to land in the
last row, past the fold of the drawer. Nothing depends on the order — a theme is
stored and found by id.

Contrast is verified rather than eyeballed: `npm run smoke:contrast` switches
through every theme and fails if any non-decorative text falls below 3:1 against
its effective background. `scripts/tunecontrast.cjs` derives compliant muted-text
colours from each theme's own foreground.


**Deleting a group asks first when it would take hosts with it.** The store deletes
a folder together with every host inside it, and inside every sub-group of it, so
one click on "Delete folder" used to throw a whole client's worth of hosts away
silently. The question now names the group and counts what is inside it ("still
holds 3 hosts across 1 sub-group") and the confirm button says how many hosts it
will delete. An *empty* group is still removed straight away — there is nothing to
lose, and a dialog for it would just be a click added to every tidy-up. Both entry
points are guarded: the Hosts page and the drawer's session tree.

## First run

A fresh install (or a settings file written before this screen existed) opens on a
welcome sheet with four choices: **language**, **colour scheme**, **terminal
font**, and **where the app keeps its data**. All four are applied live, so the
screen is its own preview, and *Get started* writes them and sets
`settings.onboarded`. Nothing else is a first-run path — the sheet is rendered
*over* the shell rather than instead of it, so every part of the app is already
mounted and wired while it is up.

**Where the data lives** is the interesting one. The stores all take a config
directory at construction, so moving it is a matter of pointing them somewhere
else *before* they are built — which means the pointer cannot live inside the data
it describes. It lives in Electron's `userData` as `data-dir.json`:

- read synchronously at start-up (`resolveDataDir`), falling back to `userData` if
  it is missing, unreadable, or names a directory that is not there;
- changing it **copies** the app's files (settings, layout, sessions, credentials,
  history) into the new directory — copy rather than move, so a half-finished
  attempt cannot lose anything — and then restarts, because a value that changed
  mid-run would leave some stores on the old path;
- the welcome screen offers it because that is the only moment nothing has been
  written yet. It is also in Settings → Credentials afterwards.

## Sharing saved hosts

Hosts page → **Export** writes the whole tree — groups, hosts, tags, and the saved
passwords if you leave that box ticked — into one file (`.tdshare`). **Import**
reads someone else's back. The point is handing a colleague the fleet in one go
instead of pasting twenty lines into a chat window.

The same pair sits in **Settings → Credentials → Hosts backup**. Both open the same
dialog: the Hosts toolbar is where you go to get your host list in and out, and the
credentials tab is where people look for "move my data to another machine", next to
the thing being moved. `smoke:onboarding` drives the settings entry through the
*real* save dialog (stubbed in the main process, not bypassed) — the rest of
`smoke:share` passes a path in, and would not notice if that branch broke.

The file is **gzipped and then encrypted** with a passphrase you choose: compressed
first, so no plaintext is ever written, and encrypted so it can travel by mail or
chat. AES-256-GCM with a scrypt-derived key (2^15 · r8 · p1, ~100 ms per attempt).
Nothing about the hosts is readable from the file — not the addresses, not the
names, not the passwords — and a single flipped byte is caught by the
authentication tag rather than decrypted into nonsense. The container is
self-describing (`TDSHARE1` magic, then salt, iv, tag, body), so a truncated file,
a file that is not ours, and a file from a newer build each get their own sentence.

Import merges rather than replaces:

- **A host already here is skipped**, and "already here" means the same username
  *and* host *and* port — two logins to one machine are two legitimate sessions.
- **A group with the same name is reused**, and its children are recreated inside
  it, so importing the same file twice is a no-op rather than a doubled tree.
- Imported secrets are **re-sealed under the ids minted on this machine**; the
  file's ids never reach the local credential store.
- The dialog reads the file as soon as a passphrase is present and says what it
  would do — how many hosts, how many are already here, how many come with a
  password — using the same plan the import then executes.

`npm run smoke:share` covers the container (round trip, wrong passphrase, damaged
byte, truncated file, foreign file, newer version), the merge rules, and the whole
thing through the real IPC — including that the file on disk contains no readable
host or password.

## Security notes

- **Host keys are verified.** A changed key is never accepted automatically,
  even under "trust on first use" — that is precisely the case a
  man-in-the-middle produces. New entries are hashed (`HashKnownHosts` style)
  so the file does not leak which hosts you connect to.
- **Saved credentials are encrypted at rest** (see above) and never cross into
  the renderer. Credentials typed for a one-off connection are not persisted.
- **A share file is only as private as its passphrase.** It carries passwords if
  the exporter ticked the box, protected by the passphrase alone — the app cannot
  help beyond refusing anything shorter than eight characters. Send the passphrase
  by a different route from the file.


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

3. **Cut a release branch, then push commits and a tag:**

   ```bash
   git switch -c release/v0.2.0     # from the commit you are releasing
   git push -u origin release/v0.2.0
   git tag v0.2.0
   git push origin master
   git push origin v0.2.0
   ```

   The tag is what a release hangs off. `v0.2.0` matches the version, which is
   the convention GitHub expects.

   The branch is what the release *is*: `master` keeps moving, and
   `release/v<version>` stays at the commit that was built, so a bug report
   against a download can be checked out exactly. Fixes for a shipped release go
   on the branch and are merged back to `master` afterwards; a new version means a
   new branch, never a force-push of an old one.

4. **Create the release** in the browser:

   - Go to
     `https://github.com/<you>/termdeck/releases/new?tag=v<version>` — the tag is
     pre-filled, and it is the target of the release, not the branch
   - **Release title**: e.g. `TermDeck v0.2.0`
   - **Describe this release** — the notes shown on the release page. Keep them in
     `docs/发行说明-v<version>.md` and paste from there, so the release page and the
     repository say the same thing.
   - **Attach binaries** by dragging files into the box, or click
     *Attach binaries by dropping them here*. Add:
     - `release/TermDeck-Setup-<version>.exe`
     - `release/TermDeck-<version>-x64.exe` (portable)
     - `release/TermDeck-<version>-win-x64-portable.zip`
   - Click **Publish release**

   The download URLs then look like
   `https://github.com/<you>/termdeck/releases/download/v0.2.0/TermDeck-Setup-0.2.0.exe`.

   Note that GitHub rejects individual assets over 2 GB; these are ~114 MB, so
   that is a non-issue here.

5. **Later releases** are the same: bump the version, build, commit, cut
   `release/v<version>`, tag it, push master + branch + tag, draft a release,
   attach the files. Tag push does not create a release by itself — uploading
   assets is a separate step.

A Windows SmartScreen warning is expected on first launch for an unsigned build:
the binary has no code-signing certificate, so Windows cannot vouch for the
publisher. "More info → Run anyway" proceeds. Buying a certificate and setting
`CSC_LINK` / `CSC_KEY_PASSWORD` removes the warning.

The prompt is driven by **Mark-of-the-Web** (the `Zone.Identifier` Windows attaches
to anything downloaded), so it can also be avoided rather than clicked through:
right-click → Properties → **Unblock**, or `Unblock-File .\TermDeck-<version>-x64.exe`.
Unblocking the *zip* before extracting is the tidiest version of that, because
Windows propagates the mark to the extracted files. The single-file portable build
triggers it most often — it unpacks to a temp directory on every launch — so prefer
the zip or the installer when handing a build to someone. The whole picture,
including what a certificate costs and how to verify a signature, is in
`docs/安装与信任.md`. Each release also ships a `SHA256SUMS-<version>.txt`.

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
npm run smoke:share    # encrypted host export/import
npm run smoke:i18n     # language switch, persistence, revert, and a whole tool page in Chinese
npm run smoke:knownhosts # known hosts page: selection, batch forget, filter pruning
npm run smoke:onboarding # first run, data directory, settings-side export
npm run smoke:features3 # font picker, cursor blink, broadcast input
npm run smoke:scale     # interface scale: applies, previsualises, persists, reverts
npm run smoke:batch     # adding hosts in bulk: ranges, shared credentials, what is skipped
npm run smoke:gesture   # pane fits are held during a drag and taken once when it ends
npm run smoke:share     # encrypted host sharing: container, merge rules, real IPC
npm run smoke:snippet   # snippets send verbatim; a line break is what runs them
npm run smoke:layout    # layout persists across a real restart, panes reconnect after it
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

- **A `t()` call at module scope is evaluated once, before the language is known.**
  The nav rail's labels were a module-level `PAGES` array, so they were translated
  at import time — with English — and never re-evaluated: switching to Chinese left
  the rail English while every label around it changed. Anything translated must be
  built during render (a function, or an array inside the component).
- **A React-rendered string cannot be previewed the way a theme is.** The theme
  preview works by writing CSS variables, which needs no re-render; text does. The
  dialog therefore changes the language imperatively (like the theme) *and* the
  shell subscribes to the change — and the stored value is pushed from an effect on
  `settings.language` rather than on every render, or the preview would be undone by
  the very render it caused.
- **A selector that waits for a class the library only adds under an option you
  disabled never matches — and nothing complains.** Cursor blinking was animated on
  xterm's `xterm-cursor-blink` class, but xterm only adds that class while *its*
  blink option is on, and the app keeps that option off so its own cadence owns the
  rate. So the animation rule existed, the attribute that feeds it was set, the
  probe that checked both passed — and the cursor never blinked. Target the element
  you control (`.xterm-cursor`) and let your own flag switch it on.
- **xterm injects its cursor colours at runtime, after your stylesheet.** Its rules
  are generated per terminal and appended to `<head>`, and the one for a steady block
  cursor carries `!important`. Source order therefore favours xterm, so the only
  lever is specificity: `.td-terminal-host[data-cursor-style='outline'] .xterm
  .xterm-rows .xterm-cursor.xterm-cursor-block` (six) beats
  `… .xterm-rows .xterm-cursor.xterm-cursor-block:not(.xterm-cursor-blink)` (five).
  Anything with fewer classes silently loses, which is why the smoke probe *measures*
  the computed `background-color` and `box-shadow` instead of trusting the rule.
- **`.td-form input { width: 100% }` also matches checkboxes.** It looks like it is
  about text fields, but an `input[type=checkbox]` inside a form got the sunken
  background, the border and the full width — and Chromium draws the box centred
  in whatever space it is given, so the result was a stretched control with its
  label squeezed to one character per line. The connect prompt's "remember"
  checkbox had been like that since it was written. Exclude checkbox/radio in the
  selector *and* pin `width: auto` on `.td-check input`.
- **A bare class loses to a child combinator that styles the same element.**
  `.td-hint` sets `text-transform: none`, but `.td-field > span` (one class *and*
  an element) sets `uppercase`, so every hint inside a field rendered as an
  overline label however the hint was written. Reset it as
  `.td-field > span.td-hint`, with the same weight as the rule being overridden.
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
- **`panel.api.getParameters()` is empty on a panel that came out of `fromJSON`.**
  The params in the file *are* delivered to the content renderer, but dockview's
  own panel state stays empty until something calls `updateParameters` on it — and
  the layout is serialised from that state. So a restore that reads
  `getParameters()` sees nothing (it must read the parsed file instead), and
  anything *written* must go through `updateParameters` or it is lost on the next
  save. This is what made a restored pane's Reconnect button answer "no longer
  saved" every time: the pane had only recorded its own, by then dead, live
  session id.
- **A `<button>` does not stretch its children the way a `div` would.** Chromium's
  own stylesheet sets `align-items: flex-start` on buttons, which beats the flex
  container default, so a `display: flex; flex-direction: column` button whose
  children have no intrinsic width collapses them. That is what left every theme
  preview in the picker blank since the first release; `align-self: stretch` on the
  strip is the fix, and `smoke:ui3` now measures the strips rather than trusting
  them to render.
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

- **A suite that measures a focus-dependent timer needs the window in front.**
  `smoke:wellbeing` times a break reminder that only counts seconds while
  `document.hasFocus()` is true, and `win.focus()` is a request rather than a
  command — Windows does not hand the foreground to a process the user is not
  interacting with. The same build scored 46/46 and then 37/46 on consecutive
  runs, the second time as nine cascading timing failures. It now waits for the
  foreground and reports one clear failure if it never arrives, so do not work in
  another window while it runs.

- **A preference the machine has already set can hide the thing under test.**
  Windows' "animation effects" being off makes Chromium report
  `prefers-reduced-motion: reduce`, and this stylesheet honours that by collapsing
  every transition and animation to 1ms. `smoke:gesture` watches a sidebar
  collapse, which is recognised by its width transition, so it emulates
  `no-preference` for that half via `Emulation.setEmulatedMedia` — otherwise there
  is no animation to observe on this machine at all.

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
| `Ctrl`+`=` / `-` | Larger / smaller terminal font |
| `Ctrl`+`Shift`+`=` / `-` | Larger / smaller interface |
| `Ctrl`/`Cmd` + `D` | Close a pane whose session has **already ended** |
| `Ctrl`/`Cmd` + `,` | Open settings (drawer) |
| `Ctrl`/`Cmd` + `B` | Toggle the sidebar |
| `Ctrl` + `Shift` + `E` | Open the connections drawer |
| `Ctrl` + `Shift` + `S` | Toggle the snippet bar |
| `Ctrl` + `Shift` + `B` | Broadcast input to every pane |
| `Ctrl` + `Shift` + `T` | Arrange panes (tile / columns / rows) |
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

`Ctrl+D` is the interesting one, because in a live shell it means EOF. A handler may
return `false` to **decline** the key, and this binding does exactly that while the
pane still has a session behind it — so the key reaches the shell untouched and the
dispatcher never swallows it. Once the process has ended (the pane shows *Session
ended*), the same key closes the pane instead: there is no shell left for EOF to
reach, and closing it is the only thing left to do with it. The ended state is
tracked per *session* rather than per pane, so reconnecting a pane gives it a new id
and `Ctrl+D` becomes EOF again immediately.

Notifications at the bottom of the window dismiss themselves after `TOAST_MS`
(1.2 s in `App.tsx`); clicking one dismisses it early, and a new message restarts
the timer. They used to stay until clicked, which turned a message from ten minutes
ago into what looked like the current state of things.

## Licence

MIT.
