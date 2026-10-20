import { useCallback, useMemo, useState, type JSX } from 'react'

import type { RestHeader, RestRequest, RestResponse } from '@shared/types'
import { REST_TEMPLATES } from '@shared/restTemplates'
import { t } from '../i18n'

const METHODS: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const EMPTY: RestRequest = {
  method: 'GET',
  url: '',
  headers: [],
  body: ''
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
 * system, or a test runner. Templates are starting points you edit in place.
 */
export function RestPage(): JSX.Element {
  const [request, setRequest] = useState<RestRequest>(EMPTY)
  const [response, setResponse] = useState<RestResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [templateId, setTemplateId] = useState('')

  const applyTemplate = useCallback((id: string) => {
    setTemplateId(id)
    const template = REST_TEMPLATES.find((entry) => entry.id === id)
    if (!template) return
    // A copy: editing a loaded template must not rewrite the catalog, or the
    // next person to pick it gets somebody else's half-finished request.
    setRequest({
      method: template.request.method,
      url: template.request.url,
      headers: template.request.headers.map((header) => ({ ...header })),
      body: template.request.body ?? ''
    })
    setResponse(null)
  }, [])

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setResponse(null)
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
    setRequest((prev) => ({
      ...prev,
      headers: prev.headers.map((header, at) => (at === index ? { ...header, ...patch } : header))
    }))
  }

  const status = useMemo(() => {
    if (!response) return ''
    if (!response.ok) return response.error ?? 'The request failed.'
    return `${response.status} ${response.statusText ?? ''}`.trim()
  }, [response])

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
                  setRequest({ ...request, method: e.target.value as RestRequest['method'] })
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
                onChange={(e) => setRequest({ ...request, url: e.target.value })}
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
                      setRequest((prev) => ({
                        ...prev,
                        headers: prev.headers.filter((_, at) => at !== index)
                      }))
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
                setRequest((prev) => ({ ...prev, headers: [...prev.headers, { name: '', value: '' }] }))
              }
            >
              {t('restpage.add_header', 'Add header')}
            </button>
          </div>

          <label className="td-field">
            <span>{t('restpage.body', 'Body')}</span>
            <textarea
              className="td-textarea"
              data-testid="rest-body"
              value={request.body ?? ''}
              spellCheck={false}
              placeholder={t('restpage.body_placeholder', 'Only sent with POST, PUT and PATCH')}
              onChange={(e) => setRequest({ ...request, body: e.target.value })}
            />
          </label>
        </form>

        <section className="td-section" data-testid="rest-response">
          <div className="td-page-bar">
            <span className="td-pill" data-testid="rest-status">
              {status || t('restpage.no_response', 'No response yet')}
            </span>
            {response?.ok && (
              <span className="td-page-meta" data-testid="rest-meta">
                {response.durationMs} ms · {response.size} B
                {response.finalUrl && response.finalUrl !== request.url ? ` · ${response.finalUrl}` : ''}
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
                  {(response.headers ?? []).map((header) => `${header.name}: ${header.value}`).join('\n')}
                </pre>
              </details>
              <pre className="td-pre" data-testid="rest-response-body">
                {present(response.body ?? '')}
              </pre>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
