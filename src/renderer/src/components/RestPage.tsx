import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import {
  REST_HISTORY_LIMIT,
  type RestHeader,
  type RestHistoryEntry,
  type RestRequest,
  type RestResponse,
  type SavedRestRequest
} from '@shared/types'
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

/** Why headers typed as JSON could not be used, as a code the page can translate. */
type HeaderJsonProblem =
  | { code: 'not-json' }
  | { code: 'not-object' }
  | { code: 'bad-value'; detail: string }
  | { code: 'bad-line'; detail: string }

/**
 * Read headers out of one text box.
 *
 * Forgiving about the two shapes people actually paste — a JSON object, or the lines of a
 * `curl -H` block — and strict about everything else: a typo must not quietly turn into a
 * request that is missing the header somebody meant to authenticate with.
 *
 * Values are coerced, not rejected: `{"X-Count": 3}` and `{"Accept": ["a", "b"]}` are
 * things people write, and both have an obvious wire form.
 */
function parseHeadersJson(
  text: string
): { ok: true; headers: RestHeader[] } | { ok: false; problem: HeaderJsonProblem } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, headers: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    /*
     * A `curl -H` block is line-based, so it is not JSON at all: try it before refusing —
     * but only for text that is not clearly an attempt at JSON. Otherwise a typo like
     * `{ "X-Broken": }` would be read as a header named `{ "X-Broken"`, which is exactly
     * the silent misreading this function exists to prevent.
     */
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { ok: false, problem: { code: 'not-json' } }
    }
    const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
    const headers: RestHeader[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].replace(/,$/, '').replace(/^['"]|['"]$/g, '')
      const at = line.indexOf(':')
      // A header name is a token: no spaces, no braces, no quotes.
      if (at <= 0 || !/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(line.slice(0, at).trim())) {
        return { ok: false, problem: { code: 'bad-line', detail: line } }
      }
      headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() })
    }
    return { ok: true, headers }
  }

  if (Array.isArray(parsed)) {
    const headers: RestHeader[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'string') return { ok: false, problem: { code: 'not-object' } }
      const at = entry.indexOf(':')
      if (at <= 0) return { ok: false, problem: { code: 'bad-line', detail: entry } }
      headers.push({ name: entry.slice(0, at).trim(), value: entry.slice(at + 1).trim() })
    }
    return { ok: true, headers }
  }

  if (!parsed || typeof parsed !== 'object') return { ok: false, problem: { code: 'not-object' } }

  const headers: RestHeader[] = []
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      headers.push({ name, value: '' })
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      headers.push({ name, value: String(value) })
      continue
    }
    if (Array.isArray(value) && value.every((item) => typeof item !== 'object')) {
      headers.push({ name, value: value.map((item) => String(item)).join(', ') })
      continue
    }
    return { ok: false, problem: { code: 'bad-value', detail: name } }
  }
  return { ok: true, headers }
}

