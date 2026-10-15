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
import { closeSftp, closeAllSftp } from './sftp'
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
