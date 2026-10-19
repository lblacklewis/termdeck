/**
 * Inline command suggestions, WindTerm style.
 *
 * What is being typed is mirrored here from `term.onData` — the keystrokes, not the
 * screen — so the popup can filter on the line as it stands. ↑/↓ walk the
 * candidates, Enter brings one into the line **without running it**, Escape
 * dismisses. When the popup is closed ↑/↓ are untouched, so the shell keeps its own
 * history navigation.
 *
 * Completion inserts only the remainder: typing `git sta` and picking
 * `git status --short` writes `tus --short`, which is what a shell's own completion
 * feels like. Erasing and retyping the whole line would be visible churn in the
 * scrollback.
 */

const api = window.termdeck

/** One line of input, as the shell will receive it. */
const BACKSPACE = new Set([0x7f, 0x08])
const SUBMIT = new Set([0x0d, 0x0a])
const INTERRUPT = 0x03

export interface SuggestOptions {
  /** The pane element the popup is appended to and keydown is watched on. */
  container: HTMLElement
  /** The xterm instance, for the cursor position and the screen contents. */
  term: {
    buffer: { active: { cursorX: number; cursorY: number; baseY: number } }
    element?: HTMLElement | null
  }
  /** Write to the session, exactly like typing. */
  write: (data: string) => void
}

export interface SuggestHandle {
  /** Feed one chunk from `term.onData`. */
  feed: (data: string) => void
  dispose: () => void
}

const MAX_ITEMS = 8
/** Longer prefixes are past the point of helping — the list is already short. */
const MIN_CHARS = 1