/** How old the entry is, in the shortest form that is still unambiguous. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

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
  const [history, setHistory] = useState<RestHistoryEntry[]>([])
  /** Headers are the same list whether they are edited as rows or as one JSON box. */
  const [headerMode, setHeaderMode] = useState<'rows' | 'json'>('rows')
  const [headersJson, setHeadersJson] = useState('{}')
  const [headersProblem, setHeadersProblem] = useState<HeaderJsonProblem | null>(null)
  /** Inline rename in the kept-requests list; the id being renamed, not a boolean. */
  const [renamingId, setRenamingId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  /** Draft writes are debounced: typing a URL must not hit the disk per key. */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<RestRequest>(EMPTY)
  const savedRef = useRef<SavedRestRequest[]>([])
  const historyRef = useRef<RestHistoryEntry[]>([])

  draftRef.current = request
  savedRef.current = saved
  historyRef.current = history

  useEffect(() => {
    void window.termdeck.loadRestState().then((state) => {
      setSaved(state.saved)
      setHistory(state.history)
      if (state.draft) setRequest(state.draft)
    })
    return window.termdeck.onRestStateChanged((state) => {
      setSaved(state.saved)
      setHistory(state.history)
    })
  }, [])

  /** Write the draft once the user stops typing. */
  const rememberDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      void window.termdeck.saveRestState({
        draft: draftRef.current,
        saved: savedRef.current,
        history: historyRef.current
      })
    }, 400)
  }, [])

  /**
   * The page's one write path.
   *
   * The three lists live in one file, so a write that carried only one of them would drop
   * the others — that is why every change goes through here, reading the parts it is not
   * changing from the refs instead of from whatever the last render happened to see.
   */
  const persist = useCallback(
    async (next: { saved?: SavedRestRequest[]; history?: RestHistoryEntry[] }): Promise<void> => {
      /*
       * The refs are updated here, not only through the render: two changes can happen
       * before React re-renders — sending twice quickly is the ordinary case — and the
       * second write must build on the first rather than on the list it replaced.
       */
      if (next.saved) {
        savedRef.current = next.saved
        setSaved(next.saved)
      }
      if (next.history) {
        historyRef.current = next.history
        setHistory(next.history)
      }
      await window.termdeck.saveRestState({
        draft: draftRef.current,
        saved: next.saved ?? savedRef.current,
        history: next.history ?? historyRef.current
      })
    },
    []
  )

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

  const persistSaved = useCallback(
    async (next: SavedRestRequest[]): Promise<void> => {
      // The draft and the history go with it: the store keeps one file, so a write that
      // only touched the list would drop whatever is on screen.
      await persist({ saved: next })
    },
    [persist]
  )

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

  /**
   * Remember a call that was made.
   *
   * Written from here rather than from the main process, which is where the request is
   * actually sent: both sides would be writing the same file, and the last write would
   * silently drop the other's list. One writer, one file.
   */
  const recordHistory = useCallback(
    (sent: RestRequest, result: RestResponse): void => {
      const entry: RestHistoryEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        // A copy: the editor keeps changing, and the entry has to keep what was sent.
        request: { ...sent, headers: sent.headers.map((header) => ({ ...header })) },
        status: result.status,
        ok: result.ok,
        durationMs: result.durationMs
      }
      const next = [entry, ...historyRef.current].slice(0, REST_HISTORY_LIMIT)
      historyRef.current = next
      setHistory(next)
      void window.termdeck.saveRestState({
        draft: draftRef.current,
        saved: savedRef.current,
        history: next
      })
    },
    []
  )

  /** Put a stored request back in the editor, as a copy. */
  const loadRequest = useCallback(
    (stored: RestRequest): void => {
      update({ ...stored, headers: stored.headers.map((header) => ({ ...header })) })
      setResponse(null)
    },
    [update]
  )

  /** Keep a call from the history under a name derived from what it is. */
  const keepFromHistory = async (entry: RestHistoryEntry): Promise<void> => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const kept: SavedRestRequest = {
      id,
      name: `${entry.request.method} ${entry.request.url}`,
      request: { ...entry.request, headers: entry.request.headers.map((header) => ({ ...header })) }
    }
    setSavedId(id)
    await persistSaved([...saved, kept])
  }

  const removeSavedEntry = async (id: string): Promise<void> => {
    await persistSaved(saved.filter((entry) => entry.id !== id))
    if (savedId === id) setSavedId('')
  }

  /** Overwrite a kept request with whatever is in the editor. */
  const updateSavedEntry = async (entry: SavedRestRequest): Promise<void> => {
    await persistSaved(
      saved.map((item) =>
        item.id === entry.id ? { ...item, request: { ...request } } : item
      )
    )
  }

  const commitRename = async (entry: SavedRestRequest): Promise<void> => {
    const name = renameDraft.trim() || entry.name
    setRenamingId('')
    await persistSaved(saved.map((item) => (item.id === entry.id ? { ...item, name } : item)))
  }

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setResponse(null)
    setSearch('')
    setShowAll(false)
    try {
      const result = await window.termdeck.sendRestRequest(request)
      setResponse(result)
      recordHistory(request, result)
    } catch (err) {
      // A call that never got an answer is still a call: it belongs in the list, with the
      // reason it failed, or the history would only remember the good days.
      const failed: RestResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        size: 0
      }
      setResponse(failed)
      recordHistory(request, failed)
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

  /**
   * Why the call failed.
   *
   * `errorCode` is set for the reasons this app decides the wording of, and the English
   * sentence that comes with it is the fallback — so a code with no translation shows
   * what the main process said rather than a raw key. Failures Node reported (a refused
   * connection, a certificate, DNS) have no code and are shown exactly as they arrived:
   * that text is the useful part, and there is nothing to translate.
   */
  const failure = useMemo((): string => {
    if (!response || response.ok) return ''
    const english = response.error ?? ''
    if (response.errorCode) return t('restpage.err.' + response.errorCode, english)
    return english || t('restpage.request_failed', 'The request failed.')
  }, [response])

  const status = useMemo(() => {
    if (!response) return ''
    if (!response.ok) return failure
    return `${response.status} ${response.statusText ?? ''}`.trim()
  }, [response, failure])

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

  /**
   * The line under the title.
   *
   * A template explains itself; with none picked, the page does. The descriptions live
   * in `restTemplates.ts` as shared data, so they are translated by id here rather than
   * duplicated — the English in that file stays the fallback for both languages.
   */
  const hint = useMemo((): string => {
    const entry = REST_TEMPLATES.find((template) => template.id === templateId)
    if (!entry) {
      return t(
        'restpage.hint',
        'Requests are sent from the app, so local services work even though the window is not a web page.'
      )
    }
    return t('restpage.tpl_desc.' + entry.id, entry.description)
  }, [templateId])

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
                  {t('restpage.tpl_name.' + template.id, template.name)}
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
        <p className="td-page-meta" data-testid="rest-template-hint">{hint}</p>
      </header>

      <div className="td-page-body td-rest-body">
        {/*
          * History and kept requests on the left, request and answer on the right.
          *
          * Both columns scroll on their own: the page itself does not move, so the answer
          * never slides below the fold while a body is being read.
          */}
        <aside className="td-rest-aside" data-testid="rest-aside">
          <section className="td-rest-group">
            <div className="td-rest-group-head">
              <span className="td-rest-group-title">
                {t('restpage.history', 'History')}
              </span>
              <span className="td-page-meta" data-testid="rest-history-count">
                {history.length}
              </span>
              {history.length > 0 && (
                <button
                  className="td-btn td-btn-quiet"
                  type="button"
                  data-testid="rest-history-clear"
                  onClick={() => void persist({ history: [] })}
                >
                  {t('restpage.clear_2', 'Clear')}
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <p className="td-page-meta" data-testid="rest-history-empty">
                {t('restpage.history_empty', 'Calls you send show up here.')}
              </p>
            ) : (
              <ul className="td-rest-list" data-testid="rest-history-list">
                {history.map((entry) => (
                  <li className="td-rest-item" key={entry.id}>
                    <button
                      className="td-rest-item-main"
                      type="button"
                      data-testid="rest-history-item"
                      title={entry.request.url}
                      onClick={() => loadRequest(entry.request)}
                    >
                      <span className="td-rest-item-top">
                        <span className="td-rest-method">{entry.request.method}</span>
                        <span
                          className={
                            'td-rest-outcome' +
                            (entry.ok ? ' is-ok' : ' is-bad')
                          }
                        >
                          {entry.status ?? '×'}
                        </span>
                        <span className="td-rest-when">{ago(entry.at)}</span>
                      </span>
                      <span className="td-rest-item-url">{entry.request.url}</span>
                    </button>
                    <span className="td-rest-item-actions">
                      <button
                        className="td-btn td-btn-quiet"
                        type="button"
                        data-testid="rest-history-keep"
                        title={t('restpage.keep_call', 'Keep this call')}
                        onClick={() => void keepFromHistory(entry)}
                      >
                        {t('restpage.keep_2', 'Keep')}
                      </button>
                      <button
                        className="td-btn td-btn-quiet"
                        type="button"
                        data-testid="rest-history-drop"
                        title={t('restpage.drop_call', 'Remove from history')}
                        onClick={() =>
                          void persist({
                            history: history.filter((item) => item.id !== entry.id)
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="td-rest-group">
            <div className="td-rest-group-head">
              <span className="td-rest-group-title">
                {t('restpage.kept', 'Kept requests')}
              </span>
              <span className="td-page-meta" data-testid="rest-kept-count">
                {saved.length}
              </span>
            </div>
            {saved.length === 0 ? (
              <p className="td-page-meta" data-testid="rest-kept-empty">
                {t('restpage.kept_empty', 'Keep a call to find it again by name.')}
              </p>
            ) : (
              <ul className="td-rest-list" data-testid="rest-kept-list">
                {saved.map((entry) => (
                  <li
                    className={'td-rest-item' + (entry.id === savedId ? ' is-current' : '')}
                    key={entry.id}
                  >
                    {renamingId === entry.id ? (
                      <input
                        className="td-rest-rename"
                        data-testid="rest-kept-rename-input"
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitRename(entry)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(entry)
                          if (e.key === 'Escape') setRenamingId('')
                        }}
                      />
                    ) : (
                      <button
                        className="td-rest-item-main"
                        type="button"
                        data-testid="rest-kept-item"
                        title={entry.request.url}
                        onClick={() => applySaved(entry.id)}
                      >
                        <span className="td-rest-item-top">
                          <span className="td-rest-method">{entry.request.method}</span>
                          <span className="td-rest-item-name">{entry.name}</span>
                        </span>
                        <span className="td-rest-item-url">{entry.request.url}</span>
                      </button>
                    )}
                    <span className="td-rest-item-actions">
                      <button
                        className="td-btn td-btn-quiet"
                        type="button"
                        data-testid="rest-kept-update"
                        title={t('restpage.update_from_editor', 'Save the editor over this')}
                        onClick={() => void updateSavedEntry(entry)}
                      >
                        {t('restpage.update_2', 'Save')}
                      </button>
                      <button
                        className="td-btn td-btn-quiet"
                        type="button"
                        data-testid="rest-kept-rename"
                        title={t('restpage.rename', 'Rename')}
                        onClick={() => {
                          setRenamingId(entry.id)
                          setRenameDraft(entry.name)
                        }}
                      >
                        {t('restpage.rename_2', 'Rename')}
                      </button>
                      <button
                        className="td-btn td-btn-quiet"
                        type="button"
                        data-testid="rest-kept-drop"
                        title={t('restpage.drop_kept', 'Remove')}
                        onClick={() => void removeSavedEntry(entry.id)}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <div className="td-rest-main">
        <form className="td-drawer-form td-rest-request" data-testid="rest-form" onSubmit={(e) => void send(e)}>
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
            <span className="td-field-row td-rest-head-row">
              <span>{t('restpage.headers', 'Headers')}</span>
              {/*
                * Two ways to the same list. Rows are for one header; the JSON box is for
                * the six a service documents, which nobody wants to type into six rows.
                */}
              <span className="td-rest-mode" role="group">
                <button
                  className={'td-btn td-btn-quiet' + (headerMode === 'rows' ? ' is-on' : '')}
                  type="button"
                  data-testid="rest-headers-rows"
                  onClick={() => setHeaderMode('rows')}
                >
                  {t('restpage.mode_rows', 'Rows')}
                </button>
                <button
                  className={'td-btn td-btn-quiet' + (headerMode === 'json' ? ' is-on' : '')}
                  type="button"
                  data-testid="rest-headers-json"
                  onClick={() => {
                    // Seeded from what is already there, so switching does not lose it.
                    setHeadersJson(
                      JSON.stringify(
                        Object.fromEntries(
                          request.headers
                            .filter((header) => header.name.trim())
                            .map((header) => [header.name, header.value])
                        ),
                        null,
                        2
                      )
                    )
                    setHeadersProblem(null)
                    setHeaderMode('json')
                  }}
                >
                  {t('restpage.mode_json', 'JSON')}
                </button>
              </span>
            </span>
            {headerMode === 'json' ? (
              <>
                <textarea
                  className="td-textarea td-rest-headers-json"
                  data-testid="rest-headers-json-input"
                  value={headersJson}
                  spellCheck={false}
                  placeholder={'{ "Content-Type": "application/json" }'}
                  onChange={(e) => {
                    const text = e.target.value
                    setHeadersJson(text)
                    const parsed = parseHeadersJson(text)
                    if (!parsed.ok) {
                      setHeadersProblem(parsed.problem)
                      return
                    }
                    setHeadersProblem(null)
                    update({ ...request, headers: parsed.headers })
                  }}
                />
                {headersProblem ? (
                  <span className="td-form-error" data-testid="rest-headers-json-error">
                    {headersProblem.code === 'not-json'
                      ? t('restpage.headers_not_json', 'That is not JSON.')
                      : headersProblem.code === 'not-object'
                        ? t(
                            'restpage.headers_not_object',
                            'Expected an object like {"Name": "value"} — or one "Name: value" per line.'
                          )
                        : headersProblem.code === 'bad-value'
                          ? t(
                              'restpage.headers_bad_value',
                              'The value of "{name}" is not a string, number or list of them.',
                              { name: headersProblem.detail }
                            )
                          : t(
                              'restpage.headers_bad_line',
                              'No "Name: value" in: {line}',
                              { line: headersProblem.detail }
                            )}
                  </span>
                ) : (
                  <span className="td-page-meta" data-testid="rest-headers-json-ok">
                    {t('restpage.headers_json_ok', '{n} header(s) in use.', {
                      n: request.headers.length
                    })}
                  </span>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
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

        <section className="td-section td-rest-response" data-testid="rest-response">
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
              {failure}
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
    </div>
  )
}
