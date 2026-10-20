/**
 * The S3 tool's wire types.
 *
 * Kept in their own module rather than appended to `@shared/types` so that the
 * whole feature can be dropped in one piece: the page, the main-process client
 * and the IPC surface all import from here, and `@shared/types` re-exports what
 * the rest of the app needs to see.
 */

export interface S3Connection {
  /** Base endpoint, e.g. `https://s3.amazonaws.com` or `http://127.0.0.1:9000`. */
  endpoint: string
  region: string
  accessKeyId: string
  /**
   * Only ever held in memory, and never written to the store.
   *
   * The other connection files in this app hold what a *host* needs to reconnect
   * with a click; a cloud key is a different kind of secret — it usually opens
   * more than the one thing you are poking — so it is retyped per session unless
   * the user has deliberately saved it (see `S3Profile`).
   */
  secretAccessKey: string
  sessionToken?: string
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key`. */
  pathStyle: boolean
  insecure?: boolean
}

/** A connection minus its secret: what the store is willing to keep. */
export interface S3Profile {
  id: string
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  pathStyle: boolean
  insecure?: boolean
  /** True only when the user asked for the secret to be remembered. */
  rememberSecret?: boolean
  secretAccessKey?: string
}

export interface S3BucketInfo {
  name: string
  createdAt: string
}

export interface S3ObjectInfo {
  key: string
  size: number
  lastModified: string
  storageClass?: string
}

export interface S3Listing {
  bucket: string
  prefix: string
  objects: S3ObjectInfo[]
  /** Pseudo-directories, when the listing used a delimiter. */
  prefixes: string[]
  truncated: boolean
  nextToken?: string
}

export interface S3ObjectPreview {
  bucket: string
  key: string
  body: string
  size: number
  truncated: boolean
  contentType?: string
}

export interface S3Result<T> {
  ok: boolean
  value?: T
  /** Human-readable reason when `ok` is false. */
  error?: string
  /** The S3 error code, when the far end supplied one. */
  code?: string
}

/** What a native file dialog came back with. */
export interface S3PickResult {
  ok: boolean
  /** True when the user closed the dialog: not a failure. */
  cancelled?: boolean
  filePath?: string
}

export interface S3PageState {
  /** The connection form as it was left, without the secret. */
  draft: Omit<S3Connection, 'secretAccessKey' | 'sessionToken'> | null
  profiles: S3Profile[]
}

/**
 * What the page needs from the main process.
 *
 * Declared here rather than inline in `TermDeckApi` so the whole feature is one
 * import: `TermDeckApi` extends this, the preload implements it, and the page
 * consumes it.
 */
export interface S3Api {
  s3ListBuckets(connection: S3Connection): Promise<S3Result<S3BucketInfo[]>>
  s3ListObjects(
    connection: S3Connection,
    bucket: string,
    options: { prefix?: string; delimiter?: string; continuationToken?: string }
  ): Promise<S3Result<S3Listing>>
  s3GetObject(
    connection: S3Connection,
    bucket: string,
    key: string
  ): Promise<S3Result<S3ObjectPreview>>
  s3PutObject(
    connection: S3Connection,
    bucket: string,
    key: string,
    body: string,
    contentType?: string
  ): Promise<S3Result<null>>
  s3DeleteObject(
    connection: S3Connection,
    bucket: string,
    key: string
  ): Promise<S3Result<null>>
  /** Ask where an object should be written. Cancelling is not an error. */
  s3PickDownload(suggestedName: string): Promise<S3PickResult>
  /** Ask which file to send. */
  s3PickUpload(): Promise<S3PickResult>
  /**
   * Send a local file as an object, and write an object to a local file.
   *
   * Paths rather than dialogs, so the transfer itself can be driven and tested
   * without a native window in the way.
   */
  s3PutFile(
    connection: S3Connection,
    bucket: string,
    key: string,
    localPath: string
  ): Promise<S3Result<{ bytes: number }>>
  s3GetFile(
    connection: S3Connection,
    bucket: string,
    key: string,
    localPath: string
  ): Promise<S3Result<{ bytes: number }>>
  loadS3State(): Promise<S3PageState>
  saveS3State(state: S3PageState): Promise<S3PageState>
  onS3StateChanged(handler: (state: S3PageState) => void): () => void
}
