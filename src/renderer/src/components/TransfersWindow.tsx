import { type JSX } from 'react'
import type { TransferInfo } from '@shared/types'
import { ModalShell } from './ModalShell'
import { TransferList, formatSpeed, useTransferSpeeds } from './TransferList'
import { t } from '../i18n'

interface TransfersWindowProps {
  transfers: TransferInfo[]
  onCancel: (id: string) => void
  onClearFinished: () => void
  onDismiss: () => void
}

/**
 * The transfers window.
 *
 * Same list as the strip above the snippet bar, with more room: the strip is the thing
 * that is always there, this is the one you open deliberately (`Ctrl+Shift+J`, or the
 * strip's ⤢ button) when there are enough files that a few rows need reading.
 */
export function TransfersWindow({
  transfers,
  onCancel,
  onClearFinished,
  onDismiss
}: TransfersWindowProps): JSX.Element {
  const running = transfers.filter((transfer) => transfer.status === 'running')
  const finished = transfers.length - running.length
  const speedOf = useTransferSpeeds(transfers)
  const totalSpeed = running.reduce((sum, transfer) => sum + speedOf(transfer.id), 0)

  return (
    <ModalShell onDismiss={onDismiss} className="td-modal-wide" testId="transfers-window">
      <div className="td-modal-head">
        <h2>{t('transfers.title', 'File transfers')}</h2>
        <button className="td-icon-btn" title={t('transfers.close', 'Close')} onClick={onDismiss}>
          ✕
        </button>
      </div>

      <div className="td-transfers-summary" data-testid="transfers-summary">
        {running.length > 0
          ? t('transfers.running_n', '{n} transferring', { n: running.length }) +
            (totalSpeed > 0 ? ' · ' + formatSpeed(totalSpeed) : '')
          : t('transfers.idle', 'Nothing is transferring right now.')}
      </div>

      <div className="td-modal-body">
        {transfers.length === 0 ? (
          <ul className="td-transfers-list" data-testid="transfers-list">
            <li className="td-section-empty" data-testid="transfers-empty">
              {t('transfers.empty_hint', 'Uploads and downloads show up here while they run.')}
            </li>
          </ul>
        ) : (
          <TransferList transfers={transfers} onCancel={onCancel} />
        )}
      </div>

      <div className="td-modal-foot">
        {finished > 0 && (
          <button className="td-btn" data-testid="transfers-clear" onClick={onClearFinished}>
            {t('transfers.clear_finished', 'Clear finished')}
          </button>
        )}
        <button className="td-btn td-btn-primary" onClick={onDismiss}>
          {t('transfers.close', 'Close')}
        </button>
      </div>
    </ModalShell>
  )
}
