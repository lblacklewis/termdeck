import { useEffect, useRef, useState, type JSX } from 'react'
import type { TransferInfo } from '@shared/types'
import { TransferList, formatSpeed, useTransferSpeeds } from './TransferList'
import { t } from '../i18n'

interface TransferBarProps {
  transfers: TransferInfo[]
  onCancel: (id: string) => void
  onClearFinished: () => void
  onOpenWindow: () => void
  onDismiss: () => void
}

/**
 * The transfer strip: one horizontal line above the snippet bar while anything is
 * moving, and the list behind a caret.
 *
 * The window this replaced existed but was not found — its button was one icon among
 * five in the SFTP panel, only visible while that panel happened to be open. A strip
 * that appears *by itself* when a transfer starts, in the one part of the window that
 * is always on screen, cannot be missed the same way. Collapsed it costs one line;
 * expanded it is the same list the window shows.
 *
 * Closing it only hides it: the transfer keeps running, and the next one to start
 * brings the strip back (see the App's effect), so closing it cannot strand a transfer
 * with nothing to watch it.
 */
export function TransferBar({
  transfers,
  onCancel,
  onClearFinished,
  onOpenWindow,
  onDismiss
}: TransferBarProps): JSX.Element {
  const [open, setOpen] = useState(true)
  const speedOf = useTransferSpeeds(transfers)
  const running = transfers.filter((transfer) => transfer.status === 'running')
  const finished = transfers.length - running.length
  const totalSpeed = running.reduce((sum, transfer) => sum + speedOf(transfer.id), 0)

  /**
   * Open for a transfer that has just started, close when the last one ends.
   *
   * Collapsing on finish keeps an expanded list of things that already happened from
   * holding half the screen; opening on start matters because the strip usually exists
   * already (it keeps history), so "appearing" cannot be what announces a new file.
   */
  const seenRunning = useRef<Set<string>>(new Set())
  useEffect(() => {
    const runningIds = running.map((transfer) => transfer.id)
    const started = runningIds.some((id) => !seenRunning.current.has(id))
    seenRunning.current = new Set(runningIds)
    if (started) setOpen(true)
    else if (running.length === 0) setOpen(false)
  }, [transfers])

  return (
    <div
      className={'td-transfer-strip' + (open ? ' is-open' : '')}
      data-testid="transfer-strip"
      data-open={open ? 'true' : 'false'}
    >
      <div className="td-transfer-strip-head">
        <button
          className="td-transfer-strip-toggle"
          data-testid="transfer-strip-toggle"
          aria-expanded={open}
          title={t('transfers.expand', 'Show every transfer')}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="td-transfer-strip-caret" aria-hidden="true">
            {open ? '⌄' : '⌃'}
          </span>
          <span className="td-transfer-strip-title">
            {running.length > 0
              ? t('transfers.running_n', '{n} transferring', { n: running.length })
              : t('transfers.finished_n', '{n} finished', { n: finished })}
          </span>
          {running.length > 0 && totalSpeed > 0 && (
            <span className="td-transfer-strip-speed" data-testid="transfer-strip-speed">
              {formatSpeed(totalSpeed)}
            </span>
          )}
        </button>

        {/*
          The running files, named inline while collapsed: the strip has to answer
          "what is moving" without being opened, or it is just a notification.
        */}
        {running.length > 0 && (
          <span className="td-transfer-strip-chips">
            {running.slice(0, 3).map((transfer) => {
              const percent =
                transfer.size > 0
                  ? Math.min(100, Math.round((transfer.done / transfer.size) * 100))
                  : null
              return (
                <span
                  key={transfer.id}
                  className="td-transfer-chip"
                  data-testid="transfer-chip"
                  title={transfer.kind === 'upload' ? transfer.localPath : transfer.remotePath}
                >
                  <span aria-hidden="true">{transfer.kind === 'upload' ? '⭱' : '⭳'}</span>
                  <span className="td-transfer-chip-name">{transfer.name}</span>
                  <span className="td-transfer-chip-percent">
                    {percent === null ? '…' : percent + '%'}
                  </span>
                </span>
              )
            })}
            {running.length > 3 && (
              <span className="td-transfer-chip">+{running.length - 3}</span>
            )}
          </span>
        )}

        <div className="td-transfer-strip-actions">
          <button
            className="td-icon-btn"
            title={t('transfers.open_window', 'Open the transfers window')}
            data-testid="transfer-strip-window"
            onClick={onOpenWindow}
          >
            ⤢
          </button>
          <button
            className="td-icon-btn"
            title={t('transfers.clear_all', 'Clear every transfer from the list')}
            data-testid="transfer-strip-clear"
            onClick={onClearFinished}
          >
            ⌫
          </button>
          <button
            className="td-icon-btn"
            title={t('transfers.hide_strip', 'Hide this strip (transfers keep running)')}
            data-testid="transfer-strip-close"
            onClick={onDismiss}
          >
            ✕
          </button>
        </div>
      </div>

      {open && (
        <div className="td-transfer-strip-body" data-testid="transfer-strip-body">
          <TransferList transfers={transfers} onCancel={onCancel} compact />
        </div>
      )}
    </div>
  )
}
