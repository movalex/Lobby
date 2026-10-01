// The mind-map collapse prototype (docs/EXCALIDRAW-MIGRATION.md §4.7; check B12, the decision for wave
// 3d): only `collapsed` is stored, on the parent's `mindmap` value (one transact step, synced like any
// other key). Every client computes the hidden branch from the scene (model.ts `mindmapHidden`) and hands
// it to the board page's one RenderOverrides (opacity 0; overrides.ts expands labels and frame children),
// so it is hidden, cannot be clicked (the hit guard), is left out of Ctrl+A (O2's selectAll consults
// `registries.hidden`), of box and lasso selections (the post-filter) and of exports (export/select.ts).
// Not "opacity 0 + locked" (§4.7): no other element is ever written.
import { createPortal } from 'react-dom'
import { onOverrides, type RenderOverrides } from '../../overrides.ts'
import type { CanvasPort } from '../../port.ts'
import type { OverlayLayerProps } from '../../registries.ts'
import { onScreen, usePortTick } from './hooks.ts'
import { collapsePatch, hasChildren, mindmapHidden, mindmapOf } from './model.ts'
import type { FeatureRuntime } from './runtime.ts'

export const MINDMAP_SOURCE = 'mindmap-collapse'

/** Keeps the overrides' hidden set equal to the scene's collapsed branches. Returns the uninstall. */
export function installCollapse(rt: FeatureRuntime): () => void {
  let overrides: RenderOverrides | null = null
  let last = ''
  const apply = () => {
    if (!overrides) return
    const hidden = mindmapHidden(rt.port.items())
    const key = [...hidden].sort().join(',')
    if (key === last) return
    last = key
    overrides.setHidden(MINDMAP_SOURCE, hidden.size ? hidden : null)
  }
  const cancel = onOverrides(rt.registries, (o) => {
    overrides = o
    last = ''
    apply()
  })
  const off = rt.port.on('changed', apply)
  return () => {
    cancel()
    off()
    overrides?.setHidden(MINDMAP_SOURCE, null)
  }
}

/** Collapses (or expands) a topic: its `mindmap.collapsed`, one transact step. */
export function setCollapsed(port: CanvasPort, topicId: string, collapsed: boolean): boolean {
  const el = port.get(topicId)
  if (!el || el.isDeleted) return false
  const patch = collapsePatch(el, collapsed)
  if (!patch) return false
  port.transact(collapsed ? 'Collapse' : 'Expand', (tx) =>
    tx.update(topicId, { customData: { lobby: patch } }),
  )
  return true
}

/** A chevron at the right edge of every topic that has children (outside the board wrapper: a DOM button). */
export function makeCollapseChevrons(rt: FeatureRuntime) {
  return function CollapseChevrons({ port }: OverlayLayerProps) {
    usePortTick(port, ['changed', 'viewportChanged'])
    const items = port.items()
    const out = []
    for (const el of items) {
      const m = mindmapOf(el)
      if (!m || rt.registries.hidden.isHidden(el.id) || !hasChildren(items, el.id)) continue
      const b = port.bounds(el.id)
      if (!b) continue
      const at = onScreen(port, b.x + b.width, b.y + b.height / 2)
      if (!at) continue
      out.push(
        <button
          key={el.id}
          type="button"
          data-lobby-collapse={el.id}
          data-collapsed={m.collapsed ? '1' : '0'}
          aria-label={m.collapsed ? 'Expand branch' : 'Collapse branch'}
          disabled={!rt.canEdit()}
          onClick={() => setCollapsed(port, el.id, !m.collapsed)}
          style={{
            position: 'fixed',
            left: at.x + 4,
            top: at.y - 11,
            width: 22,
            height: 22,
            padding: 0,
            borderRadius: 11,
            border: '1px solid #99a',
            background: '#fff',
            font: '700 12px/20px system-ui, sans-serif',
            cursor: 'pointer',
            zIndex: 8,
          }}
        >
          {m.collapsed ? '+' : '−'}
        </button>,
      )
    }
    return createPortal(out, document.body)
  }
}
