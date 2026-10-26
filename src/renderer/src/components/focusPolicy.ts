/**
 * Who gets the keyboard when the active pane changes.
 *
 * Switching panes used to leave the keyboard wherever the click landed — on a
 * tab, on a session row, or on `body` after the browser dropped focus — so the
 * next keystroke went nowhere and the terminal had to be clicked first. The rule
 * is now "the pane you switched to takes the keyboard", with the two exceptions
 * that make it safe: a field someone is typing in keeps it, and an open modal
 * asking for an answer keeps it.
 *
 * The decision is a pure table so a probe can assert every row with injected
 * inputs, rather than clicking its way through the interface to find out.
 */

/** What currently owns the keyboard, as far as the rule cares. */
export interface FocusHome {
  /** The terminal's own hidden input: typing is already going to a shell. */
  terminal: boolean
  /** A text field, select or contenteditable: someone is mid-sentence. */
  editable: boolean
  /** A modal (dialog, drawer, lock screen) is in front and asking for input. */
  modal: boolean
}

/** The terminal's focus target, as xterm itself names it. */
const TERMINAL_CLASS = 'xterm-helper-textarea'

/**
 * The overlays that keep the keyboard while they are open.
 *
 * Modals and the lock screen only. The session sidebar is deliberately *not*
 * here: it is a docked panel rather than a modal, and picking a session from it
 * is exactly the gesture that must hand the keyboard to the terminal.
 */
const MODAL_SELECTOR = '.td-modal, .td-drawer, .td-lock'

/** Read the DOM's current focus into the shape the rule uses. */
export function focusHomeOf(element: Element | null): FocusHome | null {
  if (!element) return null
  const tag = element.tagName
  const editable =
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (element as HTMLElement).isContentEditable === true
  return {
    terminal: element.classList.contains(TERMINAL_CLASS),
    editable,
    modal: element.closest(MODAL_SELECTOR) !== null
  }
}

/**
 * Should the pane that just became active take the keyboard?
 *
 * Order matters. The terminal's own input *is* a textarea, so it has to be
 * recognised before the editable test — otherwise switching panes by keyboard
 * while typing in a shell would stop working, which is the one path that
 * already did the right thing.
 */
export function shouldPaneTakeFocus(home: FocusHome | null): boolean {
  if (!home) return true
  if (home.terminal) return true
  if (home.editable) return false
  if (home.modal) return false
  return true
}
