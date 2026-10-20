import { Suspense, lazy, type JSX } from 'react'

import type { AppSettings, HostsView, SavedSession, SessionInfo, SessionTree, Snippet } from '@shared/types'
import type { PageId } from './NavRail'
import type { LogEntry } from './LogsPage'

/*
 * The pages that are not the terminal.
 *
 * All four are lazily imported: each is a full page the user has to ask for, so
 * they cost a chunk fetch the first time they are opened rather than a parse on
 * every start. `lazy` wants a default export, hence the `.then`.
 *
 * The fallback is `null` on purpose: the pages own their own `.td-page` layout,
 * so there is no wrapper to hold the space with, and a spinner that flashes for
 * one frame is worse than the frame of empty space it replaces.
 *
 * The first-run welcome screen deliberately does *not* live here: it is a
 * full-size flex child of the root element, so it has to stay the last child to
 * cover the shell rather than sit beside it.
 */
const KnownHostsPage = lazy(() =>
  import('./KnownHostsPage').then((m) => ({ default: m.KnownHostsPage }))
)
const SnippetsPage = lazy(() =>
  import('./SnippetsPage').then((m) => ({ default: m.SnippetsPage }))
)
const LogsPage = lazy(() => import('./LogsPage').then((m) => ({ default: m.LogsPage })))
const HostsPage = lazy(() => import('./HostsPage').then((m) => ({ default: m.HostsPage })))
const TunnelsPage = lazy(() =>
  import('./TunnelsPage').then((m) => ({ default: m.TunnelsPage }))
)
const RestPage = lazy(() => import('./RestPage').then((m) => ({ default: m.RestPage })))
const S3Page = lazy(() => import('./S3Page').then((m) => ({ default: m.S3Page })))

interface PagesLayerProps {
  page: PageId
  settings: AppSettings
  tree: SessionTree
  sessions: SessionInfo[]
  knownTags: string[]
  hostsView: HostsView
  onHostsViewChange: (view: HostsView) => void
  /** Connecting from Hosts switches to Terminal first (see below). */
  onShowTerminal: () => void
  onConnect: (session: SavedSession) => void
  onEditHost: (session: SavedSession) => void
  onDeleteHost: (id: string) => void
  onDuplicateHost: (session: SavedSession) => void
  onNewHost: (parentId: string | null) => void
  onCreateGroup: (parentId: string | null) => void
  onRenameGroup: (id: string) => void
  onDeleteGroup: (id: string) => void
  onMoveHost: (sessionId: string, parentId: string | null) => void
  onMoveGroup: (folderId: string, parentId: string | null) => void
  onExportShare: () => void
  onImportShare: () => void
  canSendSnippet: boolean
  onSendSnippet: (snippet: Snippet) => void
  onEditSnippet: (snippet: Snippet, group: string) => void
  onNewSnippet: (group: string) => void
  onDeleteSnippet: (id: string) => void
  onReorderSnippets: (ids: string[]) => void
  logEntries: LogEntry[]
  onClearLogs: () => void
}

/**
 * Every full page except the terminal, plus the first-run screen.
 *
 * The shell keeps rendering these as siblings of the rail and the workspace —
 * one of them is on screen instead of the terminal, and they are all direct
 * children of the root element, so the wrapper here is a fragment and the DOM
 * stays the same.
 */
export function PagesLayer({
  page,
  settings,
  tree,
  sessions,
  knownTags,
  hostsView,
  onHostsViewChange,
  onShowTerminal,
  onConnect,
  onEditHost,
  onDeleteHost,
  onDuplicateHost,
  onNewHost,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveHost,
  onMoveGroup,
  onExportShare,
  onImportShare,
  canSendSnippet,
  onSendSnippet,
  onEditSnippet,
  onNewSnippet,
  onDeleteSnippet,
  onReorderSnippets,
  logEntries,
  onClearLogs
}: PagesLayerProps): JSX.Element {
  return (
    <>
      {page === 'known-hosts' && (
        <Suspense fallback={null}>
          <KnownHostsPage />
        </Suspense>
      )}

      {page === 'snippets' && (
        <Suspense fallback={null}>
          <SnippetsPage
            snippets={settings.snippets}
            canSend={canSendSnippet}
            onSend={onSendSnippet}
            onEdit={(snippet) => onEditSnippet(snippet, snippet.group)}
            onNew={onNewSnippet}
            onDelete={onDeleteSnippet}
            onReorder={onReorderSnippets}
          />
        </Suspense>
      )}

      {page === 'logs' && (
        <Suspense fallback={null}>
          <LogsPage entries={logEntries} onClear={onClearLogs} />
        </Suspense>
      )}

      {/*
        Tunnels need the saved hosts rather than the live sessions: a forward is
        defined against a host you saved, and it runs on its own connection so it
        keeps working with no pane open at all.
      */}
      {page === 'tunnels' && (
        <Suspense fallback={null}>
          <TunnelsPage hosts={tree.sessions} />
        </Suspense>
      )}

      {page === 'rest' && (
        <Suspense fallback={null}>
          <RestPage />
        </Suspense>
      )}

      {page === 's3' && (
        <Suspense fallback={null}>
          <S3Page />
        </Suspense>
      )}

      {page === 'hosts' && (
        <Suspense fallback={null}>
          <HostsPage
            tree={tree}
            sessions={sessions}
            knownTags={knownTags}
            view={hostsView}
            onViewChange={onHostsViewChange}
            /*
             * Connecting from Hosts switches to Terminal first. The connection's
             * pane lives in the workspace, so staying on Hosts would open a session
             * the user cannot see and has to go looking for.
             */
            onConnect={(session) => {
              onShowTerminal()
              onConnect(session)
            }}
            onEdit={onEditHost}
            onDelete={onDeleteHost}
            onDuplicate={onDuplicateHost}
            onNewHost={onNewHost}
            onCreateGroup={onCreateGroup}
            onRenameGroup={onRenameGroup}
            onDeleteGroup={onDeleteGroup}
            onMove={onMoveHost}
            onMoveGroup={onMoveGroup}
            onExportShare={onExportShare}
            onImportShare={onImportShare}
          />
        </Suspense>
      )}
    </>
  )
}
