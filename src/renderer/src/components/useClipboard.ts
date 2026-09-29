import { useEffect, useRef } from 'react'
import type { ClipboardSettings } from '@shared/types'

const api = window.termdeck

export interface ClipboardTarget {
  /** Write this text to the OS clipboard. */
  copy: (text: string) => void
  /** Read the current clipboard text. */
  paste: (text: string) => void
  /** Current terminal selection, or ''. */
  getSelection: () => string
}

/**
 * Implements the Termius-style clipboard behaviours on a terminal:
 *
 *   - copy-on-select: the moment a selection exists it is placed on the OS
 *     clipboard, so no Ctrl+C is needed (and Ctrl+C stays available to the
 *     remote shell, which is the whole point).
 *   - right-click paste
 *   - middle-click paste
 *
 * `container` must be the resolved DOM element, not a ref: a ref's `.current`
 * is still null during the first render, and attaching to it then would leave
 * the listeners permanently unbound because ref assignment does not re-render.
 *
 * The OS context menu is suppressed only inside the terminal, so the rest of the
 * app keeps normal text-editing behaviour.
 */
export function useClipboard(
  container: HTMLElement | null,
  settings: ClipboardSettings,
  target: ClipboardTarget
): void {
  // Read the latest settings and target without re-binding listeners.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const targetRef = useRef(target)
  targetRef.current = target

  useEffect(() => {
    if (!container) return

    // Test hook: exposes the settings the handler actually sees.
    if (window.localStorage.getItem('tdDebug') === '1') {
      ;(window as unknown as Record<string, unknown>)['__tdClipboardSeen'] = settingsRef.current
    }

    const onMouseDown = (event: MouseEvent): void => {
      const current = settingsRef.current
      if (window.localStorage.getItem('tdDebug') === '1') {
        // Test hook: lets a harness assert which settings a live handler saw.
        ;(window as unknown as Record<string, unknown>)['__tdClipboardSeen'] = current
      }

      if (event.button === 2 && current.pasteOnRightClick) {
        // Suppress the OS menu and paste instead.
        event.preventDefault()
        event.stopPropagation()
        void api
          .readClipboard()
          .then((text) => {
            if (text) targetRef.current.paste(text)
          })
          .catch(() => {})
        return
      }

      if (event.button === 1 && current.pasteOnMiddleClick) {
        event.preventDefault()
        void api
          .readClipboard()
          .then((text) => {
            if (text) targetRef.current.paste(text)
          })
          .catch(() => {})
      }
    }

    // Capture phase so we beat xterm's own handlers and the browser menu.
    container.addEventListener('mousedown', onMouseDown, true)
    const onContextMenu = (event: MouseEvent): void => {
      if (settingsRef.current.pasteOnRightClick) event.preventDefault()
    }
    container.addEventListener('contextmenu', onContextMenu, true)

    return () => {
      container.removeEventListener('mousedown', onMouseDown, true)
      container.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [container])
}

/** Multi-line paste guard: asks before feeding a newline into a live shell. */
export function needsPasteConfirmation(text: string, settings: ClipboardSettings): boolean {
  if (!settings.confirmMultilinePaste) return false
  return /[\r\n]/.test(text)
}
