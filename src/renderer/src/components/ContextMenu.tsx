import { Fragment, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  id: string
  label: string
  /** Rendered after the label, e.g. a shortcut hint. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** A divider is drawn above this item. */
  separatorBefore?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
  /** Distinguishes one menu from another when several could be open. */
  testId?: string
}

/**
 * A small popup menu anchored at a point.
 *
 * Rendered through a portal onto `document.body` rather than where it is used.
 * That matters: any ancestor with a `transform` (a drawer mid-animation, for
 * one) becomes the containing block for `position: fixed`, so a menu nested
 * inside it is offset by that ancestor and lands off-screen. The portal makes
 * the coordinates always viewport-relative.
 *
 * Positioned after mount so it can flip when it would overflow the window, and
 * closed on outside pointer-down, Escape or window resize.
 */
export function ContextMenu({
  x,
  y,
  items,
  onSelect,
  onClose,
  testId = 'context-menu'
}: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y, visible: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const place = (): void => {
      const { width, height } = el.getBoundingClientRect()
      const margin = 6
      const left = Math.min(x, window.innerWidth - width - margin)
      const top = Math.min(y, window.innerHeight - height - margin)
      setPos({ left: Math.max(margin, left), top: Math.max(margin, top), visible: true })
    }

    place()

    // Re-place once any surrounding animation has settled, in case the viewport
    // metrics changed under us.
    const settle = window.setTimeout(place, 260)
    return () => window.clearTimeout(settle)
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase so a click elsewhere closes the menu before it acts.
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('contextmenu', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('contextmenu', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="td-menu"
      role="menu"
      data-testid={testId}
      style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      // A click inside the menu must not reach a dialog backdrop that closes on
      // click. The portal keeps it out of the dialog's DOM, so this is belt and
      // braces rather than load-bearing.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.separatorBefore && <div className="td-menu-sep" />}
          {/* No wrapper element: the button itself must be what a hit test at
              its centre finds, otherwise clicks land on a transparent div. */}
          <button
            className={`td-menu-item${item.danger ? ' is-danger' : ''}`}
            role="menuitem"
            data-menu-id={item.id}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onSelect(item.id)
              onClose()
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="td-menu-hint">{item.hint}</span>}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body
  )
}
