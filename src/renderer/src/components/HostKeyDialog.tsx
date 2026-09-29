import type { JSX } from 'react'
import type { HostKeyPrompt } from '@shared/types'
import { ModalShell } from './ModalShell'

interface HostKeyDialogProps {
  prompt: HostKeyPrompt
  onTrust: () => void
  onCancel: () => void
}

/**
 * Host-key approval prompt.
 *
 * A *changed* key is presented as a warning rather than a routine confirmation:
 * it is the signature of a man-in-the-middle or a rebuild, and the user has to
 * consciously accept it.
 */
export function HostKeyDialog({ prompt, onTrust, onCancel }: HostKeyDialogProps): JSX.Element {
  const dangerous = prompt.mismatch

  return (
    <ModalShell
      onDismiss={onCancel}
      className={`td-hostkey-modal${dangerous ? ' is-danger' : ''}`}
      testId="hostkey-dialog"
    >
      <div className="td-modal-head">
        <h2>{dangerous ? '⚠ Host key has changed' : 'Unrecognised host key'}</h2>
        <button className="td-icon-btn" onClick={onCancel} title="Cancel">
          ✕
        </button>
      </div>

        <div className="td-hostkey-body">
          <dl className="td-kv">
            <dt>Host</dt>
            <dd>
              {prompt.host}
              {prompt.port !== 22 ? `:${prompt.port}` : ''}
            </dd>
            <dt>Key type</dt>
            <dd>{prompt.keyType}</dd>
            <dt>Fingerprint</dt>
            <dd className="td-mono" data-testid="hostkey-fingerprint">
              {prompt.fingerprint}
            </dd>
            {prompt.previousFingerprint && (
              <>
                <dt>Known key</dt>
                <dd className="td-mono td-danger-text">{prompt.previousFingerprint}</dd>
              </>
            )}
          </dl>

          {dangerous ? (
            <p className="td-hostkey-warning">
              The key presented by this server does not match the one already stored in{' '}
              <code>known_hosts</code>. Someone could be intercepting the connection. Only
              continue if you know why the key changed — for example the server was rebuilt.
            </p>
          ) : (
            <p className="td-hint">
              You have not connected to this host before. Verify the fingerprint against a
              trusted source, then accept to record it in <code>known_hosts</code>.
            </p>
          )}
        </div>

      <div className="td-modal-foot">
        <button className="td-btn" onClick={onCancel} data-testid="hostkey-cancel">
          Cancel
        </button>
        <button
          className={dangerous ? 'td-btn td-btn-danger' : 'td-btn td-btn-primary'}
          onClick={onTrust}
          data-testid="hostkey-trust"
        >
          {dangerous ? 'Replace key and connect' : 'Accept and connect'}
        </button>
      </div>
    </ModalShell>
  )
}
