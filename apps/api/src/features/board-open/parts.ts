// The board-open read's parts (wave M, M5-1), each built by the SAME loader its own route answers with: the route
// keeps its permission check (requireBoardAction 'view') and hands the loader the access it got; GET
// /api/boards/:bid/open-state (./index.ts) makes that check once and calls every loader with it. A feature
// provides its loader while it registers (provideOpenStatePart); nothing is duplicated, so a part can never answer
// what its route would not.
//
// A loader:
//   - gets `q` (the connection to read on: the route's pool, or open-state's one READ ONLY transaction), the access
//     that already passed 'view', the caller (the session's user, after the 'me' freshen the route makes), and the
//     caller's web build revision (what its answer may carry: contracts client-rev.ts);
//   - throws an ApiError (403, 404) when this caller may not read the part, exactly as its route would answer;
//   - reads on `q` only. `inTransaction: false` marks one that must not run inside a transaction (it may need the
//     pool for something else, which a transaction holding a pooled client could wait on forever with a capped
//     pool): open-state runs it after its transaction, still sequentially.

import type { OpenState, OpenStatePart } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { BoardAccess } from '../../access.ts'
import type { SessionUser } from '../../auth/session.ts'
import type { FeatureContext } from '../context.ts'

export interface PartCaller {
  /** passed 'view' (requireBoardAction) */
  access: BoardAccess
  user: SessionUser
  /** the caller's LOBBY_CLIENT_REV (clientRevOf) */
  rev: number
}

export type PartBody<P extends OpenStatePart> = NonNullable<OpenState[P]>

export interface PartLoader<P extends OpenStatePart> {
  load(q: Queryable, caller: PartCaller): Promise<PartBody<P>>
  /** false: run outside any transaction (on the pool), see above. Default true. */
  inTransaction?: boolean
}

type Provided = { [P in OpenStatePart]?: PartLoader<P> }

const provided = new WeakMap<FeatureContext, Provided>()

/** A feature's loader for its part (called while the feature registers, once per app). */
export function provideOpenStatePart<P extends OpenStatePart>(
  ctx: FeatureContext,
  part: P,
  loader: PartLoader<P>,
): void {
  let parts = provided.get(ctx)
  if (!parts) {
    parts = {}
    provided.set(ctx, parts)
  }
  if (parts[part]) throw new Error(`open-state: the '${part}' part is provided twice`)
  ;(parts as Record<string, unknown>)[part] = loader
}

/** The loaders the features of this app provided. */
export function openStatePartsOf(ctx: FeatureContext): Provided {
  return provided.get(ctx) ?? {}
}
