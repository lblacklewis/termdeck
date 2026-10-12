import { useEffect, type JSX } from 'react'
import { ModalShell } from './ModalShell'

interface QuitConfirmDialogProps {
  /** Live terminal sessions that closing the window would end. */
  sessions: number
  onCancel: () => void
  onConfirm: () => void
}

/**
 * "Are you sure?" before the app closes.
 *
 * Every open pane is a live SSH login or a local shell, and quitting ends all of
 * them at once with no undo — including the ones sitting behind another tab where
 * they are easy to forget. The count is spelled out for that reason.
 *
 * Cancel is the default button and Escape cancels, so a stray Enter or Escape can
 * never be what closes the app.
 */
export function QuitConfirmDialog({
  sessions,
  onCancel,
  onConfirm
}: QuitConfirmDialogProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  return (
    <ModalShell onDismiss={onCancel} testId="quit-confirm">
      <div className="td-modal-head">
        <h2>Quit TermDeck?</h2>
        <button
          className="td-icon-btn"
          title="Cancel"
          data-testid="quit-close"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>

      <p className="td-quit-text" data-testid="quit-detail">
        {sessions > 0
          ? `${sessions} active connection${sessions === 1 ? '' : 's'} will be closed.`
          : 'No connections are open.'}
      </p>
      <p className="td-hint">
        Saved sessions, settings and this window arrangement are kept — only the live
        connections end.
      </p>

      <div className="td-modal-foot">
        <span className="td-spacer" />
        <button
          type="button"
          className="td-btn"
          data-testid="quit-cancel"
          autoFocus
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="td-btn td-btn-danger"
          data-testid="quit-confirm-btn"
          onClick={onConfirm}
        >
          Quit
        </button>
      </div>
    </ModalShell>
  )
}
