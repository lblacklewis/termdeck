import { useEffect, useRef } from 'react'
import type { Keybinding } from '@shared/types'

/**
 * Keybinding parsing and matching.
 *
 * A binding is written as `+`-separated parts, modifiers first, e.g.
 * `Ctrl+Shift+T` or `Ctrl+,`. Matching is case-insensitive on the final part and
 * treats `Cmd`/`Meta`/`Win` as one modifier so bindings stay portable.
 */

interface ParsedBinding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** Lower-cased `KeyboardEvent.key`. */
  key: string
}

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta'
}

export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const parsed: ParsedBinding = { ctrl: false, shift: false, alt: false, meta: false, key: '' }

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      parsed[modifier] = true
      continue
    }
    // The last non-modifier token is the key itself.
    parsed.key = part.toLowerCase()
  }

  return parsed.key ? parsed : null
}

/** Does this event satisfy the binding? */
export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding)
  if (!parsed) return false

  if (event.ctrlKey !== parsed.ctrl) return false
  if (event.shiftKey !== parsed.shift) return false
  if (event.altKey !== parsed.alt) return false
  if (event.metaKey !== parsed.meta) return false

  const key = event.key.toLowerCase()
  return key === parsed.key
}

/** Render a keyboard event as a binding string, for the settings recorder. */
export function formatEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  if (event.metaKey) parts.push('Meta')

  const key = event.key
  // Bare modifier presses are not a complete binding.
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return ''

  const normalised =
    key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
  parts.push(normalised)
  return parts.join('+')
}

/** A binding is only usable if it names at least one key. */
export function isValidBinding(binding: string): boolean {
  return parseBinding(binding) !== null
}

/**
 * A handler may return `false` to decline the key.
 *
 * That is what makes a conditional binding possible: `Ctrl+D` closes a pane whose
 * session has ended, but in a live shell the same key is EOF and must reach the
 * terminal untouched. Without this the dispatcher would consume it either way, and
 * the difference between "closes the pane" and "logs you out" would depend on
 * listener order rather than on an explicit decision.
 */
export type ShortcutHandlers = Record<string, (() => void | boolean) | undefined>

/**
 * Global shortcut dispatcher. Handlers are looked up by binding id, so changing
 * keybindings in settings takes effect without re-registering anything.
 */
export function useShortcuts(keybindings: Keybinding[], handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const bindingsRef = useRef(keybindings)
  bindingsRef.current = keybindings

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const binding of bindingsRef.current) {
        if (!binding.keys) continue
        if (!matchesBinding(event, binding.keys)) continue

        const handler = handlersRef.current[binding.id]
        if (!handler) continue

        if (handler() === false) continue

        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    /*
     * Capture, not bubble.
     *
     * xterm claims keys at its own textarea and stops the event for the ones it
     * handles, so a window listener in the bubble phase never sees them: `Ctrl`+`W`
     * reached the shell as "delete word" and never closed the pane, and `Ctrl`+`D`
     * was EOF — fine — but *any* bound chord that xterm also knows was silently
     * unreachable. Capturing runs before the terminal's own handler, which is what
     * "the app's binding wins" has to mean. A handler that returns `false` still
     * lets the event through to the shell untouched.
     */
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
