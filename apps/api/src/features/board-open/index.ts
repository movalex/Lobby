// OWNER: W5 (wave M, M5-1; S4, PWR-8, CAP-PG-OPEN). One read for the board-open burst:
//
//   GET /api/boards/:bid/open-state → 200 OpenStateBody (@draftroom/contracts board-open.ts), Cache-Control: no-store
//
// The panel reads a board page fires when it opens took 0.4-1.1 s at p95 together on the 0.1-CPU Postgres, against
// about 5 ms alone: each ran its own session lookup and access check, and they queued. This answers them together:
//   1. the board's event position (hub.boardPosition), before anything is read;
//   2. one session lookup (ctx.requireUser), and the 'me' freshen the threads route makes (no provider call inside
//      the transaction: freshenThen decides before it starts);
//   3. one pooled client, one READ ONLY transaction: one access check (requireBoardAction 'view', the check every
//      part's route makes first), then each part, one after the other (no fan-out), by the loader its own route
//      uses (./parts.ts; the AI status through features/ai createAiLoaders, W8's);
//   4. after it commits, the parts that may not run inside a transaction (the workshop: ./parts.ts), on the pool.
// A part this caller may not read (its loader refuses with a 403 or 404, as its route would) is null; a caller who
// may not view the board gets every part null, whatever the id, and no event position. A server error fails the
// whole answer, and the web then makes the separate reads.

import {
  clientRevOf,
  LOBBY_CLIENT_HEADER,
  OPEN_STATE_PARTS,
  OPEN_STATE_ROUTE,
  type OpenState,
  type OpenStateBody,
  type OpenStatePart,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError } from '../../errors.ts'
import { createAiLoaders } from '../ai/index.ts'
import type { FeatureContext } from '../context.ts'
import { openStatePartsOf, type PartCaller } from './parts.ts'

/** One loader, as the route calls it (the part's own type is its loader's; this only reads and stores it). */
interface AnyPartLoader {
  load(q: Queryable, caller: PartCaller): Promise<unknown>
  inTransaction?: boolean
}

/** A refusal its route would answer (its 'view' check, or the part's own): the part is null. */
const isRefusal = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404)

async function partOrNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (e) {
    if (isRefusal(e)) return null
    throw e
  }
}

const allNull = (): OpenState =>
  Object.fromEntries(OPEN_STATE_PARTS.map((p) => [p, null])) as unknown as OpenState

/** The parts a feature provides (./parts.ts); the AI status is built here from features/ai's loaders. */
const PROVIDED_PARTS = OPEN_STATE_PARTS.filter((p) => p !== 'ai')

export async function registerBoardOpen(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  const ai = createAiLoaders(ctx)

  // Every part's feature registered its loader: a renamed or dropped one stops the api at start-up, never a
  // silently empty part.
  app.addHook('onReady', async () => {
    const parts = openStatePartsOf(ctx)
    const missing = PROVIDED_PARTS.filter((p) => !parts[p])
    if (missing.length) throw new Error(`open-state: no loader for ${missing.join(', ')}`)
  })

  app.get(OPEN_STATE_ROUTE, async (req, reply): Promise<OpenStateBody> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    // 1. before anything is read: an event published after this moves the position
    const position = ctx.events.boardPosition(bid)
    const rev = clientRevOf(req.headers[LOBBY_CLIENT_HEADER])
    reply.header('cache-control', 'no-store')
    return ctx.identity.freshenThen(req, user, async (fresh) => {
      const parts = openStatePartsOf(ctx) as Partial<Record<OpenStatePart, AnyPartLoader>>
      const out = allNull()
      const set = (part: OpenStatePart, value: unknown) => {
        ;(out as Record<OpenStatePart, unknown>)[part] = value
      }
      const caller = await db.transaction(async (tx): Promise<PartCaller | null> => {
        await tx.query('SET TRANSACTION READ ONLY')
        let access: PartCaller['access']
        try {
          access = await requireBoardAction(tx, bid, fresh.id, 'view')
        } catch (e) {
          if (isRefusal(e)) return null
          throw e
        }
        const c: PartCaller = { access, user: fresh, rev }
        for (const part of OPEN_STATE_PARTS) {
          if (part === 'ai') {
            set('ai', await partOrNull(() => ai.loadAiStatus(access, fresh.id, tx)))
            continue
          }
          const loader = parts[part]
          if (!loader || loader.inTransaction === false) continue
          set(part, await partOrNull(() => loader.load(tx, c)))
        }
        return c
      })
      if (!caller) return out
      // 4. the parts that read on the pool, after the transaction let its client go
      for (const part of PROVIDED_PARTS) {
        const loader = parts[part]
        if (loader?.inTransaction === false) set(part, await partOrNull(() => loader.load(db, caller)))
      }
      return { ...out, eventsSeq: position }
    })
  })
}
