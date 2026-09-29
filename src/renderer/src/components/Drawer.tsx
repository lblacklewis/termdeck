import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

interface DrawerProps {
  open: boolean
  title: string
  onClose: () => void
  /** 'md' for forms, 'lg' for settings, 'xl' for table-like content. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Optional button row pinned to the bottom of the drawer. */
  footer?: ReactNode
  testId?: string
  children: ReactNode
}

/**
 * A panel that slides in from the right edge.
 *
 * Used instead of a centred modal for anything the user edits, so the list they
 * were working in stays visible behind it. Dismissal is on backdrop `click` (not
 * `mousedown`) so buttons inside receive their click, and Escape closes it.
 */
export function Drawer({
  open,
  title,
  onClose,
  size = 'md',
  footer,
  testId,
  children
}: DrawerProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // Put focus in the panel so Escape and typing work without a click first.
  useEffect(() => {
    if (!open) return
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button'
    )
    first?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="td-drawer-layer">
      <div className="td-drawer-backdrop" data-testid="drawer-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className={`td-drawer td-drawer-${size}`}
        role="dialog"
        aria-label={title}
        data-testid={testId ?? 'drawer'}
        // Clicks inside must not reach the backdrop.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="td-drawer-head">
          <h2>{title}</h2>
          <button className="td-icon-btn" onClick={onClose} title="Close" data-testid="drawer-close">
            ✕
          </button>
        </div>

        <div className="td-drawer-body">{children}</div>

        {footer && <div className="td-drawer-foot">{footer}</div>}
      </div>
    </div>
  )
}
