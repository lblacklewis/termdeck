import type { DockviewApi, DockviewGroupPanel, DockviewPanel } from 'dockview'

/**
 * Arrange the open panes into a tiling.
 *
 * Written against `panel.api.moveTo`, which moves an existing panel rather than
 * removing and re-adding it: a panel that is removed takes its terminal and its
 * session with it, so a "tile everything" that rebuilt the layout would close every
 * connection it was arranging.
 *
 * Sizes are equalised afterwards. Splitting repeatedly gives the first pane half,
 * the next a quarter, and so on — technically a tiling, and useless as one — so each
 * group is set back to an equal share of the container. `setSize` only sizes a group
 * along its own axis, which is why the same call can be used for both directions.
 */

export type TileMode = 'grid' | 'columns' | 'rows' | 'stack'

export interface TileResult {
  /** Panes that were arranged, in the order they ended up. */
  arranged: string[]
  mode: TileMode
}

/** How many columns a grid of `count` panes should use. */
export function gridColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)))
}

/** The size a group should be given, along the axis it is laid out on. */
function sizeFor(
  container: HTMLElement,
  span: number,
  share: 'width' | 'height'
): { width?: number; height?: number } {
  const total = share === 'width' ? container.clientWidth : container.clientHeight
  /*
   * The plain share, with no allowance for the sashes.
   *
   * dockview sizes the groups you name and lets the last one take the remainder. The
   * splitter widths are *not* in that remainder — they sit between the groups — so
   * subtracting anything for them (276 against 296 measured in a four-column
   * layout) is what made the last pane visibly fatter.
   */
  const value = Math.max(120, Math.floor(total / Math.max(1, span)))
  return share === 'width' ? { width: value } : { height: value }
}

export function tilePanels(
  api: DockviewApi,
  ids: string[],
  mode: TileMode,
  container: HTMLElement | null,
  keepIds: string[] = []
): TileResult {
  const panels = ids
    .map((id) => api.getPanel(id))
    .filter((panel): panel is DockviewPanel => Boolean(panel))
  if (panels.length === 0) return { arranged: [], mode }

  /*
   * Panes left out of the selection become tabs in one of the splits.
   *
   * They are gathered here and moved into the last arrangement group once it exists:
   * a partial selection must produce exactly as many splits as were ticked ("select
   * three, get three"), and the panes that were not ticked belong with one of them
   * rather than taking a share of their own — which is what squeezed or, worse,
   * silently added a fourth column.
   */
  const kept = keepIds
    .map((id) => api.getPanel(id))
    .filter((panel): panel is DockviewPanel => panel !== undefined && !ids.includes(panel.id))
  const anchor = panels[0]
  const anchorGroup = anchor.group

  // Everything selected into one group first, so the moves below start from a known
  // shape whatever the panes were doing before.
  for (const panel of panels.slice(1)) {
    panel.api.moveTo({ group: anchorGroup, position: 'center' })
  }

  /** Unselected panes join the split that ends up last. */
  const gather = (): void => {
    const target = panels[panels.length - 1].group
    for (const panel of kept) {
      if (target && panel.group !== target) panel.api.moveTo({ group: target, position: 'center' })
    }
  }

  /** "One window": every pane as a tab in a single group. */
  if (mode === 'stack') {
    for (const panel of kept) panel.api.moveTo({ group: anchorGroup, position: 'center' })
    return { arranged: [...panels, ...kept].map((panel) => panel.id), mode }
  }

  if (panels.length === 1 && kept.length === 0) return { arranged: [panels[0].id], mode }

  if (mode === 'columns' || mode === 'rows') {
    const position = mode === 'columns' ? 'right' : 'bottom'
    /*
     * The target group has to be named explicitly. Without it `moveTo` moves the
     * panel *within* its current group — the panes are tabs at this point, so the
     * layout came out exactly as it went in: one group, four tabs.
     *
     * Naming the panel's own group (which is still the anchor, since only the
     * previous pane has been moved out) splits it, leaving a chain along one axis.
     */
    for (const panel of panels.slice(1)) {
      if (panel.group) panel.api.moveTo({ group: panel.group, position })
    }
    equalise(api, panels, mode === 'columns' ? 'width' : 'height', container)
    gather()
    return { arranged: panels.map((panel) => panel.id), mode }
  }

  // Grid: columns first, then the panes inside each column.
  const columnCount = gridColumns(panels.length)
  const columns: DockviewPanel[][] = []
  for (let index = 0; index < panels.length; index += 1) {
    const column = index % columnCount
    const panel = panels[index]
    if (!columns[column]) {
      columns[column] = []
      if (column > 0 && panel.group) {
        panel.api.moveTo({ group: panel.group, position: 'right' })
      }
    } else if (panel.group) {
      panel.api.moveTo({ group: columns[column][0].group, position: 'bottom' })
    }
    columns[column].push(panel)
  }

  equalise(api, columns.map((column) => column[0]), 'width', container, columnCount)
  for (const column of columns) {
    equalise(api, column, 'height', container)
  }
  gather()
  return { arranged: panels.map((panel) => panel.id), mode }
}

/** Give every group in a chain the same share of the container. */
function equalise(
  api: DockviewApi,
  panels: DockviewPanel[],
  share: 'width' | 'height',
  container: HTMLElement | null,
  span = panels.length
): void {
  if (!container) return
  const seen = new Set<DockviewGroupPanel>()
  const apply = (): void => {
    for (const panel of panels) {
      const group = panel.group
      if (!group || seen.has(group)) continue
      seen.add(group)
      group.api.setSize(sizeFor(container, span, share))
    }
  }
  // Once for the layout that has just been requested, once for the one dockview has
  // actually finished — the same reason the interface scale re-asserts the layout.
  apply()
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(apply)
  })
  void api
}
