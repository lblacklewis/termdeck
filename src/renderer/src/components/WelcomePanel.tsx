import type { ReactElement } from 'react'
import { t } from '../i18n'

/**
 * Shown in a pane that has no session — a dockview group that was emptied by
 * dragging its last tab away, or the initial empty workspace.
 */
export function WelcomePanel(): ReactElement {
  return (
    <div className="td-welcome">
      <div className="td-welcome-inner">
        <div className="td-welcome-logo">▚</div>
        <h2>{t('welcomepanel.termdeck', 'TermDeck')}</h2>
        <p className="td-welcome-lead">
          {t('welcomepanel.a_docking_ssh_client_drag_ta', 'A docking SSH client. Drag tab headers to split panes and group terminals.')}
        </p>
        <ul className="td-welcome-tips">
          <li>
            <b>{t('welcomepanel.split', 'Split')}</b> {t('welcomepanel.drag_a_tab_to_a_pane_edge_le', '— drag a tab to a pane edge (left / right / top / bottom).')}
          </li>
          <li>
            <b>{t('welcomepanel.group', 'Group')}</b> {t('welcomepanel.drag_a_tab_onto_the_centre_o', '— drag a tab onto the centre of another pane to stack tabs.')}
          </li>
          <li>
            <b>{t('welcomepanel.rearrange', 'Rearrange')}</b> {t('welcomepanel.drag_the_sash_between_panes', '— drag the sash between panes to resize.')}
          </li>
          <li>
            <b>{t('welcomepanel.new_session', 'New session')}</b> {t('welcomepanel.press', '— press')}<kbd>{t('welcomepanel.ctrl', 'Ctrl')}</kbd>+<kbd>T</kbd>.
          </li>
        </ul>
      </div>
    </div>
  )
}
