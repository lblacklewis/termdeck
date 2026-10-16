import { useEffect, type JSX, type ReactNode } from 'react'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

interface ConfirmDialogProps {
  title: string
  /** The body. Plain paragraphs, so the reason is readable rather than implied. */
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** Paints the confirm button as a destructive action. */
  danger?: boolean
  testId?: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * "Are you sure?" for something that cannot be undone.
 *
 * Cancel is focused by default and Escape cancels, so the destructive button can
 * never be reached by a stray Enter or Escape — the same rule the quit dialog
 * follows. The body says *why* it is being asked (how many hosts, how many
 * sub-groups) rather than a bare "are you sure?", because that is the part a
 * person needs to judge.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  testId = 'confirm-dialog',
  onCancel,
  onConfirm
}: ConfirmDialogProps): JSX.Element {
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
    <ModalShell onDismiss={onCancel} testId={testId}>
      <div className="td-modal-head">
        <h2>{title}</h2>
        <button className="td-icon-btn" title={t('confirmdialog.cancel', 'Cancel')} onClick={onCancel}>
          ✕
        </button>
      </div>

      <div className="td-modal-body">{children}</div>

      <div className="td-modal-foot">
        <span className="td-spacer" />
        <button
          type="button"
          className="td-btn"
          data-testid="confirm-cancel"
          autoFocus
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`td-btn ${danger ? 'td-btn-danger' : 'td-btn-primary'}`}
          data-testid="confirm-accept"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  )
}
