/**
 * Which local shell to start, and with what environment.
 *
 * Split out of `LocalShellBackend` and made pure for one reason: macOS has no
 * `$COMSPEC` and no ConPTY, so the interesting part of this decision can only be
 * checked from a machine that is not a Mac. Taking the platform and the
 * environment as arguments — with the file-existence probe injectable — means the
 * darwin branch is a thing the smoke suites can actually prove.
 */
import { existsSync } from 'node:fs'

export interface ShellChoice {
  /** Absolute path of the shell to spawn. */
  shell: string
  args: string[]
  /**
   * Additions to the inherited environment, not a replacement.
   *
   * Empty on Windows: ConPTY sessions already inherit a usable environment, and
   * changing any of it is a way to break a machine that works.
   */
  env: Record<string, string>
}

/**
 * The arguments this shell wants.
 *
 * `-NoLogo` is a PowerShell flag; no POSIX shell understands it, and passing it
 * to zsh would make the login fail. Kept next to the choice so an explicitly
 * configured shell gets the same treatment as the detected one.
 */
export function shellArgs(platform: string, shell: string): string[] {
  if (platform === 'win32' && /powershell|pwsh/i.test(shell)) return ['-NoLogo']
  return []
}

/** Where a Mac's PATH additions live, in the order Homebrew installs them. */
const DARWIN_PATH_ADDITIONS = ['/opt/homebrew/bin', '/usr/local/bin']

/** What macOS and Linux fall back to when `$SHELL` is missing or broken. */
function posixFallbacks(platform: string): string[] {
  return platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : ['/bin/bash', '/bin/sh']
}

/**
 * The environment a POSIX shell needs to behave like it does in Terminal.app.
 *
 * A GUI-launched app on macOS does not inherit a login shell's environment: it
 * gets launchd's minimal PATH and no locale at all. Without this, `brew`-installed
 * commands are "not found" inside TermDeck, and output that is not pure ASCII comes
 * out mangled. Existing values always win — this fills gaps, it does not impose.
 */
function posixEnv(platform: string, env: Record<string, string | undefined>): Record<string, string> {
  const additions: Record<string, string> = {}

  if (!env['TERM']) additions['TERM'] = 'xterm-256color'
  if (!env['LANG'] && !env['LC_ALL']) additions['LANG'] = 'en_US.UTF-8'

  if (platform === 'darwin') {
    const current = (env['PATH'] ?? '').trim()
    const parts = (current || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean)
    const missing = DARWIN_PATH_ADDITIONS.filter((dir) => !parts.includes(dir))
    if (missing.length > 0) additions['PATH'] = [...missing, ...parts].join(':')
  }

  return additions
}

/**
 * Decide the shell for a platform.
 *
 * Windows keeps exactly the rule it always had (`%COMSPEC%`, else PowerShell, plus
 * `-NoLogo` for the PowerShell family). POSIX takes `$SHELL` first and then the
 * platform's usual login shell — on macOS that is zsh, which has been the default
 * since 10.15 — skipping any candidate that is not actually on disk, because a
 * stale `$SHELL` after uninstalling a shell should not leave the user with a pane
 * that cannot start.
 */
export function chooseShell(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean = existsSync
): ShellChoice {
  if (platform === 'win32') {
    const shell = (env['COMSPEC'] ?? '').trim() || 'powershell.exe'
    return { shell, args: shellArgs(platform, shell), env: {} }
  }

  const candidates = [env['SHELL'], ...posixFallbacks(platform)]
  const shell = candidates.find((candidate): candidate is string => !!candidate && exists(candidate))

  return {
    shell: shell ?? '/bin/sh',
    // Never the Windows flag: on a Mac the shell is started as a plain login shell.
    args: [],
    env: posixEnv(platform, env)
  }
}
