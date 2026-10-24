import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'

import type {
  S3Api,
  S3BucketInfo,
  S3Connection,
  S3Listing,
  S3ObjectPreview,
  S3Profile,
  S3Visit
} from '@shared/s3Types'
import {
  buildS3Tree,
  pushS3Visit,
  s3VisitKey,
  s3WorkspaceColumns,
  type S3TreeNode,
  type S3WorkspaceColumns
} from '@shared/s3Layout'
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

/** An ISO instant as the reader's own clock would say it; unparseable text passes through. */
function when(at: string): string {
  const time = Date.parse(at)
  return Number.isFinite(time) ? new Date(time).toLocaleString() : at
}

/** One label/value line of the metadata column. */
function MetaRow(props: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="td-s3-meta-row">
      <span className="td-s3-meta-label">{props.label}</span>
      <span className="td-s3-meta-value">{props.value}</span>
    </div>
  )
}

/**
 * An S3 browser, sized to the job.
 *
 * The reason it is in a terminal app at all: the buckets people need to look
 * inside are usually reachable only from the host they are already logged into
 * (or from a gateway on that network), and configuring an `aws s3` CLI on every
 * jump box is not something anyone wants to do twice.
 *
 * The body is a three-column workspace: the object tree on the left, the open
 * file in the middle where the room is, and the metadata of what is open on the
 * right. Narrow windows stack the same three areas in the same order instead.
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
  /** Result of the last upload or download, e.g. where a file went. */
  const [note, setNote] = useState('')
  /** Recent visits, newest first — persisted through the same store as the profiles. */
  const [history, setHistory] = useState<S3Visit[]>([])
  /**
   * A history entry chosen before the connection is usable: the form has been
   * filled but the secret is not typed yet, so the folder opens right after
   * the next successful connect instead of never.
   */
  const [pending, setPending] = useState<{ bucket: string; prefix: string } | null>(null)
  const [cols, setCols] = useState<S3WorkspaceColumns>(() => s3WorkspaceColumns(window.innerWidth))

  useEffect(() => {
    const onResize = (): void => setCols(s3WorkspaceColumns(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    void api()
      .loadS3State()
      .then((state) => {
        setProfiles(state.profiles)
        setHistory(state.history ?? [])
        if (state.draft) setConnection({ ...state.draft, secretAccessKey: '' })
      })
    return api().onS3StateChanged((state) => {
      setProfiles(state.profiles)
      setHistory(state.history ?? [])
    })
  }, [])

  const set = <K extends keyof S3Connection>(key: K, value: S3Connection[K]): void => {
    setConnection((prev) => ({ ...prev, [key]: value }))
  }

  /** The draft never carries the secret; only a saved profile may. */
  const persist = useCallback(
    async (next: S3Profile[]): Promise<void> => {
      setProfiles(next)
      const { secretAccessKey: _s, sessionToken: _t, ...draft } = connection
      await api().saveS3State({ draft, profiles: next, history })
    },
    [connection, history]
  )

  /**
   * Write one visit into the saved state.
   *
   * Everything the store needs is already in hand — the connection used for the
   * call, the profiles, the history so far — so this is one IPC, one write, one
   * broadcast; the page does not re-read the file to record where it just was.
   */
  const recordVisit = (conn: S3Connection, visitedBucket: string, visitedPrefix: string): void => {
    const { secretAccessKey: _s, sessionToken: _t, ...draft } = conn
    const next = pushS3Visit(history, {
      endpoint: conn.endpoint,
      region: conn.region,
      accessKeyId: conn.accessKeyId,
      pathStyle: conn.pathStyle,
      insecure: conn.insecure,
      bucket: visitedBucket,
      prefix: visitedPrefix,
      at: new Date().toISOString()
    })
    setHistory(next)
    void api().saveS3State({ draft, profiles, history: next })
  }

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
      else {
        setBuckets(result.value ?? [])
        // The folder a history entry pointed at opens now: the connection it
        // needed is the one that just succeeded.
        if (pending && result.value) {
          const target = pending
          setPending(null)
          await openBucketIn(connection, target.bucket, target.prefix)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * List one folder with an explicit connection.
   *
   * The connection is a parameter, not the form state: a history entry may
   * belong to a different endpoint than the one currently in the form, and the
   * visit must be recorded with the connection that actually worked.
   */
  const openBucketIn = async (conn: S3Connection, name: string, at = ''): Promise<void> => {
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
      const result = await api().s3ListObjects(conn, name, {
        prefix: at,
        // A delimiter is what turns a flat key space into the folder view people
        // expect. Without it a bucket with a million keys is one endless list.
        delimiter: '/'
      })
      if (!result.ok) setError(result.error ?? 'Could not list that bucket.')
      else {
        setListing(result.value ?? null)
        recordVisit(conn, name, at)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openBucket = (name: string, at = ''): Promise<void> => {
    setPending(null)
    return openBucketIn(connection, name, at)
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

  /**
   * Send a local file up, as an object under whatever folder is open.
   *
   * The key is the file's own name appended to the current prefix: that is what
   * "upload here" means to everyone, and it keeps the browser's own navigation
   * (the prefix field) as the single place that decides where things land.
   */
  const uploadFile = async (): Promise<void> => {
    const picked = await api().s3PickUpload()
    if (!picked.ok || !picked.filePath) return
    const name = picked.filePath.split(/[\\/]/).pop() ?? 'file'
    const key = `${prefix}${name}`
    setBusy(true)
    setError(null)
    setNote('')
    try {
      const result = await api().s3PutFile(connection, bucket, key, picked.filePath)
      if (!result.ok) setError(result.error ?? 'Could not upload that file.')
      else {
        setNote(`${t('s3page.uploaded', 'Uploaded')} ${key} · ${bytes(result.value?.bytes ?? 0)}`)
        await openBucket(bucket, prefix)
      }
    } finally {
      setBusy(false)
    }
  }

  const downloadFile = async (): Promise<void> => {
    if (!preview) return
    const picked = await api().s3PickDownload(preview.key.split('/').pop() ?? 'object')
    if (!picked.ok || !picked.filePath) return
    setBusy(true)
    setError(null)
    setNote('')
    try {
      const result = await api().s3GetFile(connection, bucket, preview.key, picked.filePath)
      if (!result.ok) setError(result.error ?? 'Could not save that object.')
      else {
        setNote(`${t('s3page.saved', 'Saved')} ${picked.filePath} · ${bytes(result.value?.bytes ?? 0)}`)
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * Go back to a remembered visit.
   *
   * Still connected to the same endpoint with the same key and a secret in
   * memory: the folder opens right away. Anything else — another endpoint, no
   * secret in memory — fills the form and waits: the one thing a history must
   * never do is reuse a secret typed for a different door.
   */
  const revisit = (visit: S3Visit): void => {
    const samePlace =
      connection.endpoint === visit.endpoint &&
      connection.accessKeyId === visit.accessKeyId &&
      connection.secretAccessKey !== ''
    if (samePlace) {
      void openBucket(visit.bucket, visit.prefix)
      return
    }
    setConnection({
      endpoint: visit.endpoint,
      region: visit.region,
      accessKeyId: visit.accessKeyId,
      secretAccessKey: '',
      pathStyle: visit.pathStyle,
      insecure: visit.insecure
    })
    setPending({ bucket: visit.bucket, prefix: visit.prefix })
  }

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    return parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/') + '/'
    }))
  }, [prefix])

  const tree = useMemo(
    () => (buckets ? buildS3Tree(buckets, listing, bucket) : []),
    [buckets, listing, bucket]
  )

  const treeNode = (node: S3TreeNode): JSX.Element => {
    const active =
      (node.kind === 'bucket' && node.path === bucket) ||
      (node.kind === 'folder' && node.path === prefix) ||
      (node.kind === 'object' && preview?.key === node.path)
    const testid = node.kind === 'bucket' ? 's3-bucket' : node.kind === 'folder' ? 's3-prefix' : 's3-object'
    return (
      <li
        key={`${node.kind}:${node.path}`}
        className={`td-sftp-row${node.kind === 'folder' ? ' is-dir' : ''}${active ? ' is-selected' : ''}`}
        data-testid={testid}
        data-bucket={node.kind === 'bucket' ? node.path : undefined}
        data-prefix={node.kind === 'folder' ? node.path : undefined}
        data-key={node.kind === 'object' ? node.path : undefined}
        style={{ paddingLeft: 4 + node.depth * 16 }}
      >
        <button
          className="td-btn td-s3-tree-open"
          type="button"
          onClick={() =>
            node.kind === 'bucket'
              ? void openBucket(node.path)
              : node.kind === 'folder'
                ? void openBucket(bucket, node.path)
                : void openObject(node.path)
          }
        >
          {node.label}
        </button>
        {node.kind === 'object' && (
          <span className="td-page-meta">
            {bytes(node.size ?? 0)} · {node.lastModified}
          </span>
        )}
      </li>
    )
  }

  /** The open object's own row from the listing: the metadata column shows its timestamp. */
  const openObjectRow = useMemo(
    () => (preview && listing ? listing.objects.find((entry) => entry.key === preview.key) : undefined),
    [preview, listing]
  )

  const yesNo = (flag: boolean | undefined): string =>
    t(flag ? 's3page.meta_yes' : 's3page.meta_no', flag ? 'yes' : 'no')

  return (
    <div className="td-page td-s3-page" data-testid="s3-page">
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
              onClick={() => {
                /*
                 * Keyed by id, not by name. Two profiles may point at the same
                 * endpoint with different keys, and a new one has no id yet — so
                 * the only reliable rule is: replace the entry being edited, append
                 * otherwise.
                 */
                const id = profileId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
                const entry: S3Profile = {
                  id,
                  name: connection.endpoint.replace(/^https?:\/\//, ''),
                  endpoint: connection.endpoint,
                  region: connection.region,
                  accessKeyId: connection.accessKeyId,
                  pathStyle: connection.pathStyle,
                  insecure: connection.insecure
                }
                setProfileId(id)
                void persist([...profiles.filter((other) => other.id !== id), entry])
              }}
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

        <div className="td-s3-workspace" data-cols={cols} data-testid="s3-workspace">
          <aside className="td-s3-col td-s3-side">
            {history.length > 0 && (
              <section className="td-s3-recent" data-testid="s3-history">
                <h3 className="td-page-sub">{t('s3page.recent', 'Recent visits')}</h3>
                <ul className="td-sftp-list">
                  {history.map((visit) => (
                    <li
                      key={s3VisitKey(visit)}
                      className="td-sftp-row"
                      data-testid="s3-history-row"
                      data-bucket={visit.bucket}
                      data-prefix={visit.prefix}
                    >
                      <button
                        className="td-btn td-s3-recent-open"
                        type="button"
                        title={visit.endpoint}
                        onClick={() => revisit(visit)}
                      >
                        {visit.bucket}
                        {visit.prefix ? `/${visit.prefix}` : ''}
                      </button>
                      <span className="td-s3-recent-at">{when(visit.at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {buckets === null && history.length === 0 && (
              <p className="td-page-empty">{t('s3page.connect_hint', 'Connect to list the buckets.')}</p>
            )}

            {buckets !== null && (
              <section className="td-section" data-testid="s3-buckets">
                <h2 className="td-page-sub">{t('s3page.buckets', 'Buckets')}</h2>
                {buckets.length === 0 && (
                  <p className="td-page-empty">{t('s3page.no_buckets', 'This account has no buckets.')}</p>
                )}
                {tree.length > 0 && <ul className="td-sftp-list">{tree.map(treeNode)}</ul>}
              </section>
            )}

            {listing && (
              <section className="td-section" data-testid="s3-objects">
                <div className="td-page-bar td-s3-tree-bar">
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
                    <button
                      className="td-btn"
                      data-testid="s3-root"
                      type="button"
                      onClick={() => void openBucket(bucket)}
                    >
                      {t('s3page.root', 'Root')}
                    </button>
                    <button
                      className="td-btn"
                      data-testid="s3-upload"
                      type="button"
                      disabled={busy}
                      onClick={() => void uploadFile()}
                    >
                      {t('s3page.upload', 'Upload a file')}
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
          </aside>

          <main className="td-s3-col td-s3-main" data-testid="s3-content">
            {preview ? (
              <section className="td-section" data-testid="s3-preview">
                <div className="td-page-bar td-s3-tree-bar">
                  <span className="td-pill">{preview.key}</span>
                  <div className="td-page-actions">
                    <button
                      className="td-btn"
                      data-testid="s3-download"
                      type="button"
                      disabled={busy}
                      onClick={() => void downloadFile()}
                    >
                      {t('s3page.download', 'Save as…')}
                    </button>
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
                  className="td-textarea td-s3-preview-fill"
                  data-testid="s3-preview-body"
                  value={uploaded || preview.body}
                  spellCheck={false}
                  onChange={(e) => setUploaded(e.target.value)}
                />
                {uploaded && (
                  <button
                    className="td-btn td-btn-primary td-s3-put"
                    data-testid="s3-put"
                    type="button"
                    onClick={() => void putObject()}
                  >
                    {t('s3page.write', 'Write back')}
                  </button>
                )}
              </section>
            ) : (
              <div className="td-s3-placeholder">
                <p>{t('s3page.no_selection', 'Pick a file from the tree on the left — its contents open here.')}</p>
              </div>
            )}
          </main>

          <aside className="td-s3-col td-s3-meta" data-testid="s3-meta">
            {note && (
              <p className="td-hint" data-testid="s3-transfer-note">
                {note}
              </p>
            )}

            {preview ? (
              <>
                <MetaRow label={t('s3page.meta_key', 'Key')} value={preview.key} />
                <MetaRow label={t('s3page.meta_bucket', 'Bucket')} value={preview.bucket} />
                <MetaRow label={t('s3page.meta_size', 'Size')} value={bytes(preview.size)} />
                {preview.contentType && (
                  <MetaRow label={t('s3page.meta_type', 'Type')} value={preview.contentType} />
                )}
                {openObjectRow?.lastModified && (
                  <MetaRow
                    label={t('s3page.meta_modified', 'Modified')}
                    value={when(openObjectRow.lastModified)}
                  />
                )}
                <MetaRow label={t('s3page.meta_truncated', 'Truncated')} value={yesNo(preview.truncated)} />
              </>
            ) : listing ? (
              <>
                <MetaRow label={t('s3page.meta_bucket', 'Bucket')} value={listing.bucket} />
                <MetaRow
                  label={t('s3page.meta_prefix', 'Prefix')}
                  value={listing.prefix || '/'}
                />
                <MetaRow label={t('s3page.meta_objects', 'Objects')} value={listing.objects.length} />
                <MetaRow label={t('s3page.meta_folders', 'Folders')} value={listing.prefixes.length} />
                <MetaRow label={t('s3page.meta_truncated', 'Truncated')} value={yesNo(listing.truncated)} />
              </>
            ) : buckets ? (
              <>
                <MetaRow label={t('s3page.meta_endpoint', 'Endpoint')} value={connection.endpoint} />
                <MetaRow label={t('s3page.meta_objects', 'Objects')} value={buckets.length} />
              </>
            ) : (
              <>
                <MetaRow label={t('s3page.meta_endpoint', 'Endpoint')} value={connection.endpoint} />
                <MetaRow label={t('s3page.meta_region', 'Region')} value={connection.region} />
                <MetaRow label={t('s3page.meta_access', 'Access key')} value={connection.accessKeyId || '—'} />
                <MetaRow label={t('s3page.meta_pathstyle', 'Path style')} value={yesNo(connection.pathStyle)} />
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}
