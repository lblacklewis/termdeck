import { useEffect, useRef, useState, type JSX } from 'react'
import type { TransferInfo } from '@shared/types'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

interface TransfersWindowProps {
  transfers: TransferInfo[]
  onCancel: (id: string) => void
  onClearFinished: () => void
  onDismiss: () => void
}

/** Bytes as something readable at a glance. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return ''
  return formatBytes(Math.round(bytesPerSecond)) + '/s'
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

interface Sample {
  at: number
  done: number
  speed: number
}

/**
 * The transfers window: every file moving in or out, in one place.
 *
 * The SFTP panel can only show what is happening to the session it is looking at, and
 * only while it is on screen — a transfer started in one pane and then navigated away
 * from had nowhere to report. This is that place. Progress comes from the main process,
 * so opening the window mid-transfer shows the real state rather than a bar that starts
 * from wherever the renderer first heard about it.
 *
 * Speed and ETA are derived here from successive readings rather than sent from the
 * main process: they are a property of the *observation*, and a derived value that
 * travels would have to be re-derived anyway to stay honest when the window is closed.
 */
export function TransfersWindow({
  transfers,
  onCancel,
  onClearFinished,
  onDismiss
}: TransfersWindowProps): JSX.Element {
  /*
   * The tick exists only to recompute speed: without it a transfer whose bytes have
   * stopped arriving would keep displaying its last healthy rate forever.
   */
  const [tick, setTick] = useState(0)
  const samples = useRef(new Map<string, Sample>())

  useEffect(() => {
    const timer = window.setInterval(() => {
      const at = Date.now()
      for (const transfer of transfers) {
        if (transfer.status !== 'running') {
          samples.current.delete(transfer.id)
          continue
        }
        const previous = samples.current.get(transfer.id)
        if (!previous || at <= previous.at) {
          samples.current.set(transfer.id, { at, done: transfer.done, speed: 0 })
          continue
        }
        const instant = ((transfer.done - previous.done) * 1000) / (at - previous.at)
        // Smoothed, because a per-chunk rate jitters badly on a slow link.
        const speed = previous.speed > 0 ? previous.speed * 0.6 + instant * 0.4 : instant
        samples.current.set(transfer.id, { at, done: transfer.done, speed: Math.max(0, speed) })
      }
      setTick((value) => value + 1)
    }, 500)
    return () => window.clearInterval(timer)
  }, [transfers])

  const running = transfers.filter((transfer) => transfer.status === 'running')
  const finished = transfers.filter((transfer) => transfer.status !== 'running')
  const totalSpeed = running.reduce(
    (sum, transfer) => sum + (samples.current.get(transfer.id)?.speed ?? 0),
    0
  )
  void tick

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
        <ul className="td-transfers-list" data-testid="transfers-list">
        {transfers.length === 0 && (
          <li className="td-section-empty" data-testid="transfers-empty">
            {t(
              'transfers.empty_hint',
              'Uploads and downloads show up here while they run.'
            )}
          </li>
        )}

        {transfers.map((transfer) => {
          const percent =
            transfer.size > 0
              ? Math.min(100, Math.round((transfer.done / transfer.size) * 100))
              : null
          const speed = samples.current.get(transfer.id)?.speed ?? 0
          const eta =
            transfer.status === 'running' && speed > 0 && transfer.size > transfer.done
              ? (transfer.size - transfer.done) / speed
              : null
          return (
            <li
              key={transfer.id}
              className={`td-transfer is-${transfer.status}`}
              data-testid="transfer-row"
              data-transfer-id={transfer.id}
              data-transfer-kind={transfer.kind}
              data-transfer-status={transfer.status}
            >
              <span className="td-transfer-icon" aria-hidden="true">
                {transfer.kind === 'upload' ? '⭱' : '⭳'}
              </span>

              <div className="td-transfer-body">
                <div className="td-transfer-line">
                  <span className="td-transfer-name" data-testid="transfer-name">
                    {transfer.name}
                  </span>
                  <span className="td-transfer-kind">
                    {transfer.kind === 'upload'
                      ? t('transfers.upload', 'Upload')
                      : t('transfers.download', 'Download')}
                  </span>
                  <span className="td-transfer-host">{transfer.session}</span>
                </div>

                <div
                  className={`td-transfer-bar${percent === null ? ' is-indeterminate' : ''}`}
                  data-testid="transfer-bar"
                  role="progressbar"
                  aria-valuenow={percent ?? undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span
                    className="td-transfer-fill"
                    data-testid="transfer-fill"
                    style={{ width: percent === null ? '100%' : percent + '%' }}
                  />
                </div>

                <div className="td-transfer-meta">
                  <span data-testid="transfer-amount">
                    {transfer.size > 0
                      ? `${formatBytes(transfer.done)} / ${formatBytes(transfer.size)}`
                      : formatBytes(transfer.done)}
                    {percent !== null && ` · ${percent}%`}
                  </span>
                  {transfer.status === 'running' && (
                    <>
                      {speed > 0 && <span data-testid="transfer-speed">{formatSpeed(speed)}</span>}
                      {eta !== null && (
                        <span data-testid="transfer-eta">
                          {t('transfers.eta', '{time} left', { time: formatEta(eta) })}
                        </span>
                      )}
                    </>
                  )}
                  {transfer.status === 'done' && (
                    <span className="td-transfer-ok" data-testid="transfer-status">
                      {t('transfers.done', 'Done')}
                    </span>
                  )}
                  {transfer.status === 'cancelled' && (
                    <span data-testid="transfer-status">
                      {t('transfers.cancelled', 'Cancelled')}
                    </span>
                  )}
                  {transfer.status === 'error' && (
                    <span className="td-transfer-error" data-testid="transfer-status">
                      {transfer.message || t('transfers.failed', 'Failed')}
                    </span>
                  )}
                </div>
              </div>

              {transfer.status === 'running' && (
                <button
                  className="td-btn td-btn-quiet"
                  data-testid="transfer-cancel"
                  onClick={() => onCancel(transfer.id)}
                >
                  {t('transfers.cancel', 'Cancel')}
                </button>
              )}
            </li>
          )
        })}
        </ul>
      </div>

      <div className="td-modal-foot">
        {finished.length > 0 && (
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
