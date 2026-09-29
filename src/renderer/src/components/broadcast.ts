/**
 * Broadcast input.
 *
 * With several panes open, typing usually goes to the focused one. Broadcast
 * mode sends every keystroke to all of them at once, which is what you want when
 * running the same command across a set of hosts.
 *
 * A module rather than React state on purpose: the terminal's input handler is
 * registered once when the pane mounts and must see the current mode without
 * being re-registered, so this is a mutable registry consulted at call time.
 */

type Sink = (data: string) => void

const sinksBySession = new Map<string, Sink>()
let broadcast = false
const listeners = new Set<(on: boolean) => void>()

export function isBroadcasting(): boolean {
  return broadcast
}

export function setBroadcasting(on: boolean): void {
  if (broadcast === on) return
  broadcast = on
  for (const listener of listeners) listener(on)
}

export function toggleBroadcasting(): boolean {
  setBroadcasting(!broadcast)
  return broadcast
}

/** Observe the mode, e.g. so a button can reflect it. */
export function onBroadcastChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Each pane registers how to write into itself. */
export function registerSink(sessionId: string, sink: Sink): void {
  sinksBySession.set(sessionId, sink)
}

export function unregisterSink(sessionId: string): void {
  sinksBySession.delete(sessionId)
}

/**
 * Route a keystroke.
 *
 * Returns true when the broadcast handled it, meaning the caller must not also
 * write to its own session — otherwise the pane the user typed in would receive
 * the character twice.
 */
export function routeInput(sourceSessionId: string, data: string): boolean {
  if (!broadcast) return false
  for (const [sessionId, sink] of sinksBySession) {
    // The source pane receives it through its own path, so skip it here.
    if (sessionId === sourceSessionId) continue
    sink(data)
  }
  return true
}

/** How many panes a keystroke would reach. */
export function sinkCount(): number {
  return sinksBySession.size
}

/**
 * A short human summary for a tooltip, and whether anything was skipped.
 * Sessions that have already exited stay registered until their pane unmounts,
 * so the count can exceed the live ones.
 */
export function broadcastSummary(): string {
  const n = sinksBySession.size
  if (n === 0) return 'No open sessions'
  return `Input goes to all ${n} open session${n === 1 ? '' : 's'}`
}
