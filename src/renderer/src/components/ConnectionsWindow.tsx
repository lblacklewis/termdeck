import { useEffect, useState, type JSX } from 'react'
import type { SessionInfo } from '@shared/types'
import { ModalShell } from './ModalShell'

interface ConnectionsWindowProps {
  sessions: SessionInfo[]
  activeSessionId: string | null
  onFocus: (sessionId: string) => void
  onCloseSession: (sessionId: string) => void
  /** Closes the window (not the connections). */
  onDismiss: () => void
  /**
   * Rendered inside a Drawer, which already supplies the panel, header and
   * backdrop — so this component skips its own shell.
   */
  embedded?: boolean
}

function formatDuration(from: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * The connections window: one place listing every open connection, with the
 * action that makes sense for each.
 */
export function ConnectionsWindow({
  sessions,
  activeSessionId,
  onFocus,
  onCloseSession,
  onDismiss,
  embedded
}: ConnectionsWindowProps): JSX.Element {
  // Ticks so the summary and durations stay honest without polling IPC.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const sshCount = sessions.filter((s) => s.kind === 'ssh').length
  const localCount = sessions.length - sshCount

  const body = (
    <>
      <div className="td-connections-body">
        <div className="td-connections-summary">
          <span>
            {sessions.length} open · {sshCount} SSH · {localCount} local
          </span>
        </div>

        {sessions.length === 0 && (
          <div className="td-connections-empty">
            No open connections. Double-click a saved session, or press{' '}
            <kbd>Ctrl</kbd>+<kbd>T</kbd> to connect.
          </div>
        )}

        {sessions.length > 0 && (
          <table className="td-connections-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Type</th>
                <th>Connected</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className={session.id === activeSessionId ? 'is-active' : ''}
                  data-session-id={session.id}
                >
                  <td className="td-conn-name">
                    <span className={`td-dot td-dot-${session.kind}`} />
                    {session.title}
                  </td>
                  <td className="td-conn-dim">{session.kind === 'ssh' ? 'SSH' : 'Local'}</td>
                  <td className="td-conn-dim">{formatDuration(session.startedAt)}</td>
                  <td className="td-conn-dim">
                    {session.cols}×{session.rows}
                  </td>
                  <td className="td-conn-actions">
                    <button
                      className="td-btn td-btn-sm"
                      data-action="focus"
                      onClick={() => onFocus(session.id)}
                    >
                      Focus
                    </button>
                    <button
                      className="td-btn td-btn-sm td-btn-danger"
                      data-action="close"
                      onClick={() => onCloseSession(session.id)}
                    >
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="td-drawer-actions">
        <span className="td-spacer" />
        <button className="td-btn" onClick={onDismiss}>
          Close window
        </button>
      </div>
    </>
  )

  if (embedded) return body

  return (
    <ModalShell onDismiss={onDismiss} className="td-modal-wide" testId="connections-window">
      <div className="td-modal-head">
        <h2>Connections</h2>
        <button className="td-icon-btn" onClick={onDismiss} title="Close">
          ✕
        </button>
      </div>
      {body}
    </ModalShell>
  )
}
