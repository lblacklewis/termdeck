import { useState, type JSX } from 'react'
import { t } from '../i18n'
import { ModalShell } from './ModalShell'
import { gridColumns, type TileMode } from './tile'

export interface TileCandidate {
  id: string
  title: string
}

interface TileDialogProps {
  /** Every open pane, in the order they are arranged now. */
  panes: TileCandidate[]
  onCancel: () => void
  onApply: (ids: string[], mode: TileMode) => void
}

/**
 * Pick which panes to tile, and how.
 *
 * Everything is ticked to start with, because "tile my windows" almost always means
 * all of them; unticking is the exception, and the count in the button says what is
 * about to happen before it happens.
 */
export function TileDialog({ panes, onCancel, onApply }: TileDialogProps): JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set(panes.map((p) => p.id)))
  const [mode, setMode] = useState<TileMode>('grid')

  /*
   * Built per render, with literal `t()` calls.
   *
   * A module-level table would be translated once, before the language is known —
   * the exact bug the nav rail had. `t()` also needs literal keys for the catalog
   * check to see which entries are alive; a computed key looks unused and gets
   * reported, or worse, deleted.
   */
  const modes: { id: TileMode; label: string; hint: string }[] = [
    {
      id: 'grid',
      label: t('tiledialog.mode_grid', '瓷砖排列'),
      hint: t('tiledialog.mode_grid_hint', '自动分成接近方形的网格')
    },
    {
      id: 'columns',
      label: t('tiledialog.mode_columns', '竖屏分割'),
      hint: t('tiledialog.mode_columns_hint', '左右并排，每列占满高度')
    },
    {
      id: 'rows',
      label: t('tiledialog.mode_rows', '横屏分割'),
      hint: t('tiledialog.mode_rows_hint', '上下排列，每行占满宽度')
    }
  ]

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = panes.filter((p) => selected.has(p.id))
  const columns = gridColumns(chosen.length)
  const preview =
    chosen.length < 2
      ? t('tiledialog.pick_two', 'Pick at least two panes.')
      : mode === 'grid'
        ? t('tiledialog.preview_grid', '{count} panes · {cols} × {rows}', {
            count: chosen.length,
            cols: columns,
            rows: Math.ceil(chosen.length / columns)
          })
        : mode === 'columns'
          ? t('tiledialog.preview_columns', '{count} columns', { count: chosen.length })
          : t('tiledialog.preview_rows', '{count} rows', { count: chosen.length })

  return (
    <ModalShell onDismiss={onCancel} testId="tile-dialog">
      <div className="td-modal-head">
        <h2>{t('tiledialog.title', 'Arrange panes')}</h2>
        <button
          className="td-icon-btn"
          title={t('tiledialog.cancel', 'Cancel')}
          onClick={onCancel}
        >
          ✕
        </button>
      </div>

      <div className="td-modal-body">
        <div className="td-field-stack">
          <div className="td-field">
            <span>{t('tiledialog.windows', 'Panes')}</span>
            <div className="td-tile-list" data-testid="tile-list">
              {panes.map((pane) => (
                <label className="td-check" key={pane.id} data-pane={pane.id}>
                  <input
                    type="checkbox"
                    data-testid="tile-pane"
                    checked={selected.has(pane.id)}
                    onChange={() => toggle(pane.id)}
                  />
                  <span>{pane.title}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="td-field">
            <span>{t('tiledialog.mode', 'Layout')}</span>
            <div className="td-tile-modes" data-testid="tile-modes">
              {modes.map((entry) => (
                <label
                  className={'td-tile-mode' + (mode === entry.id ? ' is-active' : '')}
                  key={entry.id}
                  data-mode={entry.id}
                >
                  <input
                    type="radio"
                    name="tile-mode"
                    data-testid={'tile-mode-' + entry.id}
                    checked={mode === entry.id}
                    onChange={() => setMode(entry.id)}
                  />
                  <span>
                    <strong>{entry.label}</strong>
                    <em className="td-hint">{entry.hint}</em>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <p className="td-hint" data-testid="tile-preview">
            {preview}
          </p>
        </div>
      </div>

      <div className="td-modal-foot">
        <span className="td-spacer" />
        <button type="button" className="td-btn" data-testid="tile-cancel" onClick={onCancel}>
          {t('tiledialog.cancel', 'Cancel')}
        </button>
        <button
          type="button"
          className="td-btn td-btn-primary"
          data-testid="tile-apply"
          disabled={chosen.length < 2}
          onClick={() => onApply(chosen.map((p) => p.id), mode)}
        >
          {t('tiledialog.apply', 'Arrange {count} panes', { count: chosen.length })}
        </button>
      </div>
    </ModalShell>
  )
}
