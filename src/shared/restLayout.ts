/**
 * How tall the REST page's request-body box is allowed to be.
 *
 * The box is resized by dragging the browser's own grip (`resize: vertical`), which
 * records the drag as an inline height on the element — DOM state that dies with the
 * page the moment the user switches to another tool page, which is why the size used
 * to snap back. The height is read back into the file this page's state already lives
 * in and applied again on the way in; this module is the rule about what counts as a
 * height at all.
 *
 * Pure, so a probe can assert the bounds with injected numbers instead of dragging a
 * grip it cannot reach.
 */

/** Below this the box shows two lines and a scrollbar: a drag that went nowhere. */
export const REST_BODY_MIN_HEIGHT = 80

/** Above this the answer pane is gone — the exact layout this page exists to prevent. */
export const REST_BODY_MAX_HEIGHT = 900

/**
 * The height to keep, or `undefined` when the value is not a size.
 *
 * `undefined` means "never resized": the box keeps its CSS height. That covers a file
 * with no such field (anything written before this existed), a nonsense value, and the
 * zero/negative numbers a hand-edited file can hold — none of which should be clamped
 * into a real size, because none of them came from a drag.
 */
export function clampRestBodyHeight(
  value: unknown,
  bounds?: { min?: number; max?: number }
): number | undefined {
  const min = bounds?.min ?? REST_BODY_MIN_HEIGHT
  const max = bounds?.max ?? REST_BODY_MAX_HEIGHT
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  if (typeof value === 'string') {
    if (!value.trim()) return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  return undefined
}
