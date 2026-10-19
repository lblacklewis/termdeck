import { Suspense, lazy, type JSX } from 'react'

import type { AppSettings, CredentialStatus, LockStatus } from '@shared/types'
import { Drawer } from './Drawer'
import { t } from '../i18n'

/**
 * The settings dialog itself, split out of the shell's chunk.
 *
 * It is only ever on screen when the user asks for it, so it costs a chunk fetch
 * the first time the drawer opens rather than a parse on every start. A named
 * export, hence the `.then`: `lazy` wants a default.
 *
 * The fallback is `null` on purpose, matching the other lazy pages: the dialog
 * owns its own layout, so there is nothing to hold the space with, and a spinner
 * that flashes for one frame is worse than the frame of empty space it replaces.
 */
const SettingsDialog = lazy(() =>
  import('./SettingsDialog').then((m) => ({ default: m.SettingsDialog }))
)

interface SettingsDrawerProps {
  open: boolean
  settings: AppSettings
  credentialStatus: CredentialStatus
  /** Applies a previewed interface scale through the shell (see `SettingsDialog`). */
  onApplyScale: (scale: number) => void
  /** Dismiss the drawer; the shell refreshes the credential summary behind it. */
  onClose: () => void
  onSaved: (settings: AppSettings) => void
  onExportShare: () => void
  onImportShare: () => void
  onCredentialChanged: (status: CredentialStatus) => void
  /** Null until the main process has answered; the dialog needs a definite value. */
  lockStatus: LockStatus | null
  onLockChanged: (status: LockStatus) => void
  onPreviewBreak: () => void
}

/**
 * The settings drawer: the sliding panel plus the dialog wired into it.
 *
 * Moved out of `App` whole. Everything it needs is state the shell already holds
 * and callbacks the shell already owns, so this is a wiring component rather than
 * a second owner: the drawer itself, the `Suspense` boundary around the lazily
 * loaded dialog, and the props it forwards are exactly what the shell rendered
 * inline before.
 */
export function SettingsDrawer({
  open,
  settings,
  credentialStatus,
  onApplyScale,
  onClose,
  onSaved,
  onExportShare,
  onImportShare,
  onCredentialChanged,
  lockStatus,
  onLockChanged,
  onPreviewBreak
}: SettingsDrawerProps): JSX.Element {
  return (
    <Drawer
      open={open}
      size="lg"
      title={t('app.settings_2', 'Settings')}
      testId="settings-drawer"
      onClose={onClose}
    >
      <Suspense fallback={null}>
        <SettingsDialog
          settings={settings}
          credentialStatus={credentialStatus}
          onApplyScale={onApplyScale}
          onClose={onClose}
          onSaved={onSaved}
          onExportShare={onExportShare}
          onImportShare={onImportShare}
          onCredentialChanged={onCredentialChanged}
          lockStatus={lockStatus ?? { hasPassword: false }}
          onLockChanged={onLockChanged}
          onPreviewBreak={onPreviewBreak}
        />
      </Suspense>
    </Drawer>
  )
}
