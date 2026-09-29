import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'
import type {
  GroupPanelPartInitParameters,
  IContentRenderer,
  IWatermarkRenderer,
  WatermarkRendererInitParameters
} from 'dockview'

/**
 * Parameter-change subscriptions, keyed by panel id.
 *
 * dockview's `updateParameters()` only updates the stored params — it does not
 * give the content renderer a way to observe the change (`onDidParametersChange`
 * is not on the init params, and `IContentRenderer` has no `update` method). So
 * the adapter keeps its own registry: the app calls `refreshPanelParams(id)`
 * after changing params, and the renderer re-renders with the new values.
 *
 * Without this, a restored pane whose session has been cleared keeps rendering
 * its stale live-terminal props.
 */
const paramListeners = new Map<string, Set<() => void>>()

/** Re-render the panel with the given id, if it is currently mounted. */
export function refreshPanelParams(panelId: string): void {
  const listeners = paramListeners.get(panelId)
  if (!listeners) return
  for (const listener of listeners) listener()
}

/**
 * dockview 7+ dropped its React binding, so this adapter bridges React
 * components into dockview's plain-DOM renderer contract.
 *
 * The component factory is called once per panel; React owns the subtree from
 * then on, and `dispose()` tears it down when the panel closes.
 */
export class ReactContentRenderer implements IContentRenderer {
  readonly element: HTMLElement
  private readonly root: Root
  private readonly render: (params: GroupPanelPartInitParameters) => ReactElement
  private params: GroupPanelPartInitParameters | null = null
  private panelId: string | null = null
  private readonly onParamsChange = (): void => {
    if (!this.params) return
    // Read the parameters live rather than reusing the object captured at init:
    // `init` receives a snapshot, so re-rendering it would show stale props even
    // after `panel.api.updateParameters(...)` has stored new ones.
    const api = this.params.api as unknown as {
      getParameters?: () => unknown
    }
    const latest = typeof api.getParameters === 'function' ? api.getParameters() : undefined
    this.root.render(this.render({ ...this.params, params: latest } as GroupPanelPartInitParameters))
  }

  constructor(
    render: (params: GroupPanelPartInitParameters) => ReactElement,
    className = 'td-panel-content'
  ) {
    this.render = render
    this.element = document.createElement('div')
    this.element.className = className
    this.element.style.width = '100%'
    this.element.style.height = '100%'
    this.element.style.overflow = 'hidden'
    this.root = createRoot(this.element)
  }

  /** dockview calls `init` once, after the element has been attached. */
  init(params: GroupPanelPartInitParameters): void {
    this.params = { ...params }
    this.root.render(this.render(this.params))

    this.panelId = params.api.id
    const set = paramListeners.get(this.panelId) ?? new Set()
    set.add(this.onParamsChange)
    paramListeners.set(this.panelId, set)
  }

  /**
   * xterm must re-measure when a hidden panel becomes visible again. The React
   * tree stays mounted, so a broadcast event is enough to trigger a refit.
   */
  onShow(): void {
    window.dispatchEvent(new Event('termdeck:panel-shown'))
  }

  dispose(): void {
    if (this.panelId) {
      const set = paramListeners.get(this.panelId)
      set?.delete(this.onParamsChange)
      if (set && set.size === 0) paramListeners.delete(this.panelId)
    }
    // Defer: React must not unmount synchronously inside dockview teardown.
    const root = this.root
    setTimeout(() => root.unmount(), 0)
  }
}

/** Watermark shown inside a dockview group that has no panels left. */
export class ReactWatermarkRenderer implements IWatermarkRenderer {
  readonly element: HTMLElement
  private readonly root: Root
  private readonly render: (params: WatermarkRendererInitParameters) => ReactElement

  constructor(render: (params: WatermarkRendererInitParameters) => ReactElement) {
    this.render = render
    this.element = document.createElement('div')
    this.element.className = 'td-watermark'
    this.element.style.width = '100%'
    this.element.style.height = '100%'
    this.root = createRoot(this.element)
  }

  init(params: WatermarkRendererInitParameters): void {
    this.root.render(this.render(params))
  }

  dispose(): void {
    const root = this.root
    setTimeout(() => root.unmount(), 0)
  }
}
