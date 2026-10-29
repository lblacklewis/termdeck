import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import {
  REST_HISTORY_LIMIT,
  type RestAuth,
  type RestAuthType,
  type RestBodyMode,
  type RestEnvironment,
  type RestFolder,
  type RestFormField,
  type RestHeader,
  type RestHistoryEntry,
  type RestParam,
  type RestRequest,
  type RestResponse,
  type RestState,
  type SavedRestRequest
} from '@shared/types'
import { REST_TEMPLATES } from '@shared/restTemplates'
import { headersJsonOf, parseHeadersJson, type HeaderJsonProblem } from '@shared/restHeaders'
import { clampRestBodyHeight } from '@shared/restLayout'
import { composeUrl, paramsForUrl, splitUrlQuery } from '@shared/restUrl'
import { environmentVars } from '@shared/restVars'
import { buildRestRequest, requestVars } from '@shared/restBuild'
import { buildCurl, parseCurl } from '@shared/restCurl'
import { cookiesFrom } from '@shared/restCookies'
import { ModalShell } from './ModalShell'
import { t } from '../i18n'

const METHODS: RestRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const EMPTY: RestRequest = {
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  bodyMode: 'none',
  body: '',
  form: []
}

const BODY_MODES: RestBodyMode[] = ['none', 'json', 'form', 'raw']

const AUTH_TYPES: RestAuthType[] = ['none', 'bearer', 'basic', 'apikey']

/** Bodies longer than this are folded to the first screenful. */
const FOLD_AFTER = 400

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
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

