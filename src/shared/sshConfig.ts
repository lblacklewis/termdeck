/**
 * Reading an OpenSSH `config` file into importable hosts.
 *
 * The parser is pure: text and callbacks in, data out. The main process owns
 * the file system (see `src/main/ssh/SshConfigFile.ts`); everything that makes
 * a decision about what a config *means* lives here so it can be asserted
 * without an app.
 *
 * Semantics follow OpenSSH's "first obtained value wins" rule:
 *
 *   - `Host` takes one or more pattern-lists (each argument may itself be
 *     comma-separated). A block applies to a name when any positive pattern
 *     matches and no `!`-negated pattern does.
 *   - Blocks are walked in file order — Include directives splice their file's
 *     tokens in exactly where the directive appears — and for every option the
 *     first block that matches and sets it wins. This is what makes the common
 *     `Host *` trailer behave: it fills in `User` / `IdentityFile` for hosts
 *     that did not set their own, and never overrides one that did.
 *   - A block whose pattern list contains at least one *literal* pattern offers
 *     those names as importable hosts. Pattern-only blocks (`Host *`,
 *     `Host web-*`) contribute defaults only: they are rules, not machines.
 *   - Options that appear before the first `Host` line form an implicit block
 *     that matches every name, exactly as `ssh` reads them.
 *
 * Deliberately not implemented, with the consequences written down:
 *
 *   - `Match` blocks are ignored entirely. They condition on the executed
 *     command and the connected user, which an offline import cannot know;
 *     silently applying them would guess wrong.
 *   - `Include` does not expand globs. A literal path, an absolute path, or
 *     `~`-prefixed one is read — and a *relative* path resolves against the
 *     user's `.ssh` directory (the resolver decides where that is), matching
 *     OpenSSH. A pattern like `config.d/*.conf` is left alone rather than
 *     half-guessed.
 *   - Only the first `IdentityFile` is kept, because a TermDeck session holds a
 *     single key path, and OpenSSH would try each in turn.
 */
import type { SshConfigHost } from '@shared/types'

/** How deep Include may nest before a file is left unread. */
export const SSH_CONFIG_INCLUDE_DEPTH = 5

/** Shape of one `Host` block after tokenising. */
interface ConfigBlock {
  /** Every pattern from the Host line, with negation preserved (`!name`). */
  patterns: string[]
  options: Map<string, string>
  /** IdentityFile values in file order; the first that applies wins. */
  identityFiles: string[]
  /** Line of the Host directive in the file that named it (informational). */
  line: number
}

/** A directive flattened across Include files, in reading order. */
interface ConfigDirective {
  keyword: string
  args: string[]
  line: number
}

/** Where an Include file's bytes come from (injected, so this stays pure). */
export type SshConfigIncludeResolver = (
  /** The path exactly as written in the config. */
  raw: string
) => { text: string; path: string } | null

export interface SshConfigParseOptions {
  /** Home directory, used to expand `~` and `%d` in IdentityFile paths. */
  home?: string
  /** Reader for Include directives; omitted means Include is ignored. */
  include?: SshConfigIncludeResolver
}

export interface SshConfigParseResult {
  /** Importable hosts, in file order. */
  hosts: SshConfigHost[]
  /** Host blocks seen, including pattern-only ones. */
  blocks: number
  /** Blocks that carried no literal name (e.g. `Host *`) — defaults only. */
  patternOnlyBlocks: number
  /** Files pulled in through Include, in the order they were read. */
  includes: string[]
}

const DEFAULT_PORT = 22

/**
 * Split one physical line into keyword + arguments.
 *
 * Tokens are whitespace-separated, may be double-quoted, and a `#` outside
 * quotes starts a comment. The `Key=Value` spelling is folded into the same
 * shape here, because OpenSSH accepts it and treating `=` as an ordinary
 * character inside values (ProxyCommand) keeps those readable.
 */
function splitLine(raw: string): { keyword: string; args: string[] } | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const tokens: string[] = []
  let current = ''
  let started = false
  let quoted = false
  const push = (): void => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }

  for (const ch of trimmed) {
    if (quoted) {
      if (ch === '"') quoted = false
      else current += ch
      started = true
      continue
    }
    if (ch === '"') {
      quoted = true
      started = true
      continue
    }
    if (ch === '#') break // comment runs to the end of the line
    if (ch === ' ' || ch === '\t') {
      push()
      continue
    }
    current += ch
    started = true
  }
  if (quoted) return null // an unterminated quote is not something to guess at
  push()
  if (tokens.length === 0) return null

  // `Key=Value`: the keyword carries the first argument glued on by one `=`.
  const glued = tokens[0].indexOf('=')
  if (glued > 0) {
    const rest = tokens[0].slice(glued + 1)
    tokens[0] = tokens[0].slice(0, glued)
    if (rest !== '') tokens.splice(1, 0, rest)
  }
  // `Key = Value`: exactly one `=` standing alone right after the keyword.
  if (tokens[1] === '=') tokens.splice(1, 1)

  const [keyword, ...args] = tokens
  if (!keyword) return null
  return { keyword, args }
}

/** Does one pattern match this name? `*` and `?` wildcards, case-sensitive. */
function patternMatches(pattern: string, name: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  return regex.test(name)
}

