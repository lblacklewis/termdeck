/**
 * The S3 page's own state: the connection form (without its secret) and the
 * connections the user chose to keep.
 *
 * A secret is written only when the profile says `rememberSecret`, and it is
 * dropped on the way in as well — a hand-edited file that grew a secret by
 * accident should not turn into a remembered one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { S3Connection, S3PageState, S3Profile } from '@shared/s3Types'

function draft(input: unknown): S3PageState['draft'] {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<S3Connection>
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : ''
  if (!endpoint) return null
  return {
    endpoint,
    region: typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim() : 'us-east-1',
    accessKeyId: typeof raw.accessKeyId === 'string' ? raw.accessKeyId : '',
    pathStyle: raw.pathStyle !== false,
    insecure: raw.insecure === true ? true : undefined
  }
}

function profiles(input: unknown): S3Profile[] {
  if (!Array.isArray(input)) return []
  return input
    .map((entry): S3Profile | null => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Partial<S3Profile>
      const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : ''
      if (!endpoint) return null
      const rememberSecret = raw.rememberSecret === true
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
        name:
          typeof raw.name === 'string' && raw.name.trim()
            ? raw.name.trim()
            : endpoint.replace(/^https?:\/\//, ''),
        endpoint,
        region: typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim() : 'us-east-1',
        accessKeyId: typeof raw.accessKeyId === 'string' ? raw.accessKeyId : '',
        pathStyle: raw.pathStyle !== false,
        insecure: raw.insecure === true ? true : undefined,
        rememberSecret,
        secretAccessKey:
          rememberSecret && typeof raw.secretAccessKey === 'string' && raw.secretAccessKey
            ? raw.secretAccessKey
            : undefined
      }
    })
    .filter((entry): entry is S3Profile => entry !== null)
}

function sanitise(input: unknown): S3PageState {
  if (!input || typeof input !== 'object') return { draft: null, profiles: [] }
  const raw = input as Partial<S3PageState>
  return { draft: draft(raw.draft), profiles: profiles(raw.profiles) }
}

export class S3Store {
  private readonly path: string
  private state: S3PageState

  constructor(configDir: string) {
    this.path = join(configDir, 's3.json')
    this.state = sanitise(this.read())
  }

  private read(): unknown {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  load(): S3PageState {
    return this.state
  }

  save(next: S3PageState): S3PageState {
    this.state = sanitise(next)
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.path)
    return this.state
  }
}
