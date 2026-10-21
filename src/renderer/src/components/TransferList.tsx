import { useEffect, useRef, useState, type JSX } from 'react'
import type { TransferInfo } from '@shared/types'
import { t } from '../i18n'

/** Bytes as something readable at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return ''
  return formatBytes(Math.round(bytesPerSecond)) + '/s'
}

export function formatEta(seconds: number): string {
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
 * Bytes per second per transfer, derived from successive readings.
 *
 * Measured here rather than sent from the main process: a rate is a property of the
 * *observation*, and a value that travelled would have to be derived again anyway to
 * stay honest when nobody was watching. The tick exists because a stalled transfer
 * would otherwise keep displaying its last healthy rate forever.
 */
export function useTransferSpeeds(transfers: TransferInfo[]): (id: string) => number {
  const [, setTick] = useState(0)
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

  return (id: string) => samples.current.get(id)?.speed ?? 0
}

interface TransferListProps {
  transfers: TransferInfo[]
  onCancel: (id: string) => void
  /** Tighter rows for the strip above the snippet bar, which is not a full window. */
  compact?: boolean
}

/**
 * One row per file, shared by the strip and the window.
 *
 * Both surfaces show the same thing, and two copies of "what a transfer looks like"
 * would drift apart the first time one of them changed — so the rows live here and
 * each host only supplies its own frame around them.
 */
export function TransferList({ transfers, onCancel, compact }: TransferListProps): JSX.Element {
  const speedOf = useTransferSpeeds(transfers)

  return (
    <ul
      className={'td-transfers-list' + (compact ? ' is-compact' : '')}
      data-testid="transfers-list"
    >
      {transfers.map((transfer) => {
        const percent =
          transfer.size > 0
            ? Math.min(100, Math.round((transfer.done / transfer.size) * 100))
            : null
        const speed = speedOf(transfer.id)
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
                {!compact && (
                  <span className="td-transfer-kind">
                    {transfer.kind === 'upload'
                      ? t('transfers.upload', 'Upload')
                      : t('transfers.download', 'Download')}
                  </span>
                )}
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
                  <span data-testid="transfer-status">{t('transfers.cancelled', 'Cancelled')}</span>
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
  )
}
