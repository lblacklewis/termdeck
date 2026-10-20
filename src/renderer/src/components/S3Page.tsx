import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'

import type {
  S3Api,
  S3BucketInfo,
  S3Connection,
  S3Listing,
  S3ObjectPreview,
  S3Profile
} from '@shared/s3Types'
import { t } from '../i18n'

/**
 * The API surface, read off the preload bridge.
 *
 * Typed from `S3Api` rather than from `TermDeckApi` so this page can be written
 * and reviewed as one piece; the bridge gains the methods themselves in the
 * commit that wires the feature up.
 */
const api = (): S3Api => window.termdeck as unknown as S3Api

const BLANK_CONNECTION: S3Connection = {
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  accessKeyId: '',
  secretAccessKey: '',
  pathStyle: true
}

/** 1536 → "1.5 KB". Sizes here are read at a glance, not computed with. */
function bytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** The parent prefix of `a/b/c.txt` is `a/b/`; of a folder row, its own parent. */
function parentOf(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? '' : trimmed.slice(0, at + 1)
}

/**
 * An S3 browser, sized to the job.
 *
 * The reason it is in a terminal app at all: the buckets people need to look
 * inside are usually reachable only from the host they are already logged into
 * (or from a gateway on that network), and configuring an `aws s3` CLI on every
 * jump box is not something anyone wants to do twice.
 *
 * What it deliberately is not: a sync tool, a policy editor, or a full object
 * manager. Listing, reading, writing one small text object and deleting is what
 * covers "let me see what is in there" and "let me fix that one file".
 */