/** OpenSSH's rule for a whole pattern-list: any positive hit, no negation hit. */
function patternListApplies(patterns: string[], name: string): boolean {
  let matched = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    if (!body) continue
    if (patternMatches(body, name)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

function isLiteral(pattern: string): boolean {
  return pattern.length > 0 && !pattern.startsWith('!') && !/[*?]/.test(pattern)
}

/** `~` and `%d` stand for the home directory, as the ssh man page promises. */
function expandPath(value: string, home: string | undefined): string {
  const tilde = value.startsWith('~')
  const percent = !tilde && value.startsWith('%d')
  if (!tilde && !percent) return value
  const rest = value.slice(tilde ? 1 : 2)
  if (rest === '') return home ?? ''
  return rest.startsWith('/') || rest.startsWith('\\') ? `${home ?? ''}${rest}` : `${home ?? ''}/${rest}`
}

/** Read one file's directives, splicing Include results in where they appear. */
function collectDirectives(
  text: string,
  options: SshConfigParseOptions,
  visited: Set<string>,
  depth: number,
  includes: string[],
  out: ConfigDirective[]
): void {
  if (depth > SSH_CONFIG_INCLUDE_DEPTH) return

  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = splitLine(lines[index])
    if (!parsed) continue
    const keyword = parsed.keyword.toLowerCase()

    if (keyword === 'include' && options.include) {
      for (const raw of parsed.args) {
        const resolved = options.include(raw)
        if (!resolved) continue
        const key = resolved.path.toLowerCase()
        if (visited.has(key)) continue // a cycle costs nothing but must not recurse
        visited.add(key)
        includes.push(resolved.path)
        collectDirectives(resolved.text, options, visited, depth + 1, includes, out)
      }
      continue
    }

    if (keyword === 'match') {
      // Conditional blocks cannot be evaluated offline; skip to the next Host.
      while (
        index + 1 < lines.length &&
        !(splitLine(lines[index + 1])?.keyword.toLowerCase() === 'host')
      ) {
        index += 1
      }
      continue
    }

    out.push({ keyword, args: parsed.args, line: index + 1 })
  }
}

/**
 * Parse a config file's text into the hosts TermDeck could import.
 *
 * Nothing here throws on odd input: a line that cannot be read is skipped, the
 * way `ssh` itself skips what it does not understand. What matters is that the
 * hosts that *are* returned connect the way `ssh user@alias` would.
 */
export function parseSshConfig(
  text: string,
  options: SshConfigParseOptions = {}
): SshConfigParseResult {
  const directives: ConfigDirective[] = []
  const includes: string[] = []
  // The top-level file is visited by definition; Include guards the rest.
  collectDirectives(text, options, new Set(['config']), 1, includes, directives)

  // ---- group the flat stream into Host blocks ------------------------------
  const blocks: ConfigBlock[] = []
  let current: ConfigBlock | null = null
  const openImplicitBlock = (line: number): ConfigBlock => {
    const implicit: ConfigBlock = { patterns: ['*'], options: new Map(), identityFiles: [], line }
    blocks.push(implicit)
    return implicit
  }

  for (const directive of directives) {
    if (directive.keyword === 'host') {
      current = {
        patterns: directive.args.filter(Boolean),
        options: new Map(),
        identityFiles: [],
        line: directive.line
      }
      blocks.push(current)
      continue
    }
    if (!current) {
      // Options before the first Host line still apply to every host.
      current = openImplicitBlock(directive.line)
    }
    if (directive.keyword === 'identityfile') {
      if (directive.args.length > 0) current.identityFiles.push(directive.args.join(' '))
      continue
    }
    if (directive.args.length === 0) continue
    if (current.options.has(directive.keyword)) continue // within one block, first value wins
    current.options.set(directive.keyword, directive.args.join(' '))
  }

  // ---- importable names and their options ---------------------------------
  const home = options.home
  const hosts: SshConfigHost[] = []
  const seen = new Set<string>()
  let patternOnlyBlocks = 0

  for (const block of blocks) {
    const literals = block.patterns.filter(isLiteral)
    if (literals.length === 0) {
      patternOnlyBlocks += 1
      continue
    }

    for (const alias of literals) {
      if (seen.has(alias)) continue // the first Host line naming a machine wins
      seen.add(alias)

      // First obtained value across every matching block, in reading order.
      const resolved = { hostName: '', user: '', port: 0, identity: '', proxy: '' }
      for (const candidate of blocks) {
        if (!patternListApplies(candidate.patterns, alias)) continue
        if (!resolved.hostName && candidate.options.has('hostname')) {
          resolved.hostName = candidate.options.get('hostname') ?? ''
        }
        if (!resolved.user && candidate.options.has('user')) {
          resolved.user = candidate.options.get('user') ?? ''
        }
        if (!resolved.port && candidate.options.has('port')) {
          const port = Number(candidate.options.get('port'))
          if (Number.isInteger(port) && port >= 1 && port <= 65535) resolved.port = port
        }
        if (!resolved.identity && candidate.identityFiles.length > 0) {
          resolved.identity = candidate.identityFiles[0]
        }
        if (!resolved.proxy) {
          const jump = candidate.options.get('proxyjump')
          const command = candidate.options.get('proxycommand')
          resolved.proxy = jump ?? command ?? ''
        }
      }

      hosts.push({
        alias,
        host: resolved.hostName || alias,
        username: resolved.user || null,
        port: resolved.port || DEFAULT_PORT,
        privateKeyPath: resolved.identity ? expandPath(resolved.identity, home) : null,
        proxy: resolved.proxy || null,
        line: block.line
      })
    }
  }

  return { hosts, blocks: blocks.length, patternOnlyBlocks, includes }
}
