/**
 * CommonJS entry used only by the smoke harnesses.
 *
 * `out/main/index.js` is a self-contained app entry and exports nothing, so the
 * probes need a tiny bridge to the real IPC implementation. Building it from
 * the same source (instead of duplicating handlers) keeps the probe honest.
 */
import { registerIpc, storeAccess } from './ipc'
import { attachQuitConfirmation, registerQuitIpc, requestQuit, isQuitting } from './quit'
import { attachFocusMode, registerFocusIpc, matchesBinding } from './focus'
import { attachDevShortcuts, removeApplicationMenu } from './shortcuts'
import { closeSftp, closeAllSftp, downloadTo, uploadFrom, type SftpLike } from './sftp'
import { sessionManager } from './sessions/SessionManager'
import { LocalShellBackend, isLocalShellAvailable } from './sessions/LocalShellBackend'
import { SshShellBackend, HostKeyRequiredError } from './sessions/SshShellBackend'
import { CredentialStore } from './store/CredentialStore'
import {
  HistoryStore,
  SettingsStore,
  SessionStore,
  clampBreakMinutes,
  clampScale,
  defaultScaleForWidth
} from './store/Stores'
import { LayoutStore } from './store/LayoutStore'
import { KnownHosts, fingerprint } from './ssh/KnownHosts'
import { parseBatchHosts, BATCH_HOST_LIMIT } from '../shared/batchHosts'
import {
  buildShareDocument,
  packShare,
  planImport,
  ShareError,
  summariseImport,
  unpackShare,
  MIN_PASSPHRASE,
  SHARE_MAGIC,
  SHARE_VERSION
} from './share'

/**
 * The transfer loop, for a probe that needs to show chunks really do overlap.
 *
 * A stand-in SFTP wrapper that answers slowly is the only way to demonstrate the
 * concurrency without a slow network to test on: every strategy measured the same on a
 * link whose speed is capped, so the shape of the loop has to be tested directly.
 */
export function transferAccess(): {
  downloadTo: typeof downloadTo
  uploadFrom: typeof uploadFrom
} {
  return { downloadTo, uploadFrom }
}

export type { SftpLike }

export {
  registerIpc,
  storeAccess,
  attachQuitConfirmation,
  registerQuitIpc,
  requestQuit,
  isQuitting,
  attachFocusMode,
  registerFocusIpc,
  matchesBinding,
  attachDevShortcuts,
  removeApplicationMenu,
  closeSftp,
  closeAllSftp,
  sessionManager,
  LocalShellBackend,
  isLocalShellAvailable,
  SshShellBackend,
  HostKeyRequiredError,
  CredentialStore,
  HistoryStore,
  SettingsStore,
  SessionStore,
  LayoutStore,
  clampBreakMinutes,
  clampScale,
  defaultScaleForWidth,
  KnownHosts,
  fingerprint,
  parseBatchHosts,
  BATCH_HOST_LIMIT,
  buildShareDocument,
  packShare,
  unpackShare,
  planImport,
  summariseImport,
  ShareError,
  MIN_PASSPHRASE,
  SHARE_MAGIC,
  SHARE_VERSION
}
