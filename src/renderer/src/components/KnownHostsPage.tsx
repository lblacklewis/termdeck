import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { KnownHostEntry } from '@shared/types'
import { t } from '../i18n'

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
  /*
   * Multi-select, for the case this page exists for: a batch of hosts was rebuilt
   * and every stored key is stale. Cleaning them up one confirmation at a time was
   * the slow part.
   *
   * The set is pruned to what the filter shows, so "3 selected" always means three
   * rows you can see — a selection that survives a filter change would let the
   * button remove entries the user is no longer looking at.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBatch, setConfirmBatch] = useState(false)

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

  /** Forget everything selected, in one call. */
  const removeSelected = async (): Promise<void> => {
    const targets = visible.filter((entry) => selected.has(key(entry)))
    if (targets.length === 0) return
    setBusy('batch')
    try {
      setEntries(
        await api.removeKnownHostEntries(targets.map((e) => ({ file: e.file, line: e.line })))
      )
      setSelected(new Set())
      setConfirmBatch(false)
      setError(null)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedCount = visible.filter((entry) => selected.has(key(entry))).length
  const allSelected = visible.length > 0 && selectedCount === visible.length

  // Keep the selection honest when the filter narrows the list.
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(visible.map(key))
      const next = new Set([...prev].filter((id) => allowed.has(id)))
      return next.size === prev.size ? prev : next
    })
    setConfirmBatch(false)
  }, [visible])

  const hashedCount = entries.filter((e) => e.hashed).length
  const revokedCount = entries.filter((e) => e.marker === '@revoked').length

  return (
    <div className="td-page" data-testid="known-hosts-page">
      <header className="td-page-head">
        <div className="td-page-search-row">
          <span className="td-page-search-icon" aria-hidden="true" />
          <input
            className="td-page-search"
            aria-label="filter-known-hosts"
            placeholder={t('knownhostspage.filter_by_host_or_fingerprin', 'Filter by host or fingerprint')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="td-page-bar">
          <h1 className="td-sr-only">{t('knownhostspage.known_hosts', 'Known Hosts')}</h1>
          <div className="td-page-actions">
            {selectedCount > 0 &&
              (confirmBatch ? (
                <span className="td-inline-confirm" data-testid="confirm-remove-selected">
                  <button
                    className="td-btn td-btn-danger"
                    data-testid="confirm-remove-selected-yes"
                    disabled={busy === 'batch'}
                    onClick={() => void removeSelected()}
                  >
                    {busy === 'batch'
                      ? t('knownhostspage.removing', 'Removing…')
                      : t('knownhostspage.remove_n_keys', 'Remove {count} keys', { count: selectedCount })}
                  </button>
                  <button className="td-btn" onClick={() => setConfirmBatch(false)}>
                    {t('knownhostspage.cancel', 'Cancel')}
                  </button>
                </span>
              ) : (
                <>
                  <button
                    className="td-btn td-btn-danger"
                    data-testid="forget-selected"
                    disabled={busy !== null}
                    onClick={() => setConfirmBatch(true)}
                  >
                    {t('knownhostspage.forget_selected_n', 'Forget selected ({count})', { count: selectedCount })}
                  </button>
                  <button
                    className="td-btn"
                    data-testid="clear-selection"
                    onClick={() => setSelected(new Set())}
                  >
                    {t('knownhostspage.clear_selection', 'Clear selection')}
                  </button>
                </>
              ))}
            <button className="td-btn" onClick={() => void refresh()} title={t('knownhostspage.reload_from_disk', 'Reload from disk')}>
              {t('knownhostspage.reload', 'Reload')}
            </button>
          </div>
          <div className="td-page-meta">
            <span className="td-page-sub">
              {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
              {hashedCount > 0 && ` · ${hashedCount} hashed`}
              {revokedCount > 0 && ` · ${revokedCount} revoked`}
            </span>
          </div>
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
                <th className="td-cell-check">
                  <input
                    type="checkbox"
                    aria-label={t('knownhostspage.select_all', 'Select all')}
                    data-testid="select-all-entries"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(visible.map(key)))
                    }
                  />
                </th>
                <th>{t('knownhostspage.host', 'Host')}</th>
                <th>{t('knownhostspage.key_type', 'Key type')}</th>
                <th>{t('knownhostspage.fingerprint', 'Fingerprint')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const id = key(entry)
                return (
                  <tr key={id} data-entry-key={id} className={selected.has(id) ? 'is-selected' : undefined}>
                    <td className="td-cell-check">
                      <input
                        type="checkbox"
                        aria-label={t('knownhostspage.select_entry', 'Select')}
                        data-testid="select-entry"
                        data-entry-key={id}
                        checked={selected.has(id)}
                        onChange={() => toggle(id)}
                      />
                    </td>
                    <td>
                      {entry.host ? (
                        <span className="td-mono">{entry.host}</span>
                      ) : (
                        <span className="td-hint" title={t('knownhostspage.openssh_hashed_this_entry_th', 'OpenSSH hashed this entry; the name cannot be recovered')}>
                          {t('knownhostspage.hashed_entry', '(hashed entry)')}
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
                            {t('knownhostspage.cancel', 'Cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          className="td-btn td-btn-sm"
                          data-testid="remove-entry"
                          title={t('knownhostspage.forget_this_key_the_next_con', 'Forget this key; the next connection will ask again')}
                          onClick={() => setConfirming(id)}
                        >
                          {t('knownhostspage.forget', 'Forget')}
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
