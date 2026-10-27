/**
 * Reading this machine's OpenSSH `config` file.
 *
 * The parser (`src/shared/sshConfig.ts`) is pure; everything that touches the
 * file system lives here. The path can be overridden with `TERMDECK_SSH_CONFIG`
 * for the same reason `TERMDECK_KNOWN_HOSTS` can: the verification harnesses
 * must be able to drive the flow without reading — or depending on — the
 * developer's real setup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { parseSshConfig, type SshConfigParseResult } from '@shared/sshConfig'

/** Where the user's config is expected, unless the environment says otherwise. */
export function sshConfigPath(): string {
  const override = process.env['TERMDECK_SSH_CONFIG']
  if (override && override.trim() !== '') return override.trim()
  return join(homedir(), '.ssh', 'config')
}

/** Read and parse, or say plainly why there is nothing to import. */
export function readSshConfig():
  | { ok: true; path: string; result: SshConfigParseResult }
  | { ok: false; path: string; message: string } {
  const path = sshConfigPath()
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      message: `There is no SSH config file at ${path}.`
    }
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return {
      ok: false,
      path,
      message: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const sshDir = join(homedir(), '.ssh')
  const parsed = parseSshConfig(text, {
    home: homedir(),
    include: (raw) => {
      // `~`, absolute, or relative — the last resolves against the user's
      // `.ssh` directory, which is OpenSSH's rule for Include paths.
      let candidate = raw
      if (candidate.startsWith('~')) {
        candidate = join(homedir(), candidate.slice(1).replace(/^[/\\]/, ''))
      } else if (!isAbsolute(candidate)) {
        candidate = join(sshDir, candidate)
      }
      if (!existsSync(candidate)) return null // a missing Include is skipped, not fatal
      try {
        return { text: readFileSync(candidate, 'utf8'), path: candidate }
      } catch {
        return null
      }
    }
  })

  /*
   * The config spells paths with forward slashes; Windows home directories come
   * back with backslashes, and `~/.ssh/id` would expand to a half-and-half path.
   * Both work with the file system, but everything downstream — the session
   * editor's field, the key-unreadable error, a probe comparing paths — is
   * better off with one consistent spelling.
   */
  const result: SshConfigParseResult = {
    ...parsed,
    hosts: parsed.hosts.map((host) => ({
      ...host,
      privateKeyPath: host.privateKeyPath ? normalize(host.privateKeyPath) : null
    }))
  }

  return { ok: true, path, result }
}