export function attachSuggestions({ container, term, write }: SuggestOptions): SuggestHandle {
  let line = ''
  let items: string[] = []
  let active = -1
  let open = false
  let cache: string[] = []
  let cacheAt = 0
  let feeds = 0
  /** Characters typed since the popup opened, and whether it was dismissed by typing. */
  let typed = 0
  let muted = false

  /** Why the popup is or is not showing, for the probe (see `tdDebug`). */
  const debug = (): void => {
    if (window.localStorage.getItem('tdDebug') !== '1') return
    ;(window as unknown as Record<string, unknown>)['__tdSuggest'] = {
      line,
      items,
      open,
      feeds,
      hidden: box.hidden,
      cached: cache.length
    }
  }

  const box = document.createElement('div')
  box.className = 'td-suggest'
  box.setAttribute('data-testid', 'command-suggest')
  box.hidden = true
  container.appendChild(box)

  const history = async (): Promise<string[]> => {
    const now = Date.now()
    // Refreshed on open rather than on every keystroke: the list changes when a
    // command is *run*, which cannot happen while a popup is open.
    if (now - cacheAt < 1500 && cache.length) return cache
    try {
      cache = await api.globalCommandHistory()
      cacheAt = now
    } catch {
      cache = cache.length ? cache : []
    }
    return cache
  }

  const paint = (): void => {
    box.textContent = ''
    items.forEach((command, index) => {
      const row = document.createElement('div')
      row.className = 'td-suggest-item' + (index === active ? ' is-active' : '')
      row.setAttribute('data-index', String(index))
      // The prefix stays dim so the eye can see what is being added.
      const typed = document.createElement('span')
      typed.className = 'td-suggest-typed'
      typed.textContent = command.slice(0, line.length)
      const rest = document.createElement('span')
      rest.textContent = command.slice(line.length)
      row.append(typed, rest)
      box.appendChild(row)
    })
    box.hidden = items.length === 0
  }

  const place = (): void => {
    const host = term.element ?? container
    const cursor = host.querySelector('.xterm-cursor') as HTMLElement | null
    const paneRect = container.getBoundingClientRect()
    if (cursor) {
      const rect = cursor.getBoundingClientRect()
      box.style.left = Math.max(4, Math.round(rect.left - paneRect.left)) + 'px'
      // Above the cursor line unless there is no room, which happens on the first row.
      const above = rect.top - paneRect.top
      const height = box.offsetHeight || 0
      box.style.top =
        above > height + 12
          ? Math.round(above - height - 4) + 'px'
          : Math.round(rect.bottom - paneRect.top + 4) + 'px'
    } else {
      box.style.left = '8px'
      box.style.top = Math.max(8, Math.round(paneRect.height - 120)) + 'px'
    }
  }

  const refresh = (): void => {
    if (line.length < MIN_CHARS || line.startsWith(' ')) {
      open = false
      items = []
      box.hidden = true
      debug()
      return
    }
    const needle = line.toLowerCase()
    void history().then((all) => {
      // Re-check: the line may have changed while the list was loading.
      if (line.length < MIN_CHARS) return
      items = all
        .filter((command) => command.toLowerCase().startsWith(needle) && command !== line)
        .slice(0, MAX_ITEMS)
      active = -1
      // A fresh list starts with nothing selected, and the typing budget resets.
      typed = 0
      open = items.length > 0
      if (!open) {
        box.hidden = true
        debug()
        return
      }
      paint()
      place()
      debug()
    })
  }

  const accept = (): void => {
    const command = items[active]
    if (!command) return
    // Only the remainder when the shell already shows the prefix.
    const tail = command.startsWith(line) ? command.slice(line.length) : command
    if (!command.startsWith(line)) {
      // A case-insensitive match: erase what is there and type the whole thing.
      write('\x7f'.repeat(line.length) + command)
      line = command
    } else if (tail) {
      write(tail)
      line = command
    }
    close()
  }

  const close = (): void => {
    open = false
    items = []
    box.hidden = true
    line = ''
  }

  /*
   * Capture phase on the pane: these keys belong to the popup while it is open, and
   * xterm would otherwise turn ↑/↓ into escape sequences and Enter into a newline —
   * the popup has to win before the terminal sees them. While it is closed nothing
   * is intercepted at all.
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Nothing is selected when the popup opens: the arrows make the first move.
      active =
        active < 0
          ? step > 0
            ? 0
            : items.length - 1
          : (active + step + items.length) % items.length
      paint()
      place()
      return
    }
    /*
     * Enter accepts, Tab does not.
     *
     * Tab belongs to the shell — it is how every shell completes a path or a command,
     * and taking it over silently replaced that with our own list. Enter without a
     * selection is left alone too, so it still runs what is on the line.
     */
    if (event.key === 'Enter') {
      if (active < 0) {
        close()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      accept()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  container.addEventListener('keydown', onKeyDown, true)

  const feed = (data: string): void => {
    feeds += 1
    /*
     * Escape sequences are not text.
     *
     * A paste arrives wrapped in `ESC [ 200 ~` … `ESC [ 201 ~`, focus reports arrive
     * as `ESC [ I`, and arrows and history recall arrive as their own sequences. Fed
     * naively, the paste markers ended up in the mirrored line — the first run of
     * this feature saw the prefix "[IGet-" and matched nothing at all.
     *
     * The paste markers are removed and the content kept (a paste *is* typed text),
     * while any other escape sequence means the line moved underneath us, so the
     * mirror is dropped rather than completed from stale text.
     */
    const stripped = data
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
    if (stripped.includes('\x1b')) {
      if (open) close()
      return
    }
    for (const char of stripped) {
      const code = char.codePointAt(0) ?? 0
      if (SUBMIT.has(code)) {
        close()
        muted = false
      } else if (BACKSPACE.has(code)) {
        line = line.slice(0, -1)
        if (!line) {
          close()
          muted = false
        } else if (open) void refresh()
      } else if (code === INTERRUPT) {
        close()
        muted = false
      } else if (code >= 32 && code !== 127) {
        line += char
        if (line.length > 240) {
          close()
          return
        }
        /*
         * Typing on past the popup dismisses it.
         *
         * A list that keeps filtering while the line grows becomes a banner over the
         * text the user is already committed to typing. Three more characters without
         * picking anything means the suggestion is not what they want; the line stays
         * quiet (no reopening) until it is cleared.
         */
        if (muted) continue
        if (open) {
          typed += 1
          if (typed > 3) {
            close()
            muted = true
            continue
          }
        }
        refresh()
      } else {
        // Arrows and other control sequences mean the line may no longer be what we
        // think it is: drop the popup rather than complete the wrong text.
        if (open) close()
      }
    }
  }

  return {
    feed,
    dispose: () => {
      container.removeEventListener('keydown', onKeyDown, true)
      box.remove()
    }
  }
}
