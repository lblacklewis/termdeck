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
/**
 * Route a keystroke to every *other* pane.
 *
 * Returns false, always, so the caller still writes to its own session. That is
 * not an oversight: skipping the source pane here and returning true left the pane
 * the user was typing in with no write at all, because the caller's local write is
 * exactly what the return value suppresses. The result was typing into one pane of
 * a split and seeing nothing appear in it, while the other panes received the
 * input — which reads as "broadcast is broken" rather than "the source pane is".
 *
 * Writing the source through its own path also keeps the ordering identical to
 * non-broadcast typing.
 */
export function routeInput(sourceSessionId: string, data: string): boolean {
  if (!broadcast) return false
  for (const [sessionId, sink] of sinksBySession) {
    if (sessionId === sourceSessionId) continue
    writesBySink.set(sessionId, (writesBySink.get(sessionId) ?? 0) + 1)
    sink(data)
  }
  return false
}

/** How many panes a keystroke would reach. */
export function sinkCount(): number {
  return sinksBySession.size
}

/** The sessions a keystroke would reach, for diagnostics and probes. */
export function sinkIds(): string[] {
  return [...sinksBySession.keys()]
}

/**
 * Per-sink write counts, populated only under the debug flag.
 *
 * "Some panes do not receive the broadcast" can mean the sink was never
 * registered, the fan-out skipped it, or the write happened and the shell never
 * answered — and from outside those are indistinguishable. These counters
 * separate them.
 */
export const writesBySink = new Map<string, number>()

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
