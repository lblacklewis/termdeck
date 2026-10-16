import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import type { SharePreview } from '@shared/types'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

/** Kept in step with `MIN_PASSPHRASE` in the main process. */
const MIN_PASSPHRASE = 8

export interface ShareDialogProps {
  mode: 'export' | 'import'
  onClose: () => void
  /** Toast text for the shell to show once the dialog is gone. */
  onMessage: (message: string) => void
}

/**
 * Sharing saved hosts with someone else.
 *
 * Export writes one compressed, encrypted file; import reads one back and merges
 * it. Both live in one component because they are the same conversation from two
 * ends, and because the numbers on the import side have to come from the same plan
 * the import will execute — hence the peek, which runs as soon as a file and a
 * passphrase are both present rather than behind another button.
 */
export function ShareDialog({ mode, onClose, onMessage }: ShareDialogProps): JSX.Element {
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [includePasswords, setIncludePasswords] = useState(true)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  const longEnough = passphrase.trim().length >= MIN_PASSPHRASE
  const matches = passphrase === repeat
  const exportReady = longEnough && matches && !busy

  const runExport = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!exportReady) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.termdeck.exportShare({ passphrase, includeCredentials: includePasswords })
      if (!result.ok) {
        if (!result.cancelled) setError(result.message ?? 'The export failed.')
        return
      }
      onMessage(
        `Exported ${result.sessions} host${result.sessions === 1 ? '' : 's'} and ` +
          `${result.folders} group${result.folders === 1 ? '' : 's'}` +
          (result.withPasswords > 0 ? `, ${result.withPasswords} with passwords` : '') +
          ` — ${Math.max(1, Math.round(result.bytes / 1024))} KB.`
      )
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async (): Promise<void> => {
    setError(null)
    const picked = await window.termdeck.pickShareFile()
    if (!picked.ok) return
    setFilePath(picked.filePath)
    setPreview(null)
  }

  /**
   * Read the file as soon as it can be read.
   *
   * A wrong passphrase and "this is not a share file" are the two things that go
   * wrong here, and both are better said while the user is still in the dialog
   * than after they press Import.
   */
  const peek = useCallback(async (): Promise<void> => {
    if (!filePath || !longEnough) return
    setBusy(true)
    setError(null)
    const result = await window.termdeck.peekShare(filePath, passphrase)
    setBusy(false)
    if (!result.ok) {
      setPreview(null)
      if (!result.cancelled) setError(result.message ?? 'That file could not be read.')
      return
    }
    setPreview(result.preview)
  }, [filePath, longEnough, passphrase])

  useEffect(() => {
    if (mode !== 'import') return
    // Debounced: the passphrase is typed one character at a time, and every peek
    // is a scrypt derivation in the main process.
    const timer = window.setTimeout(() => void peek(), 350)
    return () => window.clearTimeout(timer)
  }, [mode, peek])

  const runImport = async (): Promise<void> => {
    if (!filePath || !longEnough || !preview || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.termdeck.importShare({
        filePath,
        passphrase,
        skipCredentials: preview.hasCredentials && !includePasswords
      })
      if (!result.ok) {
        if (!result.cancelled) setError(result.message ?? 'The import failed.')
        return
      }
      const { added, skipped, folders, reusedFolders, withPasswords } = result.summary
      const parts = [`Imported ${added} host${added === 1 ? '' : 's'}`]
      if (folders > 0) parts.push(`${folders} new group${folders === 1 ? '' : 's'}`)
      if (reusedFolders.length > 0) parts.push(`reused ${reusedFolders.length} existing group${reusedFolders.length === 1 ? '' : 's'}`)
      if (withPasswords > 0) parts.push(`${withPasswords} password${withPasswords === 1 ? '' : 's'}`)
      if (skipped > 0) parts.push(`skipped ${skipped} already saved`)
      onMessage(`${parts.join(' · ')}.`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null

  return (
    <ModalShell onDismiss={onClose} testId="share-dialog">
      <div className="td-modal-head">
        <h2>{mode === 'export' ? 'Export saved hosts' : 'Import saved hosts'}</h2>
        <button className="td-icon-btn" onClick={onClose} title={t('sharedialog.cancel', 'Cancel')}>
          ✕
        </button>
      </div>

      {mode === 'export' ? (
        <form className="td-form" onSubmit={runExport}>
          <p className="td-hint">
            {t('sharedialog.one_file_with_every_group_an', 'One file with every group and host, compressed and encrypted with the passphrase below. Send the passphrase by another route — anyone who has both can read it.')}
          </p>

          <label className="td-field">
            <span>{t('sharedialog.passphrase', 'Passphrase')}</span>
            <input
              ref={firstFieldRef}
              type="password"
              aria-label="share-passphrase"
              data-testid="share-passphrase"
              value={passphrase}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>

          <label className="td-field">
            <span>{t('sharedialog.repeat_passphrase', 'Repeat passphrase')}</span>
            <input
              type="password"
              aria-label="share-passphrase-repeat"
              data-testid="share-confirm"
              value={repeat}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setRepeat(e.target.value)}
            />
            <span className="td-hint">
              {passphrase.length > 0 && !longEnough
                ? `At least ${MIN_PASSPHRASE} characters.`
                : repeat.length > 0 && !matches
                  ? 'The two passphrases do not match.'
                  : `At least ${MIN_PASSPHRASE} characters; it is the only thing protecting the file.`}
            </span>
          </label>

          <label className="td-check">
            <input
              type="checkbox"
              aria-label="include-passwords"
              data-testid="share-include-passwords"
              checked={includePasswords}
              onChange={(e) => setIncludePasswords(e.target.checked)}
            />
            <span>{t('sharedialog.include_saved_passwords_so_t', 'Include saved passwords, so the other person can connect straight away')}</span>
          </label>

          {error && (
            <p className="td-hint td-hint-error" data-testid="share-error">
              {error}
            </p>
          )}

          <div className="td-modal-foot">
            <span className="td-spacer" />
            <button type="button" className="td-btn" onClick={onClose}>
              {t('sharedialog.cancel_2', 'Cancel')}
            </button>
            <button
              type="submit"
              className="td-btn td-btn-primary"
              data-testid="share-submit"
              disabled={!exportReady}
            >
              {busy ? 'Exporting…' : 'Export…'}
            </button>
          </div>
        </form>
      ) : (
        <div className="td-form">
          <p className="td-hint">
            {t('sharedialog.read_a_file_someone_shared_w', 'Read a file someone shared with you. Hosts you already have — same username, host and port — are skipped, and an existing group of the same name is reused.')}
          </p>

          <div className="td-field">
            <span>{t('sharedialog.file', 'File')}</span>
            <div className="td-field-row">
              <button
                type="button"
                className="td-btn"
                data-testid="share-choose-file"
                onClick={() => void chooseFile()}
              >
                {t('sharedialog.choose_file', 'Choose file…')}
              </button>
              <span className="td-hint td-field-grow" data-testid="share-file">
                {fileName ?? 'No file chosen yet.'}
              </span>
            </div>
          </div>

          <label className="td-field">
            <span>{t('sharedialog.passphrase_2', 'Passphrase')}</span>
            <input
              ref={firstFieldRef}
              type="password"
              aria-label="share-passphrase"
              data-testid="share-passphrase"
              value={passphrase}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPassphrase(e.target.value)}
            />
            <span className="td-hint">
              {longEnough
                ? 'The passphrase the file was encrypted with.'
                : `At least ${MIN_PASSPHRASE} characters.`}
            </span>
          </label>

          {preview && (
            <div className="td-share-preview" data-testid="share-preview">
              <strong>
                {preview.sessions} host{preview.sessions === 1 ? '' : 's'} · {preview.folders} group
                {preview.folders === 1 ? '' : 's'}
              </strong>
              <span className="td-hint">
                {preview.duplicates > 0
                  ? `${preview.duplicates} already saved here and will be skipped. `
                  : 'None of these are saved here yet. '}
                {preview.hasCredentials
                  ? `${preview.withPasswords} come with a password. `
                  : 'The file carries no passwords. '}
                {preview.app ? `Exported by ${preview.app}` : ''}
                {preview.exportedAt ? ` on ${preview.exportedAt.slice(0, 10)}.` : ''}
              </span>
              {preview.hasCredentials && (
                <label className="td-check">
                  <input
                    type="checkbox"
                    aria-label="import-passwords"
                    data-testid="share-keep-passwords"
                    checked={includePasswords}
                    onChange={(e) => setIncludePasswords(e.target.checked)}
                  />
                  <span>{t('sharedialog.keep_the_passwords_that_came', 'Keep the passwords that came with it')}</span>
                </label>
              )}
            </div>
          )}

          {busy && !preview && <p className="td-hint">{t('sharedialog.reading', 'Reading…')}</p>}

          {error && (
            <p className="td-hint td-hint-error" data-testid="share-error">
              {error}
            </p>
          )}

          <div className="td-modal-foot">
            <span className="td-spacer" />
            <button type="button" className="td-btn" onClick={onClose}>
              {t('sharedialog.cancel_3', 'Cancel')}
            </button>
            <button
              type="button"
              className="td-btn td-btn-primary"
              data-testid="share-submit"
              disabled={!preview || busy}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : preview ? `Import ${preview.sessions} host${preview.sessions === 1 ? '' : 's'}` : 'Import'}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  )
}
