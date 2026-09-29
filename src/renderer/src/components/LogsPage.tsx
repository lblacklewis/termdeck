import { useMemo, useState, type JSX } from 'react'

export interface LogEntry {
  id: string
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

interface LogsPageProps {
  entries: LogEntry[]
  onClear: () => void
}

/**
 * Activity log for this run.
 *
 * Kept deliberately session-scoped: writing connection history to disk by
 * default would surprise anyone who has not asked for it. The list is trimmed by
 * the producer so it cannot grow without bound.
 */
export function LogsPage({ entries, onClear }: LogsPageProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const [level, setLevel] = useState<'all' | LogEntry['level']>('all')

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return entries.filter((e) => {
      if (level !== 'all' && e.level !== level) return false
      return !needle || e.message.toLowerCase().includes(needle)
    })
  }, [entries, filter, level])

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 }
    for (const e of entries) c[e.level] += 1
    return c
  }, [entries])

  return (
    <div className="td-page" data-testid="logs-page">
      <header className="td-page-head">
        <div>
          <h1>Logs</h1>
          <p className="td-page-sub">
            {entries.length} event{entries.length === 1 ? '' : 's'} · {counts.error} error
            {counts.error === 1 ? '' : 's'} · {counts.warn} warning{counts.warn === 1 ? '' : 's'}
          </p>
        </div>
        <div className="td-page-actions">
          <input
            className="td-page-search"
            aria-label="filter-logs"
            placeholder="Filter messages"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="td-select td-select-inline"
            aria-label="log-level"
            value={level}
            onChange={(e) => setLevel(e.target.value as typeof level)}
          >
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
          </select>
          <button className="td-btn" onClick={onClear} disabled={entries.length === 0}>
            Clear
          </button>
        </div>
      </header>

      <div className="td-page-body">
        {entries.length === 0 && (
          <div className="td-page-empty">
            Nothing logged yet. Connection attempts, host-key decisions and session exits appear
            here for this run only — nothing is written to disk.
          </div>
        )}

        {entries.length > 0 && visible.length === 0 && (
          <div className="td-page-empty">No entry matches that filter.</div>
        )}

        {visible.length > 0 && (
          <ul className="td-log-list" data-testid="log-list">
            {visible.map((entry) => (
              <li key={entry.id} className={`td-log-row is-${entry.level}`}>
                <span className="td-log-time td-mono">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
                <span className={`td-log-level td-log-level-${entry.level}`}>{entry.level}</span>
                <span className="td-log-message">{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
