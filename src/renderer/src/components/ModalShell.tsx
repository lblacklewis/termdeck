import type { ReactElement, ReactNode } from 'react'

interface ModalShellProps {
  onDismiss: () => void
  /** Extra classes for the dialog itself, e.g. `td-modal-wide`. */
  className?: string
  /** `data-testid` for the dialog element. */
  testId?: string
  children: ReactNode
}

/**
 * Backdrop + dialog wrapper shared by every modal.
 *
 * Dismissal hangs off `click`, not `mousedown`. Closing on mousedown tears the
 * dialog down before the button under the cursor receives its click, which
 * silently broke anything layered inside a modal — most visibly the shortcut
 * list's right-click menu, whose items did nothing at all.
 */
export function ModalShell({ onDismiss, className, testId, children }: ModalShellProps): ReactElement {
  return (
    <div
      className="td-modal-backdrop"
      // Only a click that both starts and ends on the backdrop dismisses, so
      // dragging a selection out of an input does not close the dialog.
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss()
      }}
    >
      <div
        className={`td-modal${className ? ` ${className}` : ''}`}
        data-testid={testId}
        // A click inside the dialog must never reach the backdrop.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>    </div>
  )
}