export function S3Page(): JSX.Element {
  const [connection, setConnection] = useState<S3Connection>(BLANK_CONNECTION)
  const [profiles, setProfiles] = useState<S3Profile[]>([])
  const [profileId, setProfileId] = useState('')
  const [buckets, setBuckets] = useState<S3BucketInfo[] | null>(null)
  const [bucket, setBucket] = useState('')
  const [listing, setListing] = useState<S3Listing | null>(null)
  const [prefix, setPrefix] = useState('')
  const [preview, setPreview] = useState<S3ObjectPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploaded, setUploaded] = useState('')

  const set = <K extends keyof S3Connection>(key: K, value: S3Connection[K]): void => {
    setConnection((prev) => ({ ...prev, [key]: value }))
  }

  useEffect(() => {
    void api()
      .loadS3State()
      .then((state) => {
        setProfiles(state.profiles)
        if (state.draft) setConnection({ ...state.draft, secretAccessKey: '' })
      })
    return api().onS3StateChanged((state) => setProfiles(state.profiles))
  }, [])

  /** The draft never carries the secret; only a saved profile may. */
  const persist = useCallback(
    async (next: S3Profile[]): Promise<void> => {
      setProfiles(next)
      const { secretAccessKey: _s, sessionToken: _t, ...draft } = connection
      await api().saveS3State({ draft, profiles: next })
    },
    [connection]
  )

  const connect = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setBuckets(null)
    setListing(null)
    setPreview(null)
    try {
      const result = await api().s3ListBuckets(connection)
      if (!result.ok) setError(result.error ?? 'Could not reach that endpoint.')
      else setBuckets(result.value ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openBucket = async (name: string, at = ''): Promise<void> => {
    setBusy(true)
    setError(null)
    setPreview(null)
    // Any edit in progress belonged to the object that was open; carrying it into
    // the next listing and then pressing "write back" would write it to the wrong
    // key, which is the one mistake here that loses data.
    setUploaded('')
    setBucket(name)
    setPrefix(at)
    try {
      const result = await api().s3ListObjects(connection, name, {
        prefix: at,
        // A delimiter is what turns a flat key space into the folder view people
        // expect. Without it a bucket with a million keys is one endless list.
        delimiter: '/'
      })
      if (!result.ok) setError(result.error ?? 'Could not list that bucket.')
      else setListing(result.value ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openObject = async (key: string): Promise<void> => {
    setBusy(true)
    setError(null)
    // A fresh object starts unedited: the draft textarea must show *its* contents,
    // not whatever was being typed for the object opened a minute ago.
    setUploaded('')
    try {
      const result = await api().s3GetObject(connection, bucket, key)
      if (!result.ok) setError(result.error ?? 'Could not read that object.')
      else setPreview(result.value ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeObject = async (key: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await api().s3DeleteObject(connection, bucket, key)
      if (!result.ok) setError(result.error ?? 'Could not delete that object.')
      else {
        setPreview(null)
        await openBucket(bucket, prefix)
      }
    } finally {
      setBusy(false)
    }
  }

  const putObject = async (): Promise<void> => {
    if (!uploaded.trim() || !preview) return
    setBusy(true)
    try {
      const result = await api().s3PutObject(
        connection,
        bucket,
        preview.key,
        uploaded,
        preview.contentType ?? 'text/plain'
      )
      if (!result.ok) setError(result.error ?? 'Could not write that object.')
      else {
        // Re-read it rather than closing the preview: seeing what S3 now holds —
        // not what we hoped we sent — is the point of writing it back at all.
        await openObject(preview.key)
      }
    } finally {
      setBusy(false)
    }
  }

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    return parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/') + '/'
    }))
  }, [prefix])

  return (
    <div className="td-page" data-testid="s3-page">
      <header className="td-page-head">
        <div className="td-page-bar">
          <h1 className="td-page-sub">{t('s3page.title', 'S3')}</h1>
          <div className="td-page-actions">
            <select
              data-testid="s3-profile"
              aria-label={t('s3page.profile', 'Saved connection')}
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value)
                const profile = profiles.find((entry) => entry.id === e.target.value)
                if (!profile) return
                setConnection({
                  endpoint: profile.endpoint,
                  region: profile.region,
                  accessKeyId: profile.accessKeyId,
                  secretAccessKey: profile.rememberSecret ? profile.secretAccessKey ?? '' : '',
                  pathStyle: profile.pathStyle,
                  insecure: profile.insecure
                })
              }}
            >
              <option value="">{t('s3page.no_profile', 'Saved connections…')}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button
              className="td-btn"
              data-testid="s3-profile-save"
              type="button"
              onClick={() =>
                void persist([
                  ...profiles.filter((entry) => entry.name !== connection.endpoint),
                  {
                    id: profileId || `${Date.now().toString(36)}`,
                    name: connection.endpoint.replace(/^https?:\/\//, ''),
                    endpoint: connection.endpoint,
                    region: connection.region,
                    accessKeyId: connection.accessKeyId,
                    pathStyle: connection.pathStyle,
                    insecure: connection.insecure
                  }
                ])
              }
            >
              {t('s3page.keep', 'Keep')}
            </button>
            {profileId && (
              <button
                className="td-btn"
                data-testid="s3-profile-drop"
                type="button"
                onClick={() => {
                  void persist(profiles.filter((entry) => entry.id !== profileId))
                  setProfileId('')
                }}
              >
                {t('s3page.drop', 'Drop')}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="td-page-body">
        <form className="td-drawer-form" data-testid="s3-form" onSubmit={(e) => void connect(e)}>
          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>{t('s3page.endpoint', 'Endpoint')}</span>
              <input
                data-testid="s3-endpoint"
                value={connection.endpoint}
                spellCheck={false}
                placeholder="https://s3.amazonaws.com"
                onChange={(e) => set('endpoint', e.target.value)}
              />
            </label>
            <label className="td-field">
              <span>{t('s3page.region', 'Region')}</span>
              <input
                data-testid="s3-region"
                value={connection.region}
                spellCheck={false}
                onChange={(e) => set('region', e.target.value)}
              />
            </label>
          </div>

          <div className="td-field-row">
            <label className="td-field td-field-grow">
              <span>{t('s3page.access_key', 'Access key')}</span>
              <input
                data-testid="s3-access-key"
                value={connection.accessKeyId}
                spellCheck={false}
                onChange={(e) => set('accessKeyId', e.target.value)}
              />
            </label>
            <label className="td-field td-field-grow">
              <span>{t('s3page.secret_key', 'Secret key')}</span>
              <input
                data-testid="s3-secret-key"
                type="password"
                value={connection.secretAccessKey}
                onChange={(e) => set('secretAccessKey', e.target.value)}
              />
            </label>
          </div>

          <div className="td-field-row">
            <label className="td-field td-field-inline">
              <input
                type="checkbox"
                data-testid="s3-path-style"
                checked={connection.pathStyle}
                onChange={(e) => set('pathStyle', e.target.checked)}
              />
              <span>{t('s3page.path_style', 'Path-style addressing (MinIO, Ceph, IP endpoints)')}</span>
            </label>
            <button className="td-btn td-btn-primary" data-testid="s3-connect" type="submit" disabled={busy}>
              {busy ? t('s3page.working', 'Working…') : t('s3page.connect', 'Connect')}
            </button>
          </div>

          <p className="td-hint">
            {t(
              's3page.secret_hint',
              'The secret key stays in memory for this session and is not written to disk.'
            )}
          </p>
        </form>

        {error && (
          <p className="td-form-error" data-testid="s3-error">
            {error}
          </p>
        )}

        {buckets && (
          <section className="td-section" data-testid="s3-buckets">
            <h2 className="td-page-sub">{t('s3page.buckets', 'Buckets')}</h2>
            {buckets.length === 0 && (
              <p className="td-page-empty">{t('s3page.no_buckets', 'This account has no buckets.')}</p>
            )}
            <ul className="td-sftp-list">
              {buckets.map((entry) => (
                <li key={entry.name} className="td-sftp-row" data-testid="s3-bucket" data-bucket={entry.name}>
                  <button className="td-btn" type="button" onClick={() => void openBucket(entry.name)}>
                    {entry.name}
                  </button>
                  <span className="td-page-meta">{entry.createdAt}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {listing && (
          <section className="td-section" data-testid="s3-objects">
            <div className="td-page-bar">
              <h2 className="td-page-sub">
                {bucket}
                {prefix && `/${prefix}`}
              </h2>
              <div className="td-page-actions">
                {prefix && (
                  <button
                    className="td-btn"
                    data-testid="s3-up"
                    type="button"
                    onClick={() => void openBucket(bucket, parentOf(prefix))}
                  >
                    ↑
                  </button>
                )}
                <button className="td-btn" data-testid="s3-root" type="button" onClick={() => void openBucket(bucket)}>
                  {t('s3page.root', 'Root')}
                </button>
              </div>
            </div>

            {crumbs.length > 0 && (
              <p className="td-page-meta" data-testid="s3-breadcrumb">
                {crumbs.map((crumb) => (
                  <button
                    key={crumb.path}
                    className="td-btn"
                    type="button"
                    onClick={() => void openBucket(bucket, crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </p>
            )}

            <ul className="td-sftp-list">
              {listing.prefixes.map((entry) => (
                <li key={entry} className="td-sftp-row" data-testid="s3-prefix" data-prefix={entry}>
                  <button className="td-btn" type="button" onClick={() => void openBucket(bucket, entry)}>
                    {entry.slice(prefix.length) || entry}
                  </button>
                </li>
              ))}
              {listing.objects.map((entry) => (
                <li key={entry.key} className="td-sftp-row" data-testid="s3-object" data-key={entry.key}>
                  <button className="td-btn" type="button" onClick={() => void openObject(entry.key)}>
                    {entry.key.slice(prefix.length) || entry.key}
                  </button>
                  <span className="td-page-meta">
                    {bytes(entry.size)} · {entry.lastModified}
                  </span>
                </li>
              ))}
            </ul>

            {listing.objects.length === 0 && listing.prefixes.length === 0 && (
              <p className="td-page-empty">{t('s3page.empty_prefix', 'Nothing under this prefix.')}</p>
            )}

            {listing.truncated && (
              <button
                className="td-btn"
                data-testid="s3-more"
                type="button"
                onClick={() => {
                  if (!listing.nextToken) return
                  void api()
                    .s3ListObjects(connection, bucket, {
                      prefix,
                      delimiter: '/',
                      continuationToken: listing.nextToken
                    })
                    .then((result) => {
                      if (result.ok && result.value) {
                        setListing({
                          ...result.value,
                          objects: [...listing.objects, ...result.value.objects],
                          prefixes: [...listing.prefixes, ...result.value.prefixes]
                        })
                      }
                    })
                }}
              >
                {t('s3page.more', 'More')}
              </button>
            )}
          </section>
        )}

        {preview && (
          <section className="td-section" data-testid="s3-preview">
            <div className="td-page-bar">
              <span className="td-pill">{preview.key}</span>
              <span className="td-page-meta">
                {bytes(preview.size)}
                {preview.contentType ? ` · ${preview.contentType}` : ''}
                {preview.truncated ? ` · ${t('s3page.truncated', 'showing the first part')}` : ''}
              </span>
              <div className="td-page-actions">
                <button
                  className="td-btn"
                  data-testid="s3-delete"
                  type="button"
                  onClick={() => void removeObject(preview.key)}
                >
                  {t('s3page.delete', 'Delete')}
                </button>
              </div>
            </div>
            <textarea
              className="td-textarea"
              data-testid="s3-preview-body"
              value={uploaded || preview.body}
              spellCheck={false}
              onChange={(e) => setUploaded(e.target.value)}
            />
            {uploaded && (
              <button className="td-btn td-btn-primary" data-testid="s3-put" type="button" onClick={() => void putObject()}>
                {t('s3page.write', 'Write back')}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
