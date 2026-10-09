// OWNER: W4 (wave L, L4-1). Applies a connected-shape plan (./planner.ts) as ONE undo step, the mind map's draft
// pattern (features/mindmap/ported/draft.ts, copied, not shared):
//
//  - transact 1 creates the new shape and the connector, the connector's whole path unit in its creation props
//    (and grows the frame that holds them, when the plan says so);
//  - transact 2 joins the first's undo step (`joinPrevious`) and binds both ends with LobbyTx.bind (a creation
//    cannot carry a binding: the engine's newArrowElement starts every arrow unbound); a note joins its frame
//    there too (the note builder takes no frame).
//
// Nothing here computes a bound endpoint: the room re-snaps the connector in the commit of the bind
// (apps/sync/src/room/fit.ts) and every tab receives that.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import type { ConnectedPlan, planConnector } from './planner.ts'

export const FLOW_UNDO_LABEL = 'flow: next shape'
export const CONNECT_UNDO_LABEL = 'flow: connect'

/** Creates the plan's shape and connector and binds the connector (one undo step); returns their ids. */
export function applyConnected(
  canvas: Pick<LobbyCanvas, 'transact'>,
  plan: ConnectedPlan,
): { shapeId: string; arrowId: string } {
  canvas.transact(FLOW_UNDO_LABEL, (tx) => {
    const g = plan.frameGrow
    if (g) tx.update(g.id, { x: g.x, y: g.y, width: g.width, height: g.height })
    tx.create(plan.shape.kind, plan.shape.props)
    tx.create('arrow', plan.arrow)
  })
  canvas.transact(
    FLOW_UNDO_LABEL,
    (tx) => {
      tx.bind(plan.arrowId, 'start', plan.sourceId)
      tx.bind(plan.arrowId, 'end', plan.shapeId)
      if (plan.shape.kind === 'note' && plan.frameId) tx.setFrame([plan.shapeId], plan.frameId)
    },
    { joinPrevious: true },
  )
  return { shapeId: plan.shapeId, arrowId: plan.arrowId }
}

/** Creates a connector between two existing shapes and binds it (one undo step); returns its id. */
export function applyConnector(
  canvas: Pick<LobbyCanvas, 'transact'>,
  fromId: string,
  toId: string,
  plan: NonNullable<ReturnType<typeof planConnector>>,
): string {
  canvas.transact(CONNECT_UNDO_LABEL, (tx) => {
    tx.create('arrow', plan.arrow)
  })
  canvas.transact(
    CONNECT_UNDO_LABEL,
    (tx) => {
      tx.bind(plan.arrowId, 'start', fromId)
      tx.bind(plan.arrowId, 'end', toId)
    },
    { joinPrevious: true },
  )
  return plan.arrowId
}
