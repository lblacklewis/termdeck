import type { ReactElement } from 'react'

/**
 * Shown in a pane that has no session — a dockview group that was emptied by
 * dragging its last tab away, or the initial empty workspace.
 */
export function WelcomePanel(): ReactElement {
  return (
    <div className="td-welcome">
      <div className="td-welcome-inner">
        <div className="td-welcome-logo">▚</div>
        <h2>TermDeck</h2>
        <p className="td-welcome-lead">
          A docking SSH client. Drag tab headers to split panes and group terminals.
        </p>
        <ul className="td-welcome-tips">
          <li>
            <b>Split</b> — drag a tab to a pane edge (left / right / top / bottom).
          </li>
          <li>
            <b>Group</b> — drag a tab onto the centre of another pane to stack tabs.
          </li>
          <li>
            <b>Rearrange</b> — drag the sash between panes to resize.
          </li>
          <li>
            <b>New session</b> — press <kbd>Ctrl</kbd>+<kbd>T</kbd>.
          </li>
        </ul>
      </div>
    </div>
  )
}
