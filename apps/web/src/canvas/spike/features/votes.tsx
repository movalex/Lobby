// The vote custom tool (docs/EXCALIDRAW-MIGRATION.md §2.7 "Voting", §4.4; checks R2, F13, B12): a click
// (or a tap) on an object casts one of my dots through the api and never selects it (taking a dot back is
// `voteAt(…, -1)`, the test hooks' `unvote`). Allowed for every role that may vote (commenters, viewers and limited guests too: `readOnlyAllowed`),
// because the interaction config leaves custom tools on for them (§2.3.2). My dots are drawn as badges.
import type { OverlayLayerProps, PointerToolSpec } from '../../registries.ts'
import { onScreen, usePortTick, useSubscription } from './hooks.ts'
import { voteRefOf, voteTargetOf } from './model.ts'
import type { FeatureRuntime } from './runtime.ts'
import type { WorkshopStore } from './workshop.ts'

export const VOTE_TOOL = 'vote'
export const VOTE_CUSTOM_TYPE = 'lobby-vote'

/** Casts on what a press at `hit` targets; the result is also toasted. */
export async function voteAt(
  rt: FeatureRuntime,
  store: WorkshopStore,
  hitId: string | null,
  delta: 1 | -1 = 1,
): Promise<{ ok: boolean; code?: string; ref?: string }> {
  const target = voteTargetOf(hitId ? (rt.port.get(hitId) ?? null) : null, (id) => rt.port.get(id))
  const ref = voteRefOf(target)
  if (!ref) {
    rt.toast("That can't take a vote")
    return { ok: false, code: 'NOT_ELIGIBLE' }
  }
  const r = await store.cast(ref, delta)
  if (r.ok) {
    const left = store.openVote?.myRemaining
    rt.toast(delta === 1 ? `Voted${left !== undefined ? ` · ${left} left` : ''}` : 'Vote taken back')
    return { ok: true, ref }
  }
  rt.toast(
    r.code === 'NO_VOTE'
      ? 'No vote is running'
      : r.code === 'NOT_ELIGIBLE'
        ? "That can't take a vote"
        : r.code === 'BUDGET_EXCEEDED' || r.code === 'NO_VOTES_LEFT'
          ? 'No dots left'
          : "Couldn't vote",
  )
  return { ok: false, code: r.code, ref }
}

export function voteTool(rt: FeatureRuntime, store: WorkshopStore): PointerToolSpec {
  return {
    id: VOTE_TOOL,
    customType: VOTE_CUSTOM_TYPE,
    readOnlyAllowed: true,
    cursor: 'crosshair',
    onPointerDown(_point, hit) {
      void voteAt(rt, store, hit?.id ?? null, 1)
    },
  }
}

/** My dots on each object (a vote's other ballots never reach this client before the reveal). */
export function makeVoteBadges(rt: FeatureRuntime, store: WorkshopStore) {
  return function VoteBadges({ port }: OverlayLayerProps) {
    usePortTick(port, ['changed', 'viewportChanged'])
    useSubscription(store.subscribe)
    const v = store.voteState
    if (!v) return null
    const out = []
    for (const [ref, count] of Object.entries(v.myVotes)) {
      const id = ref.startsWith('shape:') ? ref.slice(6) : null
      if (!id || rt.registries.hidden.isHidden(id)) continue
      const b = port.bounds(id)
      if (!b) continue
      const at = onScreen(port, b.x, b.y)
      if (!at) continue
      out.push(
        <div
          key={ref}
          data-lobby-vote-badge={id}
          data-count={count}
          style={{
            position: 'fixed',
            left: at.x - 8,
            top: at.y - 10,
            padding: '1px 6px',
            borderRadius: 10,
            background: '#e03131',
            color: '#fff',
            font: '700 11px/16px system-ui, sans-serif',
            pointerEvents: 'none',
            zIndex: 6,
          }}
        >
          ●{count}
        </div>,
      )
    }
    return <>{out}</>
  }
}
