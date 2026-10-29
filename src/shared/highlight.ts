/**
 * Output highlighting: which things in a wall of terminal text are worth spotting,
 * and the palettes used to spot them.
 *
 * Shared because both sides need the *ids*: the renderer draws the colours, and the
 * settings store has to validate whatever a hand-edited settings file contains
 * against the same list.
 *
 * Two deliberate limits come from the terminal, not from taste:
 *
 *   - xterm decorations can only paint a cell's foreground and background, in
 *     `#RRGGBB`. No bold, no underline — so a scheme is colours and nothing else.
 *   - A decoration is a rectangle of cells, so a rule must be a pattern that matches
 *     text in the buffer, not something that spans rows.
 */

/** What a rule looks for. */
export type HighlightRuleId =
  | 'ip'
  | 'url'
  | 'email'
  | 'mac'
  | 'path'
  | 'error'
  | 'warn'
  | 'success'

export type HighlightSchemeId = 'classic' | 'xshell' | 'soft' | 'mono'

/** Colours for one rule. `bg` is what makes a block, `fg` recolours the glyphs. */
export interface HighlightStyle {
  fg?: string
  bg?: string
}

export interface HighlightRule {
  id: HighlightRuleId
  /** English source text; the catalog carries the translation. */
  english: string
  /**
   * Every pattern the rule looks for.
   *
   * Several are needed because "an error" is a word list while "a path" has two
   * grammars (POSIX and Windows), and a compound regex for that is unreadable.
   */
  patterns: RegExp[]
}

export interface HighlightScheme {
  id: HighlightSchemeId
  /** English source text; the catalog carries the translation. */
  english: string
  styles: Record<HighlightRuleId, HighlightStyle>
}

/**
 * Rules are matched in this order and the first one to claim a cell keeps it.
 *
 * Order matters where patterns overlap: a URL contains slashes, so `path` would
 * otherwise repaint the inside of every link it was meant to leave alone.
 */