/** The request's own name when it has none yet. */
function nameFor(request: RestRequest): string {
  const trimmed = request.url.trim()
  if (trimmed === '') return t('restpage.untitled', 'Untitled request')
  try {
    const url = new URL(trimmed)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${request.method} ${url.host}${path}`
  } catch {
    return `${request.method} ${trimmed}`
  }
}

/**
 * The REST workbench.
 *
 * Apifox-shaped, and deliberately smaller than it: a collection tree on the left, the
 * request in tabs on the right (parameters, headers, body, auth), the answer below, and
 * one environment selector that decides what `{{name}}` means. The parts that were not
 * built are the parts a terminal client has no use for — mock servers, test suites,
 * performance runs, request scripts, schema documentation.
 *
 * Two rules run through all of it:
 *
 *   - **one write path**. The draft, the tree, the environments and the history live in
 *     one file, so every change goes through `commit`, reading the parts it is not
 *     changing from refs. Two changes in one tick — sending twice quickly is the
 *     ordinary case — must build on each other rather than on the last render.
 *   - **the wire request is built, never typed**. `buildRestRequest` folds the parameter
 *     table into the URL, resolves `{{name}}` against the active environment, turns the
 *     auth block into a header and picks the body's content type. What the editor holds
 *     stays exactly as typed; nothing here rewrites it.
 */
export function RestPage(): JSX.Element {
  const [request, setRequest] = useState<RestRequest>(EMPTY)
  const [response, setResponse] = useState<RestResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [templateId, setTemplateId] = useState('')

  /** The collection. Folders hold folders and requests; requests sit at the top too. */
  const [folders, setFolders] = useState<RestFolder[]>([])
  const [saved, setSaved] = useState<SavedRestRequest[]>([])
  const [savedId, setSavedId] = useState('')
  const [treeQuery, setTreeQuery] = useState('')
  /** Inline rename in the tree: which node, and what has been typed into it. */
  const [renaming, setRenaming] = useState<{ kind: 'request' | 'folder'; id: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [newFolder, setNewFolder] = useState<string | null>(null)

  /** The environments `{{name}}` resolves against, and which one is active. */
  const [environments, setEnvironments] = useState<RestEnvironment[]>([])
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null)
  const [envOpen, setEnvOpen] = useState(false)
  const [envEditingId, setEnvEditingId] = useState('')

  const [history, setHistory] = useState<RestHistoryEntry[]>([])

  const [tab, setTab] = useState<'params' | 'headers' | 'body' | 'auth'>('params')
  const [responseTab, setResponseTab] = useState<'body' | 'headers' | 'cookies'>('body')

  /** Headers are the same list whether they are edited as rows or as one JSON box. */
  const [headerMode, setHeaderMode] = useState<'rows' | 'json'>('rows')
  const [headersJson, setHeadersJson] = useState('{}')
  const [headersProblem, setHeadersProblem] = useState<HeaderJsonProblem | null>(null)
  /**
   * What `request.headers` looked like when the JSON box last agreed with it.
   *
   * The two editors are one list, so switching between them has to carry the data — but
   * not by rewriting the box every time: text that does not parse yet (a half-typed
   * object, a paste with something wrong in it) exists nowhere else, so it is kept until
   * the rows are actually edited behind its back.
   */
  const headersJsonForRef = useRef(headersJsonOf([]))

  /**
   * The request-body box, and the height the user dragged it to.
   *
   * The grip is the browser's own (`resize: vertical`), and it records the drag as an
   * inline height on the element — DOM state that dies when the page unmounts, which is
   * exactly why the size used to snap back after a trip to another tool page.
   */
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyHeightRef = useRef<number | undefined>(undefined)
  const [bodyHeight, setBodyHeight] = useState<number | undefined>(undefined)

  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [flash, setFlash] = useState('')
  /** Names the active environment does not define, from the last attempt to send. */
  const [missingVars, setMissingVars] = useState<string[]>([])

  /** The cURL importer: a pasted command and whatever is wrong with it. */
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlError, setCurlError] = useState('')

  /** Draft writes are debounced: typing a URL must not hit the disk per key. */
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<RestRequest>(EMPTY)
  const foldersRef = useRef<RestFolder[]>([])
  const savedRef = useRef<SavedRestRequest[]>([])
  const environmentsRef = useRef<RestEnvironment[]>([])
  const activeEnvRef = useRef<string | null>(null)
  const historyRef = useRef<RestHistoryEntry[]>([])

  draftRef.current = request

  /**
   * The page's one write path.
   *
   * The lists live in one file, so a write that carried only one of them would drop the
   * others — every change goes through here, taking the parts it is not changing from the
   * refs rather than from whatever the last render happened to see.
   */
  const commit = useCallback(
    (patch: {
      folders?: RestFolder[]
      saved?: SavedRestRequest[]
      environments?: RestEnvironment[]
      activeEnvironmentId?: string | null
      history?: RestHistoryEntry[]
    }): void => {
      if (patch.folders) {
        foldersRef.current = patch.folders
        setFolders(patch.folders)
      }
      if (patch.saved) {
        savedRef.current = patch.saved
        setSaved(patch.saved)
      }
      if (patch.environments) {
        environmentsRef.current = patch.environments
        setEnvironments(patch.environments)
      }
      if (patch.activeEnvironmentId !== undefined) {
        activeEnvRef.current = patch.activeEnvironmentId
        setActiveEnvironmentId(patch.activeEnvironmentId)
      }
      if (patch.history) {
        historyRef.current = patch.history
        setHistory(patch.history)
      }
      void window.termdeck.saveRestState({
        draft: draftRef.current,
        folders: foldersRef.current,
        saved: savedRef.current,
        environments: environmentsRef.current,
        activeEnvironmentId: activeEnvRef.current,
        history: historyRef.current,
        bodyHeight: bodyHeightRef.current
      })
    },
    []
  )

  /** Write the draft once the user stops typing. */
  const rememberDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => commit({}), 400)
  }, [commit])

  useEffect(() => {
    void window.termdeck.loadRestState().then((state: RestState) => {
      setSaved(state.saved)
      setHistory(state.history)
      setFolders(state.folders)
      setEnvironments(state.environments)
      setActiveEnvironmentId(state.activeEnvironmentId)
      foldersRef.current = state.folders
      savedRef.current = state.saved
      environmentsRef.current = state.environments
      activeEnvRef.current = state.activeEnvironmentId
      historyRef.current = state.history
      if (state.draft) setRequest(state.draft)
      if (state.bodyHeight) {
        bodyHeightRef.current = state.bodyHeight
        setBodyHeight(state.bodyHeight)
      }
    })
    return window.termdeck.onRestStateChanged((state: RestState) => {
      setSaved(state.saved)
      setHistory(state.history)
      setFolders(state.folders)
      setEnvironments(state.environments)
      setActiveEnvironmentId(state.activeEnvironmentId)
      foldersRef.current = state.folders
      savedRef.current = state.saved
      environmentsRef.current = state.environments
      activeEnvRef.current = state.activeEnvironmentId
      historyRef.current = state.history
    })
  }, [])

  /**
   * Notice the request-body box being resized, and keep that size.
   *
   * Only a drag (or our own re-application of a stored size) leaves an inline height
   * behind, which is what makes the user's size separable from whatever height the layout
   * happened to give the box.
   */
  useEffect(() => {
    const box = bodyRef.current
    if (!box) return
    const observer = new ResizeObserver(() => {
      if (!box.style.height) return
      const size = clampRestBodyHeight(Math.round(box.getBoundingClientRect().height))
      if (!size || size === bodyHeightRef.current) return
      bodyHeightRef.current = size
      setBodyHeight(size)
      rememberDraft()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [rememberDraft, tab, request.bodyMode])

  const update = useCallback(
    (next: RestRequest) => {
      setRequest(next)
      rememberDraft()
    },
    [rememberDraft]
  )

  const flashFor = (what: string, ms = 1600): void => {
    setFlash(what)
    setTimeout(() => setFlash(''), ms)
  }

  // ---- the active environment -------------------------------------------

  const activeEnvironment = useMemo(
    () => environments.find((entry) => entry.id === activeEnvironmentId) ?? null,
    [environments, activeEnvironmentId]
  )

  const activeVars = useMemo(() => environmentVars(activeEnvironment), [activeEnvironment])

  /** Variable names the draft uses, and which of them the environment defines. */
  const usedVars = useMemo(() => requestVars(request), [request])

  const undefinedVars = useMemo(
    () => usedVars.filter((name) => activeVars[name] === undefined),
    [usedVars, activeVars]
  )

  // ---- the tree ----------------------------------------------------------

  const requestById = useCallback(
    (id: string): SavedRestRequest | undefined => saved.find((entry) => entry.id === id),
    [saved]
  )

  const openRequest = useCallback(
    (entry: SavedRestRequest) => {
      setSavedId(entry.id)
      setTemplateId('')
      update({
        ...entry.request,
        params: (entry.request.params ?? []).map((row) => ({ ...row })),
        headers: entry.request.headers.map((header) => ({ ...header })),
        form: (entry.request.form ?? []).map((row) => ({ ...row }))
      })
      setResponse(null)
    },
    [update]
  )

  const applyTemplate = useCallback(
    (id: string) => {
      setTemplateId(id)
      setSavedId('')
      const template = REST_TEMPLATES.find((entry) => entry.id === id)
      if (!template) {
        // "Blank request" has to mean blank: leaving the previous template's URL in the
        // form while the menu says otherwise invites sending something unintended.
        update({ ...EMPTY, headers: [] })
        setResponse(null)
        return
      }
      // A copy: editing a loaded template must not rewrite the catalog.
      update({
        method: template.request.method,
        url: template.request.url,
        params: [],
        headers: template.request.headers.map((header) => ({ ...header })),
        bodyMode: template.request.body ? 'json' : 'none',
        body: template.request.body ?? '',
        form: []
      })
      setResponse(null)
    },
    [update]
  )

  /** Save the editor's request into the collection: update in place, or add. */
  const saveCurrent = useCallback((): void => {
    if (request.url.trim() === '') return
    const existing = saved.find((entry) => entry.id === savedId)
    if (existing) {
      commit({
        saved: saved.map((entry) =>
          entry.id === existing.id ? { ...entry, request: { ...request } } : entry
        )
      })
      flashFor('saved')
      return
    }
    const entry: SavedRestRequest = {
      id: newId(),
      name: nameFor(request),
      folderId: null,
      request: { ...request }
    }
    setSavedId(entry.id)
    commit({ saved: [...saved, entry] })
    flashFor('saved')
  }, [commit, request, saved, savedId])

  const deleteRequest = useCallback(
    (id: string) => {
      commit({ saved: saved.filter((entry) => entry.id !== id) })
      if (savedId === id) setSavedId('')
    },
    [commit, saved, savedId]
  )

  const addFolder = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (trimmed === '') return
      commit({ folders: [...folders, { id: newId(), name: trimmed, parentId: null, expanded: true }] })
    },
    [commit, folders]
  )

  const toggleFolder = useCallback(
    (id: string) => {
      commit({
        folders: folders.map((folder) =>
          folder.id === id ? { ...folder, expanded: folder.expanded !== true } : folder
        )
      })
    },
    [commit, folders]
  )

  /**
   * Delete a folder without deleting what is inside it.
   *
   * Losing a request because the folder around it was tidied away is not a trade anyone
   * would accept, so its children move up to the folder's own parent.
   */
  const deleteFolder = useCallback(
    (id: string) => {
      const folder = folders.find((entry) => entry.id === id)
      if (!folder) return
      commit({
        folders: folders
          .filter((entry) => entry.id !== id)
          .map((entry) =>
            entry.parentId === id ? { ...entry, parentId: folder.parentId } : entry
          ),
        saved: saved.map((entry) =>
          (entry.folderId ?? null) === id ? { ...entry, folderId: folder.parentId } : entry
        )
      })
    },
    [commit, folders, saved]
  )

  const renameNode = useCallback(
    (kind: 'request' | 'folder', id: string, name: string) => {
      const trimmed = name.trim()
      if (trimmed === '') return
      if (kind === 'folder') {
        commit({ folders: folders.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)) })
      } else {
        commit({ saved: saved.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)) })
      }
    },
    [commit, folders, saved]
  )

  const moveRequest = useCallback(
    (id: string, folderId: string | null) => {
      commit({
        saved: saved.map((entry) => (entry.id === id ? { ...entry, folderId } : entry))
      })
    },
    [commit, saved]
  )

  const keepFromHistory = useCallback(
    (entry: RestHistoryEntry) => {
      const kept: SavedRestRequest = {
        id: newId(),
        name: nameFor(entry.request),
        folderId: null,
        request: {
          ...entry.request,
          params: (entry.request.params ?? []).map((row) => ({ ...row })),
          headers: entry.request.headers.map((header) => ({ ...header }))
        }
      }
      setSavedId(kept.id)
      commit({ saved: [...saved, kept] })
      flashFor('kept')
    },
    [commit, saved]
  )

  // ---- environments ------------------------------------------------------

  const addEnvironment = useCallback((): void => {
    const entry: RestEnvironment = {
      id: newId(),
      name: t('restpage.new_environment', 'New environment'),
      variables: [{ name: 'base', value: 'http://127.0.0.1:8080', enabled: true }]
    }
    setEnvEditingId(entry.id)
    commit({ environments: [...environments, entry], activeEnvironmentId: entry.id })
  }, [commit, environments])

  const patchEnvironment = useCallback(
    (id: string, patch: Partial<RestEnvironment>): void => {
      commit({
        environments: environments.map((entry) =>
          entry.id === id ? { ...entry, ...patch } : entry
        )
      })
    },
    [commit, environments]
  )

  const deleteEnvironment = useCallback(
    (id: string): void => {
      const next = environments.filter((entry) => entry.id !== id)
      commit({
        environments: next,
        activeEnvironmentId: activeEnvironmentId === id ? (next[0]?.id ?? null) : activeEnvironmentId
      })
      if (envEditingId === id) setEnvEditingId(next[0]?.id ?? '')
    },
    [commit, environments, activeEnvironmentId, envEditingId]
  )

  // ---- request bits ------------------------------------------------------

  const setHeader = (index: number, patch: Partial<RestHeader>): void => {
    update({
      ...request,
      headers: request.headers.map((header, at) => (at === index ? { ...header, ...patch } : header))
    })
  }

  const setParam = (index: number, patch: Partial<RestParam>): void => {
    const params = (request.params ?? []).map((row, at) =>
      at === index ? { ...row, ...patch } : row
    )
    update({
      ...request,
      params,
      // The URL is the other view of this table, so it is rewritten as rows change.
      url: composeUrl(splitUrlQuery(request.url).base, params)
    })
  }

  const setFormField = (index: number, patch: Partial<RestFormField>): void => {
    update({
      ...request,
      form: (request.form ?? []).map((row, at) => (at === index ? { ...row, ...patch } : row))
    })
  }

  const authPatch = (patch: Partial<RestAuth>): void => {
    const base: RestAuth = request.auth ?? { type: 'none' }
    update({ ...request, auth: { ...base, ...patch } })
  }

  const copyCurl = async (): Promise<void> => {
    await window.termdeck.copyToClipboard(buildCurl(request))
    flashFor('copied')
  }

  const applyCurl = (): void => {
    const parsed = parseCurl(curlText)
    if (!parsed.ok) {
      setCurlError(parsed.message)
      return
    }
    setCurlError('')
    setCurlOpen(false)
    setCurlText('')
    setTemplateId('')
    setSavedId('')
    update({
      ...parsed.request,
      params: (parsed.request.params ?? []).map((row) => ({ ...row })),
      headers: parsed.request.headers.map((header) => ({ ...header })),
      form: (parsed.request.form ?? []).map((row) => ({ ...row }))
    })
    setResponse(null)
    flashFor('imported')
  }

  /** Pretty-print the request body, or say why it cannot be. */
  const formatBody = (): void => {
    const body = request.body ?? ''
    try {
      const pretty = JSON.stringify(JSON.parse(body), null, 2)
      update({ ...request, body: pretty })
      flashFor('formatted', 2000)
    } catch {
      flashFor('bad-json', 2000)
    }
  }

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const built = buildRestRequest(request, activeEnvironment)
    if (!built.ok) {
      /*
       * A URL with `{{host}}` still in it is not a request anyone meant to send. Refusing
       * and naming the variables is the only useful answer: sending it produces a 404 or a
       * DNS error somewhere far from the real problem.
       */
      setMissingVars(built.missing)
      setResponse(null)
      return
    }
    setMissingVars([])
    setBusy(true)
    setResponse(null)
    setSearch('')
    setShowAll(false)
    try {
      const result = await window.termdeck.sendRestRequest(built.request)
      setResponse(result)
      recordHistory(request, result)
    } catch (err) {
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

  /**
   * Remember a call that was made.
   *
   * The request as typed, not as resolved: a history entry is meant to be run again, and
   * `{{name}}` is what makes it runnable against whatever environment is active then.
   */
  const recordHistory = useCallback(
    (sent: RestRequest, result: RestResponse): void => {
      const entry: RestHistoryEntry = {
        id: newId(),
        at: Date.now(),
        request: {
          ...sent,
          params: (sent.params ?? []).map((row) => ({ ...row })),
          headers: sent.headers.map((header) => ({ ...header })),
          form: (sent.form ?? []).map((row) => ({ ...row }))
        },
        status: result.status,
        ok: result.ok,
        durationMs: result.durationMs
      }
      const next = [entry, ...historyRef.current].slice(0, REST_HISTORY_LIMIT)
      historyRef.current = next
      setHistory(next)
      commit({ history: next })
    },
    [commit]
  )

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

  const cookies = useMemo(() => cookiesFrom(response?.headers), [response])

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

  // ---- rendering helpers -------------------------------------------------

  /** One editable line of the parameter and form tables. */
  const rowLine = (
    kind: 'param' | 'form',
    row: RestParam | RestFormField,
    index: number
  ): JSX.Element => (
    <div className="td-rest-line" key={kind + index}>
      <input
        type="checkbox"
        data-testid={'rest-' + kind + '-enabled'}
        checked={row.enabled}
        aria-label={t('restpage.row_enabled', 'Enabled')}
        onChange={(e) =>
          kind === 'param'
            ? setParam(index, { enabled: e.target.checked })
            : setFormField(index, { enabled: e.target.checked })
        }
      />
      <input
        className="td-rest-line-name"
        data-testid={'rest-' + kind + '-name'}
        value={row.name}
        spellCheck={false}
        placeholder={t('restpage.name', 'Name')}
        onChange={(e) =>
          kind === 'param'
            ? setParam(index, { name: e.target.value })
            : setFormField(index, { name: e.target.value })
        }
      />
      <input
        className="td-rest-line-value"
        data-testid={'rest-' + kind + '-value'}
        value={row.value}
        spellCheck={false}
        placeholder={t('restpage.value', 'Value')}
        onChange={(e) =>
          kind === 'param'
            ? setParam(index, { value: e.target.value })
            : setFormField(index, { value: e.target.value })
        }
      />
      <button
        className="td-btn td-btn-quiet"
        type="button"
        data-testid={'rest-' + kind + '-remove'}
        aria-label={t('restpage.remove_row', 'Remove')}
        onClick={() =>
          kind === 'param'
            ? update({ ...request, params: (request.params ?? []).filter((_, at) => at !== index) })
            : update({ ...request, form: (request.form ?? []).filter((_, at) => at !== index) })
        }
      >
        ✕
      </button>
    </div>
  )

  const rowsFor = (parentId: string | null, depth: number): JSX.Element[] => {
    const here = folders.filter((folder) => folder.parentId === parentId)
    const items = saved.filter((entry) => (entry.folderId ?? null) === parentId)
    return [
      ...here.map((folder) => (
        <div key={folder.id}>
          <div
            className="td-rest-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            data-testid="rest-tree-folder"
            data-folder-id={folder.id}
          >
            <button
              className="td-rest-caret"
              type="button"
              data-testid="rest-tree-toggle"
              aria-label={t('restpage.toggle_folder', 'Open or close')}
              onClick={() => toggleFolder(folder.id)}
            >
              {folder.expanded === true ? '▾' : '▸'}
            </button>
            {renaming?.kind === 'folder' && renaming.id === folder.id ? (
              <input
                className="td-rest-rename"
                data-testid="rest-tree-rename-input"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => {
                  renameNode('folder', folder.id, renameDraft)
                  setRenaming(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    renameNode('folder', folder.id, renameDraft)
                    setRenaming(null)
                  }
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span className="td-rest-name">{folder.name}</span>
            )}
            <button
              className="td-btn td-btn-quiet"
              type="button"
              data-testid="rest-tree-rename"
              aria-label={t('restpage.rename', 'Rename')}
              onClick={() => {
                setRenaming({ kind: 'folder', id: folder.id })
                setRenameDraft(folder.name)
              }}
            >
              ✎
            </button>
            <button
              className="td-btn td-btn-quiet"
              type="button"
              data-testid="rest-tree-delete"
              aria-label={t('restpage.drop', 'Delete')}
              onClick={() => deleteFolder(folder.id)}
            >
              ✕
            </button>
          </div>
          {folder.expanded === true && rowsFor(folder.id, depth + 1)}
        </div>
      )),
      ...items.map((entry) => (
        <div
          key={entry.id}
          className={'td-rest-row td-rest-leaf' + (entry.id === savedId ? ' is-selected' : '')}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid="rest-tree-item"
          data-request-id={entry.id}
        >
          <span className={'td-rest-method is-' + entry.request.method.toLowerCase()}>
            {entry.request.method}
          </span>
          {renaming?.kind === 'request' && renaming.id === entry.id ? (
            <input
              className="td-rest-rename"
              data-testid="rest-tree-rename-input"
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                renameNode('request', entry.id, renameDraft)
                setRenaming(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  renameNode('request', entry.id, renameDraft)
                  setRenaming(null)
                }
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              className="td-rest-name td-rest-open"
              type="button"
              data-testid="rest-tree-open"
              title={entry.request.url}
              onClick={() => openRequest(entry)}
            >
              {entry.name}
            </button>
          )}
          <button
            className="td-btn td-btn-quiet"
            type="button"
            data-testid="rest-tree-rename"
            aria-label={t('restpage.rename', 'Rename')}
            onClick={() => {
              setRenaming({ kind: 'request', id: entry.id })
              setRenameDraft(entry.name)
            }}
          >
            ✎
          </button>
          <button
            className="td-btn td-btn-quiet"
            type="button"
            data-testid="rest-tree-delete"
            aria-label={t('restpage.drop', 'Delete')}
            onClick={() => deleteRequest(entry.id)}
          >
            ✕
          </button>
        </div>
      ))
    ]
  }

  const query = treeQuery.trim().toLowerCase()
  const matches = saved.filter(
    (entry) =>
      query === '' ||
      entry.name.toLowerCase().includes(query) ||
      entry.request.url.toLowerCase().includes(query)
  )

  const selectedEntry = requestById(savedId)
  const envEditing = environments.find((entry) => entry.id === envEditingId) ?? null

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
              data-testid="rest-env-select"
              aria-label={t('restpage.environment', 'Environment')}
              value={activeEnvironmentId ?? ''}
              onChange={(e) => commit({ activeEnvironmentId: e.target.value || null })}
            >
              <option value="">{t('restpage.no_environment', 'No environment')}</option>
              {environments.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button
              className="td-btn"
              type="button"
              data-testid="rest-env-manage"
              onClick={() => {
                setEnvEditingId(activeEnvironmentId ?? environments[0]?.id ?? '')
                setEnvOpen(true)
              }}
            >
              {t('restpage.environments', 'Environments…')}
            </button>
          </div>
        </div>
        <p className="td-page-meta" data-testid="rest-template-hint">{hint}</p>
      </header>

      <div className="td-page-body td-rest-body">
        {/*
          * The collection on the left, the request and its answer on the right. Both
          * columns scroll on their own, so reading a long answer never pushes the editor
          * off the screen.
          */}
        <aside className="td-rest-aside" data-testid="rest-aside">
          <section className="td-rest-group">
            <div className="td-rest-group-head">
              <span className="td-rest-group-title">
                {t('restpage.collection', 'Collection')}
              </span>
              <span className="td-page-meta" data-testid="rest-tree-count">{saved.length}</span>
              <button
                className="td-btn td-btn-quiet"
                type="button"
                data-testid="rest-tree-add-folder"
                onClick={() => setNewFolder('')}
              >
                {t('restpage.new_folder', '+ Folder')}
              </button>
              <button
                className="td-btn td-btn-quiet"
                type="button"
                data-testid="rest-save-saved"
                onClick={saveCurrent}
              >
                {selectedEntry ? t('restpage.update', 'Update') : t('restpage.keep', 'Keep')}
              </button>
              {flash === 'saved' && (
                <span className="td-page-meta" data-testid="rest-saved-flash">
                  {t('restpage.saved_flash', 'Saved')}
                </span>
              )}
            </div>
            {newFolder !== null && (
              <input
                className="td-rest-search"
                data-testid="rest-tree-new-folder-input"
                autoFocus
                value={newFolder}
                placeholder={t('restpage.folder_name', 'Folder name')}
                onChange={(e) => setNewFolder(e.target.value)}
                onBlur={() => {
                  addFolder(newFolder)
                  setNewFolder(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    addFolder(newFolder)
                    setNewFolder(null)
                  }
                  if (e.key === 'Escape') setNewFolder(null)
                }}
              />
            )}
            <input
              className="td-rest-search"
              data-testid="rest-tree-search"
              value={treeQuery}
              spellCheck={false}
              placeholder={t('restpage.filter', 'Filter requests…')}
              onChange={(e) => setTreeQuery(e.target.value)}
            />
            {selectedEntry && (
              <div className="td-rest-move">
                <span className="td-page-meta">{t('restpage.move_to', 'Move to')}</span>
                <select
                  data-testid="rest-tree-move"
                  value={selectedEntry.folderId ?? ''}
                  onChange={(e) => moveRequest(selectedEntry.id, e.target.value || null)}
                >
                  <option value="">{t('restpage.top_level', 'Top level')}</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="td-rest-tree" data-testid="rest-tree">
              {saved.length === 0 && newFolder === null && (
                <p className="td-page-meta" data-testid="rest-tree-empty">
                  {t('restpage.tree_empty', 'No saved requests yet — send one, then Keep it.')}
                </p>
              )}
              {query === ''
                ? rowsFor(null, 0)
                : matches.map((entry) => (
                    <div
                      key={entry.id}
                      className={
                        'td-rest-row td-rest-leaf' + (entry.id === savedId ? ' is-selected' : '')
                      }
                      data-testid="rest-tree-item"
                      data-request-id={entry.id}
                    >
                      <span className={'td-rest-method is-' + entry.request.method.toLowerCase()}>
                        {entry.request.method}
                      </span>
                      <button
                        className="td-rest-name td-rest-open"
                        type="button"
                        data-testid="rest-tree-open"
                        title={entry.request.url}
                        onClick={() => openRequest(entry)}
                      >
                        {entry.name}
                      </button>
                    </div>
                  ))}
            </div>
          </section>

          <section className="td-rest-group">
            <div className="td-rest-group-head">
              <span className="td-rest-group-title">{t('restpage.history', 'History')}</span>
              <span className="td-page-meta" data-testid="rest-history-count">
                {history.length}
              </span>
              {history.length > 0 && (
                <button
                  className="td-btn td-btn-quiet"
                  type="button"
                  data-testid="rest-history-clear"
                  onClick={() => commit({ history: [] })}
                >
                  {t('restpage.clear_2', 'Clear')}
                </button>
              )}
            </div>
            {history.length === 0 && (
              <p className="td-page-meta" data-testid="rest-history-empty">
                {t('restpage.history_empty', 'Nothing sent yet.')}
              </p>
            )}
            <ul className="td-rest-list" data-testid="rest-history-list">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="td-rest-list-item"
                  data-testid="rest-history-item"
                  title={entry.request.url}
                >
                  <button
                    className="td-rest-open"
                    type="button"
                    data-testid="rest-history-open"
                    title={entry.request.url}
                    onClick={() =>
                      update({
                        ...entry.request,
                        params: (entry.request.params ?? []).map((row) => ({ ...row })),
                        headers: entry.request.headers.map((header) => ({ ...header })),
                        form: (entry.request.form ?? []).map((row) => ({ ...row }))
                      })
                    }
                  >
                    <span className={'td-rest-method is-' + entry.request.method.toLowerCase()}>
                      {entry.request.method}
                    </span>
                    <span className="td-rest-url">{entry.request.url}</span>
                    <span className="td-rest-ago">
                      {entry.status ?? '—'} · {ago(entry.at)}
                    </span>
                  </button>
                  <button
                    className="td-btn td-btn-quiet"
                    type="button"
                    data-testid="rest-history-keep"
                    aria-label={t('restpage.keep', 'Keep')}
                    onClick={() => keepFromHistory(entry)}
                  >
                    ★
                  </button>
                  <button
                    className="td-btn td-btn-quiet"
                    type="button"
                    data-testid="rest-history-drop"
                    aria-label={t('restpage.drop', 'Delete')}
                    onClick={() =>
                      commit({ history: history.filter((item) => item.id !== entry.id) })
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
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
                  onChange={(e) => update({ ...request, method: e.target.value as RestRequest['method'] })}
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
                  onChange={(e) => {
                    const url = e.target.value
                    update({ ...request, url, params: paramsForUrl(url, request.params) })
                  }}
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
              <button
                className="td-btn"
                data-testid="rest-curl-open"
                type="button"
                onClick={() => {
                  setCurlText('')
                  setCurlError('')
                  setCurlOpen(true)
                }}
              >
                {t('restpage.import_curl', 'Import cURL')}
              </button>
              {flash === 'copied' && (
                <span className="td-page-meta" data-testid="rest-copied">
                  {t('restpage.copied', 'Copied')}
                </span>
              )}
              {flash === 'imported' && (
                <span className="td-page-meta" data-testid="rest-imported">
                  {t('restpage.imported', 'Imported')}
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
              {/*
                * The variables the request uses and the environment does not define.
                * Shown while editing rather than only on send: a typo in `{{toke}}` is
                * much cheaper to notice here than as a request that never goes out.
              */}
              {undefinedVars.length > 0 && (
                <span className="td-page-meta" data-testid="rest-vars-undefined">
                  {t('restpage.vars_undefined', 'Not in this environment: {names}', {
                    names: undefinedVars.join(', ')
                  })}
                </span>
              )}
            </div>

            <div className="td-rest-tabs" role="tablist">
              {(
                [
                  ['params', t('restpage.tab_params', 'Params'), (request.params ?? []).filter((row) => row.enabled && row.name.trim() !== '').length],
                  ['headers', t('restpage.headers', 'Headers'), request.headers.filter((header) => header.name.trim() !== '').length],
                  ['body', t('restpage.body', 'Body'), 0],
                  ['auth', t('restpage.auth', 'Auth'), request.auth && request.auth.type !== 'none' ? 1 : 0]
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  className={'td-btn td-btn-quiet td-rest-tab' + (tab === id ? ' is-on' : '')}
                  type="button"
                  role="tab"
                  data-testid={'rest-tab-' + id}
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                >
                  {label}
                  {count > 0 ? ' (' + count + ')' : ''}
                </button>
              ))}
            </div>

            {tab === 'params' && (
              <div className="td-field" data-testid="rest-params">
                {(request.params ?? []).map((row, index) => rowLine('param', row, index))}
                <button
                  className="td-btn"
                  type="button"
                  data-testid="rest-param-add"
                  onClick={() =>
                    update({
                      ...request,
                      params: [...(request.params ?? []), { name: '', value: '', enabled: true }]
                    })
                  }
                >
                  {t('restpage.add_param', '+ Parameter')}
                </button>
              </div>
            )}

            {tab === 'headers' && (
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
                        /*
                         * Carrying the data across, both ways.
                         *
                         * The box is filled from the rows only when the rows have actually
                         * moved since the box was last read or written — a template was
                         * picked, a row was edited. Otherwise the text is left exactly as it
                         * was typed, which is what keeps a half-finished JSON object from
                         * being overwritten: it is the only copy of that edit.
                         */
                        const current = headersJsonOf(request.headers)
                        if (current !== headersJsonForRef.current) {
                          setHeadersJson(current)
                          headersJsonForRef.current = current
                          setHeadersProblem(null)
                        }
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
                        headersJsonForRef.current = headersJsonOf(parsed.headers)
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
                              : t('restpage.headers_bad_line', 'No "Name: value" in: {line}', {
                                  line: headersProblem.detail
                                })}
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
                  <div data-testid="rest-headers">
                    {request.headers.map((header, index) => (
                      <div className="td-rest-line" key={'header' + index}>
                        <input
                          className="td-rest-line-name"
                          data-testid="rest-header-name"
                          value={header.name}
                          spellCheck={false}
                          placeholder={t('restpage.name', 'Name')}
                          onChange={(e) => setHeader(index, { name: e.target.value })}
                        />
                        <input
                          className="td-rest-line-value"
                          data-testid="rest-header-value"
                          value={header.value}
                          spellCheck={false}
                          placeholder={t('restpage.value', 'Value')}
                          onChange={(e) => setHeader(index, { value: e.target.value })}
                        />
                        <button
                          className="td-btn td-btn-quiet"
                          type="button"
                          data-testid="rest-header-remove"
                          aria-label={t('restpage.remove_row', 'Remove')}
                          onClick={() =>
                            update({
                              ...request,
                              headers: request.headers.filter((_, at) => at !== index)
                            })
                          }
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      className="td-btn"
                      type="button"
                      data-testid="rest-header-add"
                      onClick={() =>
                        update({
                          ...request,
                          headers: [...request.headers, { name: '', value: '' }]
                        })
                      }
                    >
                      {t('restpage.add_header', '+ Header')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {tab === 'body' && (
              <div className="td-field">
                <span className="td-field-row td-rest-head-row">
                  <span>{t('restpage.body', 'Body')}</span>
                  <span className="td-rest-mode" role="group">
                    {BODY_MODES.map((mode) => (
                      <button
                        key={mode}
                        className={'td-btn td-btn-quiet' + (request.bodyMode === mode ? ' is-on' : '')}
                        type="button"
                        data-testid={'rest-body-mode-' + mode}
                        onClick={() =>
                          update({
                            ...request,
                            bodyMode: mode,
                            form: mode === 'form' ? (request.form ?? []) : request.form
                          })
                        }
                      >
                        {mode === 'none'
                          ? t('restpage.body_none', 'None')
                          : mode === 'json'
                            ? t('restpage.body_json', 'JSON')
                            : mode === 'form'
                              ? t('restpage.body_form', 'Form')
                              : t('restpage.body_raw', 'Text')}
                      </button>
                    ))}
                  </span>
                  {request.bodyMode === 'json' && (
                    <button
                      className="td-btn"
                      type="button"
                      data-testid="rest-format"
                      onClick={formatBody}
                    >
                      {t('restpage.format', 'Format')}
                    </button>
                  )}
                  {flash === 'formatted' && (
                    <span className="td-page-meta" data-testid="rest-formatted">
                      {t('restpage.formatted', 'Formatted')}
                    </span>
                  )}
                  {flash === 'bad-json' && (                    <span className="td-form-error" data-testid="rest-format-error">
                      {t('restpage.not_json', 'That is not JSON.')}
                    </span>
                  )}
                </span>
                {request.bodyMode === 'form' ? (
                  <div data-testid="rest-form-rows">
                    {(request.form ?? []).map((row, index) => rowLine('form', row, index))}
                    <button
                      className="td-btn"
                      type="button"
                      data-testid="rest-form-add"
                      onClick={() =>
                        update({
                          ...request,
                          form: [...(request.form ?? []), { name: '', value: '', enabled: true }]
                        })
                      }
                    >
                      {t('restpage.add_field', '+ Field')}
                    </button>
                  </div>
                ) : (
                  <textarea
                    ref={bodyRef}
                    className="td-textarea td-rest-body-box"
                    data-testid="rest-body"
                    value={request.body ?? ''}
                    spellCheck={false}
                    placeholder={t('restpage.body_placeholder', 'Sent with POST, PUT and PATCH only')}
                    style={bodyHeight ? { height: bodyHeight + 'px' } : undefined}
                    onChange={(e) => {
                      /*
                       * Typing into an empty body is asking for a body. Leaving the mode at
                       * `none` would mean the text is on screen and silently not sent, so the
                       * first keystroke picks the mode the text looks like: JSON if it parses,
                       * plain text otherwise.
                       */
                      const text = e.target.value
                      let mode = request.bodyMode ?? 'none'
                      if (mode === 'none') {
                        try {
                          JSON.parse(text)
                          mode = 'json'
                        } catch {
                          mode = 'raw'
                        }
                      }
                      update({ ...request, body: text, bodyMode: mode })
                    }}
                  />
                )}
              </div>
            )}

            {tab === 'auth' && (
              <div className="td-field" data-testid="rest-auth">
                <label className="td-field">
                  <span>{t('restpage.auth_type', 'Auth type')}</span>
                  <select
                    data-testid="rest-auth-type"
                    value={request.auth?.type ?? 'none'}
                    onChange={(e) => authPatch({ type: e.target.value as RestAuthType })}
                  >
                    {AUTH_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type === 'none'
                          ? t('restpage.auth_none', 'No auth')
                          : type === 'bearer'
                            ? t('restpage.auth_bearer', 'Bearer token')
                            : type === 'basic'
                              ? t('restpage.auth_basic', 'Basic auth')
                              : t('restpage.auth_apikey', 'API key')}
                      </option>
                    ))}
                  </select>
                </label>
                {request.auth?.type === 'bearer' && (
                  <label className="td-field">
                    <span>{t('restpage.token', 'Token')}</span>
                    <input
                      data-testid="rest-auth-token"
                      value={request.auth.token ?? ''}
                      spellCheck={false}
                      onChange={(e) => authPatch({ token: e.target.value })}
                    />
                  </label>
                )}
                {request.auth?.type === 'basic' && (
                  <div className="td-field-row">
                    <label className="td-field">
                      <span>{t('restpage.username', 'Username')}</span>
                      <input
                        data-testid="rest-auth-username"
                        value={request.auth.username ?? ''}
                        spellCheck={false}
                        onChange={(e) => authPatch({ username: e.target.value })}
                      />
                    </label>
                    <label className="td-field">
                      <span>{t('restpage.password', 'Password')}</span>
                      <input
                        data-testid="rest-auth-password"
                        type="password"
                        value={request.auth.password ?? ''}
                        onChange={(e) => authPatch({ password: e.target.value })}
                      />
                    </label>
                  </div>
                )}
                {request.auth?.type === 'apikey' && (
                  <div className="td-field-row">
                    <label className="td-field">
                      <span>{t('restpage.header_name', 'Header')}</span>
                      <input
                        data-testid="rest-auth-key"
                        value={request.auth.key ?? ''}
                        spellCheck={false}
                        onChange={(e) => authPatch({ key: e.target.value })}
                      />
                    </label>
                    <label className="td-field">
                      <span>{t('restpage.value', 'Value')}</span>
                      <input
                        data-testid="rest-auth-value"
                        value={request.auth.value ?? ''}
                        spellCheck={false}
                        onChange={(e) => authPatch({ value: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </form>

          <section className="td-section td-rest-response" data-testid="rest-response">
            <div className="td-rest-response-head">
              <span className="td-pill" data-testid="rest-status">
                {status || t('restpage.no_response', 'No response yet')}
              </span>
              {response?.ok && (
                <span className="td-page-meta" data-testid="rest-meta">
                  {response.durationMs} ms · {response.size} B
                </span>
              )}
              {response?.finalUrl && response.finalUrl !== request.url && (
                <span className="td-page-meta" data-testid="rest-final-url">
                  {response.finalUrl}
                </span>
              )}
              <span className="td-rest-mode" role="group">
                {(
                  [
                    ['body', t('restpage.response_body', 'Body')],
                    ['headers', t('restpage.response_headers', 'Headers')],
                    ['cookies', t('restpage.response_cookies', 'Cookies')]
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={'td-btn td-btn-quiet' + (responseTab === id ? ' is-on' : '')}
                    type="button"
                    data-testid={'rest-response-tab-' + id}
                    onClick={() => setResponseTab(id)}
                  >
                    {label}
                    {id === 'cookies' && cookies.length > 0 ? ' (' + cookies.length + ')' : ''}
                  </button>
                ))}
              </span>
              {responseTab === 'body' && response?.ok && (
                <>
                  <input
                    className="td-rest-search"
                    data-testid="rest-search"
                    value={search}
                    spellCheck={false}
                    placeholder={t('restpage.search', 'Search the answer…')}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search.trim() !== '' && (
                    <span className="td-page-meta" data-testid="rest-search-count">
                      {t('restpage.search_hits', '{n} of {total} lines', {
                        n: shown.matches,
                        total: shown.lines
                      })}
                    </span>
                  )}
                </>
              )}
            </div>

            {missingVars.length > 0 && (
              <p className="td-form-error" data-testid="rest-missing-vars">
                {t('restpage.missing_vars', 'Not sent: this environment does not define {names}.', {
                  names: missingVars.join(', ')
                })}
              </p>
            )}

            {!response && (
              <p className="td-page-meta" data-testid="rest-idle">
                {t('restpage.idle', 'Send a request to see the answer here.')}
              </p>
            )}

            {response && !response.ok && (
              <p className="td-form-error" data-testid="rest-error">{failure}</p>
            )}

            {response?.ok && responseTab === 'headers' && (
              <pre className="td-pre" data-testid="rest-response-headers">
                {(response.headers ?? [])
                  .map((header) => `${header.name}: ${header.value}`)
                  .join('\n')}
              </pre>
            )}

            {response?.ok && responseTab === 'cookies' && (
              <div data-testid="rest-cookies">
                {cookies.length === 0 ? (
                  <p className="td-page-meta" data-testid="rest-cookies-empty">
                    {t('restpage.no_cookies', 'This answer set no cookies.')}
                  </p>
                ) : (
                  cookies.map((cookie, index) => (
                    <div className="td-rest-line" key={'cookie' + index} data-testid="rest-cookie-row">
                      <span className="td-rest-cookie-name" data-testid="rest-cookie-name">
                        {cookie.name}
                      </span>
                      <span className="td-rest-line-value" data-testid="rest-cookie-value">
                        {cookie.value}
                      </span>
                      <span className="td-page-meta" data-testid="rest-cookie-attrs">
                        {cookie.attributes.join('; ')}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}

            {response?.ok && responseTab === 'body' && (
              <>
                <pre className="td-pre" data-testid="rest-response-body">{shown.text}</pre>
                {shown.lines > FOLD_AFTER && shown.matches === 0 && !showAll && (
                  <button
                    className="td-btn"
                    type="button"
                    data-testid="rest-show-all"
                    onClick={() => setShowAll(true)}
                  >
                    {t('restpage.show_all', 'Show all {n} lines', { n: shown.lines })}
                  </button>
                )}
                {shown.lines > FOLD_AFTER && shown.matches === 0 && showAll && (
                  <button
                    className="td-btn"
                    type="button"
                    data-testid="rest-fold-again"
                    onClick={() => setShowAll(false)}
                  >
                    {t('restpage.fold_again', 'Fold back to the first {n} lines', { n: FOLD_AFTER })}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      {envOpen && (
        <ModalShell onDismiss={() => setEnvOpen(false)} className="td-modal-wide" testId="rest-env-dialog">
          <h2 className="td-modal-title">{t('restpage.environments_title', 'Environments')}</h2>
          <div className="td-field-row">
            <button
              className="td-btn"
              type="button"
              data-testid="rest-env-add"
              onClick={() => addEnvironment()}
            >
              {t('restpage.new_environment', 'New environment')}
            </button>
            {envEditing && (
              <button
                className="td-btn"
                type="button"
                data-testid="rest-env-delete"
                onClick={() => deleteEnvironment(envEditing.id)}
              >
                {t('restpage.drop', 'Delete')}
              </button>
            )}
          </div>
          <ul className="td-rest-list" data-testid="rest-env-list">
            {environments.map((entry) => (
              <li key={entry.id} className="td-rest-list-item" data-testid="rest-env-item">
                <button
                  className={'td-rest-open' + (entry.id === envEditingId ? ' is-on' : '')}
                  type="button"
                  data-testid="rest-env-pick"
                  onClick={() => setEnvEditingId(entry.id)}
                >
                  {entry.name}
                  <span className="td-rest-ago">{entry.variables.length}</span>
                </button>
              </li>
            ))}
          </ul>
          {envEditing ? (
            <>
              <label className="td-field">
                <span>{t('restpage.env_name', 'Name')}</span>
                <input
                  data-testid="rest-env-name"
                  value={envEditing.name}
                  onChange={(e) => patchEnvironment(envEditing.id, { name: e.target.value })}
                />
              </label>
              <div className="td-field" data-testid="rest-env-vars">
                {envEditing.variables.map((variable, index) => (
                  <div className="td-rest-line" key={'var' + index}>
                    <input
                      type="checkbox"
                      data-testid="rest-env-var-enabled"
                      checked={variable.enabled}
                      aria-label={t('restpage.row_enabled', 'Enabled')}
                      onChange={(e) =>
                        patchEnvironment(envEditing.id, {
                          variables: envEditing.variables.map((row, at) =>
                            at === index ? { ...row, enabled: e.target.checked } : row
                          )
                        })
                      }
                    />
                    <input
                      className="td-rest-line-name"
                      data-testid="rest-env-var-name"
                      value={variable.name}
                      spellCheck={false}
                      placeholder={t('restpage.name', 'Name')}
                      onChange={(e) =>
                        patchEnvironment(envEditing.id, {
                          variables: envEditing.variables.map((row, at) =>
                            at === index ? { ...row, name: e.target.value } : row
                          )
                        })
                      }
                    />
                    <input
                      className="td-rest-line-value"
                      data-testid="rest-env-var-value"
                      value={variable.value}
                      spellCheck={false}
                      placeholder={t('restpage.value', 'Value')}
                      onChange={(e) =>
                        patchEnvironment(envEditing.id, {
                          variables: envEditing.variables.map((row, at) =>
                            at === index ? { ...row, value: e.target.value } : row
                          )
                        })
                      }
                    />
                    <button
                      className="td-btn td-btn-quiet"
                      type="button"
                      data-testid="rest-env-var-remove"
                      aria-label={t('restpage.remove_row', 'Remove')}
                      onClick={() =>
                        patchEnvironment(envEditing.id, {
                          variables: envEditing.variables.filter((_, at) => at !== index)
                        })
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  className="td-btn"
                  type="button"
                  data-testid="rest-env-var-add"
                  onClick={() =>
                    patchEnvironment(envEditing.id, {
                      variables: [
                        ...envEditing.variables,
                        { name: '', value: '', enabled: true }
                      ]
                    })
                  }
                >
                  {t('restpage.add_variable', '+ Variable')}
                </button>
              </div>
            </>
          ) : (
            <p className="td-page-meta" data-testid="rest-env-empty">
              {t('restpage.no_environments', 'No environments yet.')}
            </p>
          )}
          <div className="td-drawer-actions">
            <button
              className="td-btn td-btn-primary"
              type="button"
              data-testid="rest-env-close"
              onClick={() => setEnvOpen(false)}
            >
              {t('restpage.close', 'Close')}
            </button>
          </div>
        </ModalShell>
      )}

      {curlOpen && (
        <ModalShell onDismiss={() => setCurlOpen(false)} testId="rest-curl-dialog">
          <h2 className="td-modal-title">{t('restpage.import_curl', 'Import cURL')}</h2>
          <p className="td-page-meta">
            {t(
              'restpage.import_curl_hint',
              'Paste a curl command from a service\u2019s documentation; the method, URL, parameters, headers and body are filled in.'
            )}
          </p>
          <textarea
            className="td-textarea"
            data-testid="rest-curl-text"
            value={curlText}
            spellCheck={false}
            placeholder={"curl -X POST https://api.test/pets -H 'Content-Type: application/json' -d '{}'"}
            onChange={(e) => setCurlText(e.target.value)}
          />
          {curlError !== '' && (
            <span className="td-form-error" data-testid="rest-curl-error">{curlError}</span>
          )}
          <div className="td-drawer-actions">
            <button className="td-btn" type="button" data-testid="rest-curl-cancel" onClick={() => setCurlOpen(false)}>
              {t('restpage.cancel', 'Cancel')}
            </button>
            <button
              className="td-btn td-btn-primary"
              type="button"
              data-testid="rest-curl-apply"
              onClick={applyCurl}
              disabled={curlText.trim() === ''}
            >
              {t('restpage.import', 'Import')}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  )
}
