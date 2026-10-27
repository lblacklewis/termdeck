import { useEffect, useMemo, useState, type JSX } from 'react'
import type { SessionFolder, SshConfigPeekResult } from '@shared/types'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

export interface SshConfigImportDialogProps {
  /** Groups to offer as the import target, parent names already resolved. */
  folders: SessionFolder[]
  onClose: () => void
  /** Toast text for the shell to show once the dialog is gone. */
  onMessage: (message: string) => void
}

interface Row {
  alias: string
  host: string
  username: string | null
  port: number
  privateKeyPath: string | null
  proxy: string | null
  duplicate: boolean
}

/**
 * Importing hosts from this machine's `~/.ssh/config`.
 *
 * The file is read and parsed in the main process; the dialog only decides
 * which of the parsed hosts to take and where to put them. Duplicates — same
 * username, host and port, the same rule the share import uses — are listed
 * but unticked, so importing twice never doubles the tree, while re-ticking
 * one deliberately is still possible.
 */
export function SshConfigImportDialog({
  folders,
  onClose,
  onMessage
}: SshConfigImportDialogProps): JSX.Element {
  const [peek, setPeek] = useState<Extract<SshConfigPeekResult, { ok: true }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [folderId, setFolderId] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await window.termdeck.peekSshConfig()
      if (cancelled) return
      if (!result.ok) {
        setError(result.message)
        return
      }
      setPeek(result)
      // Everything starts selected except what is already saved here.
      const initial: Record<string, boolean> = {}
      for (const host of result.hosts) initial[host.alias] = !host.duplicate
      setChecked(initial)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const rows: Row[] = useMemo(
    () =>
      (peek?.hosts ?? []).map((host) => ({
        alias: host.alias,
        host: host.host,
        username: host.username,
        port: host.port,
        privateKeyPath: host.privateKeyPath,
        proxy: host.proxy,
        duplicate: host.duplicate
      })),
    [peek]
  )

  const chosenCount = rows.filter((row) => checked[row.alias]).length

  const runImport = async (): Promise<void> => {
    if (!peek || busy || chosenCount === 0) return
    setBusy(true)
    setError(null)
    try {
      const chosen = peek.hosts.filter((host) => checked[host.alias])
      const result = await window.termdeck.importSshConfig({
        hosts: chosen,
        folderId: folderId === '' ? null : folderId
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      const { added, skipped } = result.summary
      onMessage(
        t(
          'sshconfigdialog.imported_n_hosts_with_m_ski',
          'Imported {added} host(s), skipped {skipped} already saved.',
          { added, skipped }
        )
      )
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell onDismiss={onClose} testId="sshconfig-dialog">
      <div className="td-modal-head">
        <h2>{t('sshconfigdialog.import_from_ssh_config', 'Import from ~/.ssh/config')}</h2>
        <button className="td-icon-btn" onClick={onClose} title={t('sshconfigdialog.cancel', 'Cancel')}>
          ✕
        </button>
      </div>

      <div className="td-form">
        <p className="td-hint">
          {t(
            'sshconfigdialog.reads_the_machines_openssh',
            'Reads the OpenSSH config on this machine. Hosts already saved — same user, host and port — are listed but unticked.'
          )}
        </p>

        {!peek && !error && (
          <p className="td-hint" data-testid="sshconfig-reading">
            {t('sshconfigdialog.reading', 'Reading…')}
          </p>
        )}

        {error && (
          <p className="td-hint td-hint-error" data-testid="sshconfig-error">
            {error}
          </p>
        )}

        {peek && (
          <>
            <div className="td-field">
              <span>{t('sshconfigdialog.file', 'File')}</span>
              <span className="td-hint" data-testid="sshconfig-path">
                {peek.path}
              </span>
            </div>

            <div className="td-sshconfig-list" data-testid="sshconfig-hosts">
              {rows.length === 0 && (
                <p className="td-hint" data-testid="sshconfig-empty">
                  {t(
                    'sshconfigdialog.no_importable_hosts_in_this',
                    'No importable hosts in this file — only pattern blocks like Host *.'
                  )}
                </p>
              )}
              {rows.map((row) => (
                <label key={row.alias} className="td-check td-sshconfig-row">
                  <input
                    type="checkbox"
                    data-testid="sshconfig-host"
                    data-alias={row.alias}
                    checked={checked[row.alias] ?? false}
                    onChange={(e) =>
                      setChecked((prev) => ({ ...prev, [row.alias]: e.target.checked }))
                    }
                  />
                  <span className="td-sshconfig-name">{row.alias}</span>
                  <span className="td-hint td-sshconfig-target">
                    {row.username ?? '—'}@{row.host}:{row.port}
                  </span>
                  {row.privateKeyPath && (
                    <span className="td-hint td-sshconfig-auth" title={row.privateKeyPath}>
                      {t('sshconfigdialog.key', 'key')}
                    </span>
                  )}
                  {row.duplicate && (
                    <span className="td-hint" data-testid="sshconfig-duplicate">
                      {t('sshconfigdialog.already_saved', 'already saved')}
                    </span>
                  )}
                </label>
              ))}
            </div>

            <label className="td-field">
              <span>{t('sshconfigdialog.import_into_group', 'Import into group')}</span>
              <select
                data-testid="sshconfig-folder"
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
              >
                <option value="">{t('sshconfigdialog.unfiled', 'Unfiled')}</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <div className="td-modal-foot">
          <span className="td-spacer" />
          <button type="button" className="td-btn" onClick={onClose}>
            {t('sshconfigdialog.cancel_2', 'Cancel')}
          </button>
          <button
            type="button"
            className="td-btn td-btn-primary"
            data-testid="sshconfig-submit"
            disabled={!peek || busy || chosenCount === 0}
            onClick={() => void runImport()}
          >
            {busy
              ? t('sshconfigdialog.importing', 'Importing…')
              : t('sshconfigdialog.import_n_hosts', 'Import {n} host(s)', { n: chosenCount })}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