export const HIGHLIGHT_RULES: HighlightRule[] = [
  {
    id: 'url',
    english: 'Links',
    patterns: [/\b(?:https?|ftp):\/\/[^\s"'<>()]+/gi, /\bwww\.[^\s"'<>()]+/gi]
  },
  {
    id: 'email',
    english: 'Email addresses',
    patterns: [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g]
  },
  {
    id: 'mac',
    english: 'MAC / hardware addresses',
    /*
     * Six groups **or more**, not exactly six.
     *
     * A hardware address is not always 6 bytes: `ip addr` prints an InfiniBand
     * port as twenty colon-separated groups, and EUI-64 as eight. With "exactly
     * six" the trailing `\b` was satisfied by the colon after the sixth group, so
     * a long address painted its first six groups and left the rest bare — the
     * "只亮了一小截" report. Greedy groups paint the whole run; a six-group MAC is
     * unchanged.
     */
    patterns: [/\b(?:[0-9a-f]{2}[:-]){5,}[0-9a-f]{2}\b/gi]
  },
  {
    id: 'ip',
    english: 'IP addresses',
    /*
     * IPv6 comes before IPv4 on purpose: an embedded-IPv4 address like
     * `::ffff:192.168.1.1` contains a plain IPv4 tail, and if the IPv4 pattern
     * claimed those cells first the address would paint as a few characters in the
     * middle with both ends left bare — exactly the "只高亮了半截" report. With the
     * IPv6 patterns first, the whole address is one match and the IPv4 tail inside
     * it is already claimed when the IPv4 pattern gets there.
     *
     * Two IPv6 patterns, split by where the dotted quad sits, because one grammar
     * for both is unreadable:
     *   - hex forms (full, compressed, `%zone` suffix) — `2001:db8::1`,
     *     `fe80::1%en0`;
     *   - embedded dotted quad — `::ffff:1.2.3.4`, `64:ff9b::192.0.2.33`,
     *     `2001:db8::1.2.3.4`, `::127.0.0.1`.
     *
     * Neither is a validator: this paints terminals, it does not parse addresses.
     * What they must not do is swallow a MAC address (`a1:b2:c3:d4:e5:f6` — six
     * 2-digit groups, no `::`, no 3+ digit group — stays with the MAC rule) or
     * light up inside a longer run of hex or a clock (`12:34:56`, the `ef::1`
     * tail of `deadbeef::1`) — which is what the two look-around guards are for.
     */
    patterns: [
      /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7})(?:%[0-9a-z]+)?(?![\w:.])/gi,
      /(?<![\w:.])(?:::(?:[0-9a-f]{1,4}:)?|(?:[0-9a-f]{1,4}:){1,5}:)(?:\d{1,3}\.){3}\d{1,3}(?![\w:.])/gi,
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
    ]
  },
  {
    id: 'path',
    english: 'File paths',
    patterns: [/\/(?:[\w.@+-]+\/){2,}[\w.@+-]*/g, /\b[A-Za-z]:\\[^\s"'<>|]+/g]
  },
  {
    id: 'error',
    english: 'Errors',
    patterns: [
      /\b(?:error|errors|failed|failure|fatal|panic|exception|denied|refused|unreachable|timeout|timed\s+out|not\s+found|no\s+such)\b/gi
    ]
  },
  {
    id: 'warn',
    english: 'Warnings',
    patterns: [/\b(?:warn|warning|warnings|deprecated|caution|retrying|degraded)\b/gi]
  },
  {
    id: 'success',
    english: 'Success',
    patterns: [
      /\b(?:success|successful|succeeded|done|ready|listening|started|enabled|passed|healthy|active)\b/gi
    ]
  }
]

/**
 * Rules switched on the first time highlighting is enabled.
 *
 * `path` is left out: it is the noisiest of the eight (every `~/.config/...` in a
 * listing becomes a block), and it is the one people most often want off.
 */
export const DEFAULT_HIGHLIGHT_RULES: HighlightRuleId[] = [
  'ip',
  'url',
  'email',
  'mac',
  'error',
  'warn',
  'success'
]

const blank: HighlightStyle = {}

/**
 * Four palettes.
 *
 * `classic` is the oh-my-zsh register: bright, foreground only, tuned for a dark
 * theme. `xshell` paints the background as well, which is what makes a match read as
 * a block — its pairs carry their own foreground, so they stay readable on a light
 * theme too. `soft` is the light-theme answer to `classic`, and `mono` keeps the
 * informative rules one colour for people who do not want a rainbow.
 */
export const HIGHLIGHT_SCHEMES: HighlightScheme[] = [
  {
    id: 'classic',
    english: 'Classic',
    styles: {
      ip: { fg: '#4dabf7' },
      url: { fg: '#74c0fc' },
      email: { fg: '#63e6be' },
      mac: { fg: '#ffd43b' },
      path: { fg: '#b197fc' },
      error: { fg: '#ff6b6b' },
      warn: { fg: '#ffd43b' },
      success: { fg: '#69db7c' }
    }
  },
  {
    id: 'xshell',
    english: 'XShell blocks',
    styles: {
      ip: { fg: '#d0ebff', bg: '#1864ab' },
      url: { fg: '#d0ebff', bg: '#1971c2' },
      email: { fg: '#e5dbff', bg: '#5f3dc4' },
      mac: { fg: '#fff3bf', bg: '#8a6d00' },
      path: { fg: '#d3f9d8', bg: '#2b8a3e' },
      error: { fg: '#ffe3e3', bg: '#c92a2a' },
      warn: { fg: '#3b2f00', bg: '#fcc419' },
      success: { fg: '#0b2410', bg: '#69db7c' }
    }
  },
  {
    id: 'soft',
    english: 'Soft',
    styles: {
      ip: { fg: '#1c7ed6' },
      url: { fg: '#1971c2' },
      email: { fg: '#0c8599' },
      mac: { fg: '#a16207' },
      path: { fg: '#7048e8' },
      error: { fg: '#c92a2a' },
      warn: { fg: '#a16207' },
      success: { fg: '#2f9e44' }
    }
  },
  {
    id: 'mono',
    english: 'Monochrome',
    styles: {
      ip: { fg: '#adb5bd' },
      url: { fg: '#ced4da' },
      email: { fg: '#adb5bd' },
      mac: { fg: '#ced4da' },
      path: { fg: '#adb5bd' },
      error: { fg: '#ff8787' },
      warn: { fg: '#ffd43b' },
      success: { fg: '#8ce99a' }
    }
  }
]

export function isHighlightRuleId(value: unknown): value is HighlightRuleId {
  return HIGHLIGHT_RULES.some((rule) => rule.id === value)
}

export function isHighlightSchemeId(value: unknown): value is HighlightSchemeId {
  return HIGHLIGHT_SCHEMES.some((scheme) => scheme.id === value)
}

/** The styles for a scheme, with every rule present (missing ones paint nothing). */
export function stylesFor(scheme: HighlightSchemeId): Record<HighlightRuleId, HighlightStyle> {
  const found = HIGHLIGHT_SCHEMES.find((entry) => entry.id === scheme)
  if (!found) return stylesFor('classic')
  const out = {} as Record<HighlightRuleId, HighlightStyle>
  for (const rule of HIGHLIGHT_RULES) out[rule.id] = found.styles[rule.id] ?? blank
  return out
}
