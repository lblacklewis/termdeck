import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type AppSettings, type Theme } from '@shared/types'
import { findTheme } from '@shared/themes'

/**
 * Subscribes to the application settings.
 *
 * Panels cannot rely on props for settings: dockview builds each panel through
 * a component factory that captures its arguments once, so a settings change in
 * the parent never reaches an already-open pane. Subscribing per panel keeps
 * live terminals in step with the settings dialog.
 */
export function useSettings(): { settings: AppSettings; theme: Theme } {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    let active = true

    void window.termdeck.loadSettings().then((loaded) => {
      if (active) setSettings(loaded)
    })

    // Fires whenever any window saves settings, including this one.
    const off = window.termdeck.onSettingsChanged(setSettings)
    return () => {
      active = false
      off()
    }
  }, [])

  return { settings, theme: findTheme(settings.theme) }
}
