import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { RestHeader, RestRequest, RestResponse, SavedRestRequest } from '@shared/types'
import { REST_TEMPLATES } from '@shared/restTemplates'
import { t } from '../i18n'

const METHODS: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const EMPTY: RestRequest = {
  method: 'GET',
  url: '',
  headers: [],
  body: ''
}

/** Bodies longer than this are folded to the first screenful. */
const FOLD_AFTER = 400

/** Pretty-print when the answer is JSON; otherwise hand back what arrived. */
function present(body: string): string {
  const trimmed = body.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return body
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    // Truncated or not really JSON: showing it unchanged is more honest than an
    // error about parsing something the user did not ask to parse.
    return body
  }
}

/**
 * A deliberately small REST client.
 *
 * The reason it exists rather than "just use curl": the services worth poking
 * from a terminal session are usually reachable only from the machine you are
 * logged into, and the app already has that connection. The request itself goes
 * through the main process (see `src/main/rest.ts`) — from the page it would be
 * blocked by CORS.
 *
 * What it deliberately is not: a collection manager, an environment/variable
 * system, or a test runner. Templates are starting points you edit in place; the
 * saved list is a handful of requests you named, not a folder tree.
 */
export function RestPage(): JSX.Element {
  const [request, setRequest] = useState<RestRequest>(EMPTY)
  const [response, setResponse] = useState<RestResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [saved, setSaved] = useState<SavedRestRequest[]>([])
  const [savedId, setSavedId] = useState('')
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  /** Draft writes are debounced: typing a URL must not hit the disk per key. */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<RestRequest>(EMPTY)
  const savedRef = useRef<SavedRestRequest[]>([])

  draftRef.current = request
  savedRef.current = saved

  useEffect(() => {
    void window.termdeck.loadRestState().then((state) => {
      setSaved(state.saved)
      if (state.draft) setRequest(state.draft)
    })
    return window.termdeck.onRestStateChanged((state) => setSaved(state.saved))
  }, [])

  /** Write the draft once the user stops typing. */
  const rememberDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      void window.termdeck.saveRestState({ draft: draftRef.current, saved: savedRef.current })
    }, 400)
  }, [])

  const update = useCallback(
    (next: RestRequest) => {
      setRequest(next)
      rememberDraft()
    },
    [rememberDraft]
  )

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id)
      setSavedId('')
      const template = REST_TEMPLATES.find((entry) => entry.id === id)
      if (!template) {
        /*
         * "Blank request" has to mean blank. Leaving the previous template's URL
         * in the form while the menu says otherwise is the kind of small lie that
         * makes someone send a request they did not mean to send.
         */
        update({ ...EMPTY, headers: [] })
        setResponse(null)
        return
      }
      // A copy: editing a loaded template must not rewrite the catalog, or the
      // next person to pick it gets somebody else's half-finished request.
      update({
        method: template.request.method,
        url: template.request.url,
        headers: template.request.headers.map((header) => ({ ...header })),
        body: template.request.body ?? ''
      })
      setResponse(null)
    },
    [update]
  )

  const applySaved = useCallback(
    (id: string) => {
      setSavedId(id)
      setTemplateId('')
      const entry = saved.find((item) => item.id === id)
      if (!entry) return
      update({ ...entry.request, headers: entry.request.headers.map((h) => ({ ...h })) })
      setResponse(null)
    },
    [saved, update]
  )

  const persistSaved = useCallback(async (next: SavedRestRequest[]): Promise<void> => {
    setSaved(next)
    // The draft goes with it: the store keeps one file, so a write that only
    // touched the list would drop whatever is on screen.
    await window.termdeck.saveRestState({ draft: draftRef.current, saved: next })
  }, [])

  const saveCurrent = async (): Promise<void> => {
    if (!request.url.trim()) return
    const existing = saved.find((entry) => entry.id === savedId)
    const name = existing?.name ?? request.url.trim()
    const id = existing?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const entry: SavedRestRequest = { id, name, request: { ...request } }
    const next = existing ? saved.map((item) => (item.id === id ? entry : item)) : [...saved, entry]
    setSavedId(id)
    await persistSaved(next)
  }

  const removeSaved = async (): Promise<void> => {
    if (!savedId) return
    await persistSaved(saved.filter((entry) => entry.id !== savedId))
    setSavedId('')
  }

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setResponse(null)
    setSearch('')
    setShowAll(false)
    try {
      setResponse(await window.termdeck.sendRestRequest(request))
    } catch (err) {
      setResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        size: 0
      })
    } finally {
      setBusy(false)
    }
  }

  const setHeader = (index: number, patch: Partial<RestHeader>): void => {
    update({
      ...request,
      headers: request.headers.map((header, at) => (at === index ? { ...header, ...patch } : header))
    })
  }

  /**
   * The same request as a `curl` line.
   *
   * The reason this exists next to a working client: the interesting moment is
   * when something works here and has to be reproduced somewhere else — a runbook,
   * a colleague's machine, a container. Retyping a signed-looking request by hand
   * is how you end up wondering why it behaves differently there.
   */
  const asCurl = useMemo((): string => {
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
    const parts = [`curl -X ${request.method}`, quote(request.url)]
    for (const header of request.headers) {
      if (!header.name.trim()) continue
      parts.push(`-H ${quote(`${header.name}: ${header.value}`)}`)
    }
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      parts.push(`--data ${quote(request.body)}`)
    }
    if (request.insecure) parts.push('--insecure')
    return parts.join(' \\\n  ')
  }, [request])

  const [flash, setFlash] = useState('')

  const copyCurl = async (): Promise<void> => {
    await window.termdeck.copyToClipboard(asCurl)
    setFlash('copied')
    setTimeout(() => setFlash(''), 1600)
  }

  /** Pretty-print the request body, or say why it cannot be. */
  const formatBody = (): void => {
    const body = request.body ?? ''
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2)
      update({ ...request, body: pretty })
      setFlash('formatted')
    } catch {
      setFlash('bad-json')
    }
    setTimeout(() => setFlash(''), 2000)
  }

  const status = useMemo(() => {
    if (!response) return ''
    if (!response.ok) return response.error ?? 'The request failed.'
    return `${response.status} ${response.statusText ?? ''}`.trim()
  }, [response])

  /** The body, folded and filtered. Both are view concerns, not transport ones. */
  const shown = useMemo(() => {
    if (!response?.ok) return { text: '', lines: 0, matches: 0 }
    const all = present(response.body ?? '').split('\n')
    if (search.trim()) {
      const needle = search.trim().toLowerCase()
      const hits = all.filter((line) => line.toLowerCase().includes(needle))
      return { text: hits.join('\n'), lines: all.length, matches: hits.length }
    }
    if (all.length > FOLD_AFTER && !showAll) {
      return { text: all.slice(0, FOLD_AFTER).join('\n'), lines: all.length, matches: 0 }
    }
    return { text: all.join('\n'), lines: all.length, matches: 0 }
  }, [response, search, showAll])

  return (
    <div className="td-page" data-testid="rest-page">
      <header className="td-page-head">
        <div className="td-page-bar">
          <h1 className="td-page-sub">{t('restpage.title', 'REST')}</h1>
          <div className="td-page-actions">
            <select
              data-testid="rest-template"
              aria-label={t('restpage.template', 'Template')}
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
            >
              <option value="">{t('restpage.blank', 'Blank request')}</option>
              {REST_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
            <select
              data-testid="rest-saved"
              aria-label={t('restpage.saved', 'Saved requests')}
              value={savedId}
              onChange={(e) => applySaved(e.target.value)}
            >
              <option value="">{t('restpage.no_saved', 'Saved requests…')}</option>
              {saved.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button
              className="td-btn"
              data-testid="rest-save-saved"
              type="button"
              onClick={() => void saveCurrent()}
            >
              {savedId ? t('restpage.update', 'Update') : t('restpage.keep', 'Keep')}
            </button>
            {savedId && (
              <button
                className="td-btn"
                data-testid="rest-delete-saved"
                type="button"
                onClick={() => void removeSaved()}
              >
                {t('restpage.drop', 'Drop')}
              </button>
            )}
          </div>
        </div>
        <p className="td-page-meta" data-testid="rest-template-hint">
          {templateId
            ? REST_TEMPLATES.find((entry) => entry.id === templateId)?.description
            : t(
                'restpage.hint',
                'Requests are sent from the app, so local services work even though the window is not a web page.'
              )}
        </p>
      </header>

      <div className="td-page-body">
        <form className="td-drawer-form" data-testid="rest-form" onSubmit={(e) => void send(e)}>
          <div className="td-field-row">
            <label className="td-field">
              <span>{t('restpage.method', 'Method')}</span>
              <select
                data-testid="rest-method"
                value={request.method}
                onChange={(e) =>
                  update({ ...request, method: e.target.value as RestRequest['method'] })
                }
              >
                {METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </label>
            <label className="td-field td-field-grow">
              <span>{t('restpage.url', 'URL')}</span>
              <input
                data-testid="rest-url"
                value={request.url}
                spellCheck={false}
                placeholder="http://127.0.0.1:8080/health"
                onChange={(e) => update({ ...request, url: e.target.value })}
              />
            </label>
            <button
              className="td-btn td-btn-primary"
              data-testid="rest-send"
              type="submit"
              disabled={busy}
            >
              {busy ? t('restpage.sending', 'Sending…') : t('restpage.send', 'Send')}
            </button>
            <button
              className="td-btn"
              data-testid="rest-copy-curl"
              type="button"
              onClick={() => void copyCurl()}
            >
              {t('restpage.copy_curl', 'Copy as cURL')}
            </button>
            {flash === 'copied' && (
              <span className="td-page-meta" data-testid="rest-copied">
                {t('restpage.copied', 'Copied')}
              </span>
            )}
          </div>

          <div className="td-field-row">
            <label className="td-field">
              <span>{t('restpage.timeout', 'Timeout (s)')}</span>
              <input
                data-testid="rest-timeout"
                inputMode="numeric"
                value={String(Math.round((request.timeoutMs ?? 15000) / 1000))}
                onChange={(e) => {
                  const seconds = Number(e.target.value)
                  update({
                    ...request,
                    timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
                  })
                }}
              />
            </label>
            <label className="td-field td-field-inline">
              <input
                type="checkbox"
                data-testid="rest-insecure"
                checked={request.insecure === true}
                onChange={(e) => update({ ...request, insecure: e.target.checked === true })}
              />
              <span>{t('restpage.insecure', 'Accept a self-signed certificate')}</span>
            </label>
          </div>

          <div className="td-field">
            <span>{t('restpage.headers', 'Headers')}</span>
            <div data-testid="rest-headers">
              {request.headers.map((header, index) => (
                <div className="td-field-row" key={index}>
                  <input
                    data-testid="rest-header-name"
                    value={header.name}
                    placeholder="Content-Type"
                    onChange={(e) => setHeader(index, { name: e.target.value })}
                  />
                  <input
                    className="td-field-grow"
                    data-testid="rest-header-value"
                    value={header.value}
                    placeholder="application/json"
                    onChange={(e) => setHeader(index, { value: e.target.value })}
                  />
                  <button
                    className="td-btn"
                    type="button"
                    data-testid="rest-header-remove"
                    onClick={() =>
                      update({
                        ...request,
                        headers: request.headers.filter((_, at) => at !== index)
                      })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className="td-btn"
              type="button"
              data-testid="rest-header-add"
              onClick={() =>
                update({ ...request, headers: [...request.headers, { name: '', value: '' }] })
              }
            >
              {t('restpage.add_header', 'Add header')}
            </button>
          </div>

          <div className="td-field">
            <span className="td-field-row">
              <span>{t('restpage.body', 'Body')}</span>
              <button
                className="td-btn"
                data-testid="rest-format"
                type="button"
                onClick={() => formatBody()}
              >
                {t('restpage.format', 'Format JSON')}
              </button>
              {flash === 'bad-json' && (
                <span className="td-form-error" data-testid="rest-format-error">
                  {t('restpage.not_json', 'That body is not JSON.')}
                </span>
              )}
            </span>
            <textarea
              className="td-textarea"
              data-testid="rest-body"
              value={request.body ?? ''}
              spellCheck={false}
              placeholder={t('restpage.body_placeholder', 'Only sent with POST, PUT and PATCH')}
              onChange={(e) => update({ ...request, body: e.target.value })}
            />
          </div>
        </form>

        <section className="td-section" data-testid="rest-response">
          <div className="td-page-bar">
            <span className="td-pill" data-testid="rest-status">
              {status || t('restpage.no_response', 'No response yet')}
            </span>
            {response?.ok && (
              <span className="td-page-meta" data-testid="rest-meta">
                {response.durationMs} ms · {response.size} B
                {response.finalUrl && response.finalUrl !== request.url
                  ? ` · ${response.finalUrl}`
                  : ''}
              </span>
            )}
            {response?.ok && (
              <span className="td-page-actions">
                <input
                  data-testid="rest-search"
                  value={search}
                  spellCheck={false}
                  aria-label={t('restpage.search', 'Search the response')}
                  placeholder={t('restpage.search', 'Search the response')}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="td-page-meta" data-testid="rest-search-count">
                  {search.trim() ? `${shown.matches} / ${shown.lines}` : `${shown.lines}`}
                </span>
              </span>
            )}
          </div>

          {response && !response.ok && (
            <p className="td-form-error" data-testid="rest-error">
              {response.error}
            </p>
          )}

          {response?.ok && (
            <>
              <details className="td-details">
                <summary>{t('restpage.response_headers', 'Response headers')}</summary>
                <pre className="td-pre" data-testid="rest-response-headers">
                  {(response.headers ?? [])
                    .map((header) => `${header.name}: ${header.value}`)
                    .join('\n')}
                </pre>
              </details>
              <pre className="td-pre" data-testid="rest-response-body">
                {shown.text}
              </pre>
              {!search.trim() && shown.lines > FOLD_AFTER && (
                <button
                  className="td-btn"
                  data-testid="rest-show-all"
                  type="button"
                  onClick={() => setShowAll((prev) => !prev)}
                >
                  {showAll
                    ? t('restpage.fold_again', 'Fold back to the first 400 lines')
                    : `${t('restpage.show_all', 'Show all lines')} (${shown.lines})`}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
