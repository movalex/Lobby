// Wave M (W2, M2-1, FTU-6): the board's one top-centre stack (the model and the reasons: ./top-centre.ts).
//
//  - `OverlayRoot` (canvas/board/chrome.tsx) renders `<TopCentreStack>` in its screen layer and provides its node to the
//    layers through `TopCentreContext`;
//  - a feature puts its top-centre box in the stack with `<TopCentreItem slot="spotlight">…</TopCentreItem>`: the box
//    is rendered into the stack (a React portal: its state, props and test ids are the feature's own) in the slot's
//    place, and takes no place at all while it renders nothing. Without a stack (a test, anything outside the board's
//    overlay) it renders where it is put, as it did before the stack;
//  - `useTopCentre` measures the stack: it registers the box as the `top-centre` obstacle (lib/overlay-obstacles.ts,
//    in client pixels, the stack and the toasts under it), tells the toasts where the stack ends (CSS variables on the
//    page's root, ./top-centre.css) and watches the undo toasts (./toast-watch.ts).
// Nothing here reads or writes the board.

import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { OBSTACLE_IDS, type Rect, registerObstacle } from '../../lib/overlay-obstacles.ts'
import { react, untracked } from '../../lib/signals.ts'
import type { FeatureRegistries } from '../api/registries.ts'
import { watchUndoToasts } from './toast-watch.ts'
import { layoutStack, slotOrder, type TopCentreSlot } from './top-centre.ts'
import './top-centre.css'

/** undefined: no stack (render in place); null: the stack's node is not attached yet; else the stack's node. */
export const TopCentreContext = createContext<HTMLElement | null | undefined>(undefined)

// ---- a change counter, for what is drawn near the stack (cursor chips, compass chips) ------------------------------

let revision = 0
const listeners = new Set<() => void>()
const bump = () => {
  revision += 1
  for (const l of [...listeners]) l()
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** Re-renders when the stack's contents or place changed. */
export const useTopCentreRevision = (): number =>
  useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  )

// ---- the stack and its items ----------------------------------------------------------------------------------------

/** The stack's own box (an empty column until something is put in it). `attach` receives its node. */
export function TopCentreStack({ attach }: { attach: (node: HTMLElement | null) => void }) {
  return (
    <div ref={attach} className="lobby-top-centre" data-testid="top-centre-stack" data-lobby-top-centre="" />
  )
}

/** A feature's top-centre box, in the stack in `slot`'s place (see the header). */
export function TopCentreItem({ slot, children }: { slot: TopCentreSlot; children: ReactNode }) {
  const node = useContext(TopCentreContext)
  if (node === undefined) return <>{children}</>
  if (node === null) return null
  return createPortal(
    <div className="lobby-top-centre__item" data-slot={slot} style={{ order: slotOrder(slot) }}>
      {children}
    </div>,
    node,
  )
}

// ---- measuring ------------------------------------------------------------------------------------------------------

const PROP_BOTTOM = '--lobby-top-centre-bottom'
const PROP_CENTRE = '--lobby-top-centre-x'

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}
const rectOf = (el: Element): Rect => {
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, width: b.width, height: b.height }
}

/** What is drawn in the stack now, with its heights. */
const drawn = (node: HTMLElement) =>
  [...node.children].flatMap((c) => {
    const slot = (c as HTMLElement).dataset.slot as TopCentreSlot | undefined
    const h = c.getBoundingClientRect().height
    return slot && h > 0 ? [{ slot, height: h }] : []
  })

/**
 * Keeps the stack's measures: the obstacle, the toasts' place and the undo toasts' life. `registries` answers whether
 * a popover is open. Call from the component that renders the stack (`node`: its element once attached).
 */
export function useTopCentre(node: HTMLElement | null, registries: FeatureRegistries): void {
  useEffect(() => {
    if (!node) return
    const doc = node.ownerDocument
    const root = doc.documentElement
    const toasts = () => doc.querySelector('.dr-notices')
    const measure = () => {
      const items = drawn(node)
      const layout = layoutStack(items)
      if (layout.toastsTop === null) {
        root.style.removeProperty(PROP_BOTTOM)
        root.style.removeProperty(PROP_CENTRE)
      } else {
        const box = node.getBoundingClientRect()
        root.style.setProperty(PROP_BOTTOM, `${Math.ceil(box.top + layout.toastsTop)}px`)
        root.style.setProperty(PROP_CENTRE, `${Math.round(box.left + box.width / 2)}px`)
      }
      bump()
    }
    const sized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    sized?.observe(node)
    if (node.parentElement) sized?.observe(node.parentElement)
    const changed = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null
    changed?.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    const win = doc.defaultView
    win?.addEventListener('resize', measure)
    measure()
    const offObstacle = registerObstacle(OBSTACLE_IDS.topCentre, 'stack', () => {
      if (!drawn(node).length) return null
      const own = rectOf(node)
      const t = toasts()
      if (!t?.children.length) return own
      return union(own, rectOf(t))
    })
    return () => {
      offObstacle()
      sized?.disconnect()
      changed?.disconnect()
      win?.removeEventListener('resize', measure)
      root.style.removeProperty(PROP_BOTTOM)
      root.style.removeProperty(PROP_CENTRE)
      bump()
    }
  }, [node])

  useEffect(() => {
    if (!node) return
    return watchUndoToasts({
      doc: node.ownerDocument,
      menusOpen: () => registries.menusOpen.call(),
      // the answer reads the menus' own signals (canvas-ux), so it is a reactive read: asked again when one changes,
      // and read anew when the provider is (re)registered (canvas-ux provides it on mount, after this starts)
      onMenusChange: (l) => {
        let stop = () => {}
        const arm = () => {
          stop()
          stop = react('lobby-top-centre-menus', () => {
            registries.menusOpen.call()
            untracked(l)
          })
        }
        arm()
        const off = registries.subscribe(arm)
        return () => {
          off()
          stop()
        }
      },
    })
  }, [node, registries])
}
