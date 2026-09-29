import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { KnownHostEntry } from '@shared/types'

const api = window.termdeck

interface KnownHostsPageProps {
  /** Called after the list changes so the app can react (e.g. clear a prompt). */
  onChanged?: () => void
}

/**
 * Browse and delete `known_hosts` entries.
 *
 * Deleting is the fix for the case that actually bites people: a host was
 * rebuilt (or is being impersonated), the stored key no longer matches, and the
 * only way forward used to be editing the file by hand.
 */
export function KnownHostsPage({ onChanged }: KnownHostsPageProps): JSX.Element {
  const [entries, setEntries] = useState<KnownHostEntry[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.listKnownHosts())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const key = (entry: KnownHostEntry): string => `${entry.file}:${entry.line}`

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter(
      (e) =>
        (e.host ?? '').toLowerCase().includes(needle) ||
        e.keyType.toLowerCase().includes(needle) ||
        e.fingerprint.toLowerCase().includes(needle)
    )
  }, [entries, filter])

  const remove = async (entry: KnownHostEntry): Promise<void> => {
    setBusy(key(entry))
    try {
      setEntries(await api.removeKnownHostEntry(entry.file, entry.line))
      setConfirming(null)
      setError(null)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const hashedCount = entries.filter((e) => e.hashed).length
  const revokedCount = entries.filter((e) => e.marker === '@revoked').length

  return (
    <div className="td-page" data-testid="known-hosts-page">
      <header className="td-page-head">
        <div>
          <h1>Known Hosts</h1>
          <p className="td-page-sub">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
            {hashedCount > 0 && ` · ${hashedCount} hashed`}
            {revokedCount > 0 && ` · ${revokedCount} revoked`}
          </p>
        </div>
        <div className="td-page-actions">
          <input
            className="td-page-search"
            aria-label="filter-known-hosts"
            placeholder="Filter by host or fingerprint"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="td-btn" onClick={() => void refresh()} title="Reload from disk">
            Reload
          </button>
        </div>
      </header>

      {error && <div className="td-form-error td-page-error">{error}</div>}

      <div className="td-page-body">
        {visible.length === 0 && (
          <div className="td-page-empty">
            {entries.length === 0
              ? 'No stored host keys yet. They are recorded the first time you accept a host.'
              : 'No entry matches that filter.'}
          </div>
        )}

        {visible.length > 0 && (
          <table className="td-table" data-testid="known-hosts-table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Key type</th>
                <th>Fingerprint</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const id = key(entry)
                return (
                  <tr key={id} data-entry-key={id}>
                    <td>
                      {entry.host ? (
                        <span className="td-mono">{entry.host}</span>
                      ) : (
                        <span className="td-hint" title="OpenSSH hashed this entry; the name cannot be recovered">
                          (hashed entry)
                        </span>
                      )}
                      {entry.marker && <span className="td-pill td-pill-warn">{entry.marker}</span>}
                    </td>
                    <td className="td-mono td-cell-dim">{entry.keyType}</td>
                    <td className="td-mono td-cell-dim td-cell-fp" title={entry.fingerprint}>
                      {entry.fingerprint}
                    </td>
                    <td className="td-cell-right">
                      {confirming === id ? (
                        <span className="td-inline-confirm">
                          <button
                            className="td-btn td-btn-sm td-btn-danger"
                            data-testid="confirm-remove"
                            disabled={busy === id}
                            onClick={() => void remove(entry)}
                          >
                            {busy === id ? 'Removing…' : 'Remove'}
                          </button>
                          <button className="td-btn td-btn-sm" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="td-btn td-btn-sm"
                          data-testid="remove-entry"
                          title="Forget this key; the next connection will ask again"
                          onClick={() => setConfirming(id)}
                        >
                          Forget
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {entries.length > 0 && (
        <footer className="td-page-foot">
          <span className="td-hint td-mono">
            {entries[0].file}
            {new Set(entries.map((e) => e.file)).size > 1 ? ' (+1 more file)' : ''}
          </span>
        </footer>
      )}
    </div>
  )
}
