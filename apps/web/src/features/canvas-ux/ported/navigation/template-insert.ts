// Inserting a template into the open board on the new canvas (PRE-02/03): `@draftroom/templates/scene`
// emits the template's elements (the same plan as the tldraw build's records), placed in empty space near
// the view's centre, on top of existing content, selected, brought into view, and one undo step.
//
// BLOCKED BY CR-2D-2: prepared elements (a note with its engine-laid-out label, a box with its label, a
// bound arrow) go in through `LobbyTx.insert(elements)`, which the contracts owner and 2C are adding;
// `tx.create` would rebuild them. Until it lands, the insert fails with the "could not be added" notice
// (a NotImplementedError naming the change request), and nothing is written.
//
// CR-2D-1: the room refuses a label created in the same push as its new LOCKED container, so locked
// containers (the templates' image slots) go in unlocked and are locked by a second write folded into the
// same undo step (`joinPrevious`), as 2D's spec does.
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { instantiateSceneTemplate, isTemplateId, type TemplateId } from '@draftroom/templates/scene'
import {
  type Bounds,
  type CanvasElement,
  items,
  type LobbyCanvas,
  type LobbyTx,
  NotImplementedError,
} from '../../../../canvas/api/index.ts'
import { findEmptySpot, type Point, type Rect } from '../../placement.ts'
import { boxOf } from './camera.ts'

export type InsertTemplateResult =
  | { ok: true; ids: string[]; bounds: Bounds }
  | { ok: false; reason: 'readonly' | 'too-many-shapes' | 'failed' | 'unknown' }

/** What a transaction offers for prepared elements once CR-2D-2 lands (`LobbyTx.insert`). */
type InsertingTx = LobbyTx & { insert?(elements: readonly unknown[]): string[] }

/** Writes prepared elements through `tx.insert` (CR-2D-2); throws (so nothing is applied) until it exists. */
export function insertElements(tx: LobbyTx, elements: readonly unknown[]): string[] {
  const insert = (tx as InsertingTx).insert
  if (typeof insert !== 'function') throw new NotImplementedError('contracts', 'tx.insert (CR-2D-2)')
  return insert.call(tx, elements)
}

/** Scene bounds of the board's top-level items (frames hold their children; no bound labels). */
function topLevelObstacles(canvas: LobbyCanvas): Rect[] {
  const out: Rect[] = []
  for (const e of items.contentItems(canvas.items())) {
    if (e.frameId) continue
    const b = boxOf(e)
    out.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return out
}

/** The board's top fractional index (the template goes on top). */
function topIndex(canvas: LobbyCanvas): string | null {
  let top: string | null = null
  for (const e of canvas.items()) if (e.index && (top === null || e.index > top)) top = e.index
  return top
}

/** Lobby's fonts are in (text layout measures with them: the scene must be built after they load). */
async function fontsReady(): Promise<void> {
  try {
    await (globalThis.document as Document | undefined)?.fonts?.ready
  } catch {
    // measure with what there is
  }
}

export async function insertTemplate(
  canvas: LobbyCanvas,
  templateId: string,
  opts: { near?: Point; animate?: boolean; select?: boolean } = {},
): Promise<InsertTemplateResult> {
  if (canvas.readOnly()) return { ok: false, reason: 'readonly' }
  if (!isTemplateId(templateId)) return { ok: false, reason: 'unknown' }
  const id = templateId as TemplateId
  try {
    await fontsReady()
    // measure at the origin, pick a free spot of that size, then build for real (fresh ids each call)
    const probe = instantiateSceneTemplate(id, { origin: { x: 0, y: 0 } })
    const v = canvas.viewport.get()
    const near = opts.near ?? { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    const spot = findEmptySpot({ w: probe.bounds.w, h: probe.bounds.h }, near, topLevelObstacles(canvas), {
      gap: 120,
    })
    const origin = { x: Math.round(spot.x - probe.bounds.x), y: Math.round(spot.y - probe.bounds.y) }
    const scene = instantiateSceneTemplate(id, { origin, indexAbove: topIndex(canvas) })
    const newItems = scene.elements.filter(
      (e) => !(e.type === 'text' && (e as { containerId?: string | null }).containerId),
    )
    if (items.contentItems(canvas.items()).length + newItems.length > MAX_ITEMS)
      return { ok: false, reason: 'too-many-shapes' }
    // CR-2D-1: locked containers with a label go in unlocked, then are locked in the same undo step
    const lockLater = new Set(
      scene.elements
        .filter(
          (e) =>
            e.locked && ((e.boundElements as { type: string }[] | null) ?? []).some((b) => b.type === 'text'),
        )
        .map((e) => e.id),
    )
    const elements = scene.elements.map((e) => (lockLater.has(e.id) ? { ...e, locked: false } : e))
    canvas.transact(`insert template ${id}`, (tx) => insertElements(tx, elements))
    if (lockLater.size) {
      canvas.transact(
        `insert template ${id}`,
        (tx) => {
          for (const lid of lockLater) tx.update(lid, { locked: true })
        },
        { joinPrevious: true },
      )
    }
    const present = scene.topLevelIds.filter((x) => {
      const el: CanvasElement | undefined = canvas.get(x)
      return !!el && !el.isDeleted
    })
    if (present.length !== scene.topLevelIds.length) return { ok: false, reason: 'failed' }
    if (opts.select !== false) canvas.select(scene.topLevelIds)
    const bounds = { x: scene.bounds.x, y: scene.bounds.y, width: scene.bounds.w, height: scene.bounds.h }
    canvas.viewport.zoomTo(bounds, { maxZoom: 1, ...(opts.animate === false ? {} : { animate: true }) })
    return { ok: true, ids: scene.topLevelIds, bounds }
  } catch (e) {
    console.error('template insert failed', e)
    return { ok: false, reason: 'failed' }
  }
}
