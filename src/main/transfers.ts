import { randomUUID } from 'node:crypto'

import type { TransferInfo, TransferKind, TransferStatus } from '@shared/types'

/**
 * Every file currently moving, and the last few that finished.
 *
 * The window needs one list rather than a stream of events: it opens at an arbitrary
 * moment, possibly in the middle of a transfer, so it asks for the current state and
 * then follows the changes. That makes this the single owner of the list, and the
 * broadcaster a detail of whoever hosts it (see `setTransferSink`).
 */
const KEEP_FINISHED = 40
/** Progress arrives once per chunk; the window is redrawn at most this often. */
const BROADCAST_MS = 200

let items: TransferInfo[] = []
/** How to stop a transfer that is still running, keyed by transfer id. */
const aborts = new Map<string, () => void>()
let sink: ((list: TransferInfo[]) => void) | null = null
let lastBroadcast = 0
let pendingBroadcast: NodeJS.Timeout | null = null

function snapshot(): TransferInfo[] {
  return items.map((item) => ({ ...item }))
}

function emit(force = false): void {
  if (!sink) return
  const now = Date.now()
  const wait = BROADCAST_MS - (now - lastBroadcast)
  if (!force && wait > 0) {
    /*
     * Coalesced rather than dropped: a chunk that arrives during the throttle window
     * has to be followed by an update that includes it, or the window freezes at
     * whatever percentage the last allowed broadcast saw.
     */
    if (!pendingBroadcast) {
      pendingBroadcast = setTimeout(() => {
        pendingBroadcast = null
        lastBroadcast = Date.now()
        sink?.(snapshot())
      }, wait)
    }
    return
  }
  lastBroadcast = now
  sink(snapshot())
}

/** The host of the list, e.g. the window broadcaster in the main process. */
export function setTransferSink(next: ((list: TransferInfo[]) => void) | null): void {
  sink = next
}

/** Register one transfer before it starts, and return its id. */
export function beginTransfer(input: {
  kind: TransferKind
  sessionId: string
  session: string
  name: string
  localPath: string
  remotePath: string
  size: number
}): string {
  const id = randomUUID()
  items = [
    {
      id,
      kind: input.kind,
      sessionId: input.sessionId,
      session: input.session,
      name: input.name,
      localPath: input.localPath,
      remotePath: input.remotePath,
      size: Math.max(0, input.size),
      done: 0,
      status: 'running',
      startedAt: Date.now()
    },
    ...items
  ]
  // The oldest finished entries fall off the end; running ones never do.
  const running = items.filter((item) => item.status === 'running')
  const finished = items.filter((item) => item.status !== 'running').slice(0, KEEP_FINISHED)
  items = [...running, ...finished].sort((a, b) => b.startedAt - a.startedAt)
  emit(true)
  return id
}

/** How the transfer can be stopped; called by `cancelTransfer`. */
export function onCancelTransfer(id: string, abort: () => void): void {
  aborts.set(id, abort)
}

export function reportProgress(id: string, done: number): void {
  const item = items.find((entry) => entry.id === id)
  if (!item || item.status !== 'running') return
  // Never report past the size: the counter is on the readable side and the size is
  // read separately, so a rounded-up figure would show 101%.
  item.done = Math.max(0, Math.min(done, item.size > 0 ? item.size : done))
  emit()
}

/**
 * Mark the ending.
 *
 * A transfer the user cancelled keeps that ending: the streams are destroyed, so it
 * arrives here looking like an ordinary close, and "done" would be a lie.
 */
export function finishTransfer(id: string, status: TransferStatus, message?: string): void {
  const item = items.find((entry) => entry.id === id)
  if (!item) return
  if (item.status === 'cancelled') {
    aborts.delete(id)
    emit(true)
    return
  }
  item.status = status
  item.message = message
  item.finishedAt = Date.now()
  if (status === 'done' && item.size > 0) item.done = item.size
  aborts.delete(id)
  emit(true)
}

export function listTransfers(): TransferInfo[] {
  return snapshot()
}

/** Stop one running transfer. Returns false when there was nothing to stop. */
export function cancelTransfer(id: string): boolean {
  const item = items.find((entry) => entry.id === id)
  if (!item || item.status !== 'running') return false
  item.status = 'cancelled'
  item.finishedAt = Date.now()
  const abort = aborts.get(id)
  aborts.delete(id)
  // Destroying the streams is what actually stops the bytes.
  try {
    abort?.()
  } catch {
    /* an already-closed stream is not an error worth reporting */
  }
  emit(true)
  return true
}

/** Forget everything that is no longer running. */
export function clearFinishedTransfers(): void {
  items = items.filter((item) => item.status === 'running')
  emit(true)
}

/** Was this transfer cancelled? Read by the transfer code to label the ending. */
export function wasCancelled(id: string): boolean {
  const item = items.find((entry) => entry.id === id)
  return item ? item.status === 'cancelled' : false
}
