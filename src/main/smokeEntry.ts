/**
 * CommonJS entry used only by the smoke harnesses.
 *
 * `out/main/index.js` is a self-contained app entry and exports nothing, so the
 * probes need a tiny bridge to the real IPC implementation. Building it from
 * the same source (instead of duplicating handlers) keeps the probe honest.
 */
import { registerIpc, storeAccess } from './ipc'
import { sessionManager } from './sessions/SessionManager'
import { LocalShellBackend, isLocalShellAvailable } from './sessions/LocalShellBackend'
import { SshShellBackend, HostKeyRequiredError } from './sessions/SshShellBackend'
import { CredentialStore } from './store/CredentialStore'
import { SettingsStore, SessionStore } from './store/Stores'
import { KnownHosts, fingerprint } from './ssh/KnownHosts'

export {
  registerIpc,
  storeAccess,
  sessionManager,
  LocalShellBackend,
  isLocalShellAvailable,
  SshShellBackend,
  HostKeyRequiredError,
  CredentialStore,
  SettingsStore,
  SessionStore,
  KnownHosts,
  fingerprint
}
