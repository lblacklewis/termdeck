import { useMemo, useState, type JSX } from 'react'
import { t } from '../i18n'

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
        <div className="td-page-search-row">
          <span className="td-page-search-icon" aria-hidden="true" />
          <input
            className="td-page-search"
            aria-label="filter-logs"
            placeholder={t('logspage.filter_messages', 'Filter messages')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="td-page-bar">
          <h1 className="td-sr-only">{t('logspage.logs', 'Logs')}</h1>
          <div className="td-page-actions">
            <button className="td-btn" onClick={onClear} disabled={entries.length === 0}>
              {t('logspage.clear', 'Clear')}
            </button>
          </div>
          <div className="td-page-meta">
            <span className="td-page-sub">
              {entries.length} event{entries.length === 1 ? '' : 's'} · {counts.error} error
              {counts.error === 1 ? '' : 's'} · {counts.warn} warning{counts.warn === 1 ? '' : 's'}
            </span>
            <select
              className="td-select td-select-inline"
              aria-label="log-level"
              value={level}
              onChange={(e) => setLevel(e.target.value as typeof level)}
            >
              <option value="all">{t('logspage.all_levels', 'All levels')}</option>
              <option value="info">{t('logspage.info', 'Info')}</option>
              <option value="warn">{t('logspage.warnings', 'Warnings')}</option>
              <option value="error">{t('logspage.errors', 'Errors')}</option>
            </select>
          </div>
        </div>
      </header>

      <div className="td-page-body">
        {entries.length === 0 && (
          <div className="td-page-empty">
            {t('logspage.nothing_logged_yet_connectio', 'Nothing logged yet. Connection attempts, host-key decisions and session exits appear here for this run only — nothing is written to disk.')}
          </div>
        )}

        {entries.length > 0 && visible.length === 0 && (
          <div className="td-page-empty">{t('logspage.no_entry_matches_that_filter', 'No entry matches that filter.')}</div>
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
