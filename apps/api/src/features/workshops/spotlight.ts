// Spotlight for everyone (wave L, L5-2): a facilitator names the objects being discussed and every web build
// dims the rest of the board around them, without taking anyone's camera (summon and present stay for a full
// takeover). One spotlight per board, kept IN MEMORY like the raised hands and the live presentation: nothing is
// stored, and a restart of this api process drops every spotlight (the facilitator starts it again; clients see
// the new epoch). Scope: one API process (docs/DEPLOY.md runs one instance). During a deploy two instances run for a
// moment (the EVT-2 caveat of the other in-memory state): a spotlight started on one is not seen by streams on the
// other, and a facilitator starts it again. The api is the authority: it checks the objects against the board's shape index, decides who
// may start and end it, and publishes the whole state after every change (`workshop.spotlight`, versioned like
// the hands queue so a late response never undoes a newer event). GET /workshop carries it for late joiners.
//
// Permissions (the UI only hides controls):
// - start: `edit` and an account (facilitators.ts: a name-only guest never spotlights), at most one start per
//   person and board per cooldown (a summon-like 429 with Retry-After);
// - end: the person who started it, or a board owner (`manage_access`); idempotent;
// - read: `view` (the state rides on GET /workshop).
// Lifetime: it ends by itself after SPOTLIGHT_MAX_MS, and when its starter has had no event stream on the board
// for SPOTLIGHT_STARTER_GRACE_MS (a reload keeps it; a closed tab does not leave the room dimmed for five
// minutes). Every published payload is safe for every viewer: object refs and a name already shown on the board.

import {
  SPOTLIGHT_MAX_MS,
  type Spotlight,
  type SpotlightEndReason,
  SpotlightInput,
  type SpotlightState,
  type SpotlightVersion,
  type WorkshopSpotlightEvent,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { badRequest, parse } from '../../errors.ts'
import { rateLimited } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { requireFacilitatorAccount } from './facilitators.ts'
import type { ShapeIndex } from './shapes.ts'

/** The starter without an event stream on the board for this long: the spotlight ends (a reload is well within). */
export const SPOTLIGHT_STARTER_GRACE_MS = 5_000
/** Minimum time between two starts by one person on one board (summon's). */
export const SPOTLIGHT_COOLDOWN_MS = 3_000

export interface SpotlightActor {
  id: string
  name: string
}

interface Active {
  refs: readonly string[]
  bringEveryone: boolean
  by: SpotlightActor
  startedAt: number
  version: SpotlightVersion
  /** When the starter's last event stream on the board ended (null while they have one). */
  goneSince: number | null
}

export interface SpotlightRegistryOptions {
  now: () => Date
  /** Receives every change (already applied): publish it to the board. */
  publish(boardId: string, event: WorkshopSpotlightEvent): void
  /** Whether the person has an open event stream on the board right now. */
  online(boardId: string, userId: string): boolean
  maxMs?: number
  graceMs?: number
}

export class SpotlightRegistry {
  private readonly active = new Map<string, Active>()
  private readonly now: () => number
  private readonly publishFn: SpotlightRegistryOptions['publish']
  private readonly online: SpotlightRegistryOptions['online']
  private readonly maxMs: number
  private readonly graceMs: number
  /** This process's states are ordered by `changes`; a restart has another epoch. */
  private readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  private changes = 0

  constructor(opts: SpotlightRegistryOptions) {
    this.now = () => opts.now().getTime()
    this.publishFn = opts.publish
    this.online = opts.online
    this.maxMs = opts.maxMs ?? SPOTLIGHT_MAX_MS
    this.graceMs = opts.graceMs ?? SPOTLIGHT_STARTER_GRACE_MS
  }

  /** The version of every state handed out now (states taken later are never older). */
  version(): SpotlightVersion {
    return { epoch: this.epoch, n: this.changes }
  }

  /** How many boards have a spotlight (diagnostics, tests). */
  size(): number {
    return this.active.size
  }

  /** The board's spotlight after sweeping it (null: none). */
  get(boardId: string): Spotlight | null {
    this.sweep(boardId)
    return this.view(boardId)
  }

  /** Spotlights `refs` (already checked against the board) for everyone; replaces the board's current one. */
  start(
    boardId: string,
    actor: SpotlightActor,
    input: { refs: readonly string[]; bringEveryone: boolean },
  ): Spotlight {
    this.sweep(boardId)
    const at = this.now()
    this.changes++
    this.active.set(boardId, {
      refs: [...input.refs],
      bringEveryone: input.bringEveryone,
      by: { id: actor.id, name: actor.name },
      startedAt: at,
      version: this.version(),
      // started without an open stream (a script): it ends after the grace like a closed tab
      goneSince: this.online(boardId, actor.id) ? null : at,
    })
    this.emit(boardId, null, null)
    return this.view(boardId) as Spotlight
  }

  /**
   * Ends the board's spotlight: `by` is the person who did (their right was checked by the route). False when
   * there was none (idempotent: nothing is published then).
   */
  end(boardId: string, by: SpotlightActor, asOwner: boolean): boolean {
    this.sweep(boardId)
    if (!this.active.has(boardId)) return false
    this.drop(boardId, asOwner ? 'ended-by-owner' : 'ended', by)
    return true
  }

  /** Who started the board's spotlight, or null. */
  starterOf(boardId: string): string | null {
    this.sweep(boardId)
    return this.active.get(boardId)?.by.id ?? null
  }

  /** Ends what is due on one board, or on every board with a spotlight. */
  sweep(boardId?: string): void {
    const boards = boardId === undefined ? [...this.active.keys()] : [boardId]
    const at = this.now()
    for (const b of boards) {
      const s = this.active.get(b)
      if (!s) continue
      if (at - s.startedAt >= this.maxMs) {
        this.drop(b, 'expired', null)
        continue
      }
      if (this.online(b, s.by.id)) {
        s.goneSince = null
        continue
      }
      s.goneSince ??= at
      if (at - s.goneSince >= this.graceMs) this.drop(b, 'starter-left', null)
    }
  }

  /** Sweeps every `intervalMs` (unref'd); returns the stop function. */
  startSweeper(intervalMs = 1_000): () => void {
    const t = setInterval(() => this.sweep(), intervalMs)
    t.unref?.()
    return () => clearInterval(t)
  }

  // ---- internals --------------------------------------------------------------------------------------

  private view(boardId: string): Spotlight | null {
    const s = this.active.get(boardId)
    if (!s) return null
    return {
      refs: [...s.refs],
      bringEveryone: s.bringEveryone,
      by: { userId: s.by.id, name: s.by.name },
      startedAt: new Date(s.startedAt).toISOString(),
      endsAt: new Date(s.startedAt + this.maxMs).toISOString(),
      version: s.version,
    }
  }

  private drop(boardId: string, reason: SpotlightEndReason, by: SpotlightActor | null) {
    this.active.delete(boardId)
    this.changes++
    this.emit(boardId, reason, by)
  }

  private emit(boardId: string, reason: SpotlightEndReason | null, by: SpotlightActor | null) {
    this.publishFn(boardId, {
      spotlight: this.view(boardId),
      version: this.version(),
      reason,
      endedBy: by ? { userId: by.id, name: by.name } : null,
    })
  }
}

// ---- routes -------------------------------------------------------------------------------------------

export interface SpotlightRouteOptions {
  registry: SpotlightRegistry
  shapes: ShapeIndex
  /** Minimum time between two starts by one person on one board. */
  cooldownMs?: number
}

export function registerSpotlightRoutes(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: SpotlightRouteOptions,
): void {
  const { db, now } = ctx
  const { registry, shapes } = opts
  const cooldown = opts.cooldownMs ?? SPOTLIGHT_COOLDOWN_MS
  const lastStart = new Map<string, number>()

  const body = (spotlight: Spotlight | null): SpotlightState => ({
    spotlight,
    version: registry.version(),
    serverNow: now().toISOString(),
  })

  app.post('/api/boards/:bid/spotlight', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(SpotlightInput, req.body)
    const access = await requireBoardAction(db, bid, user.id, 'edit')
    await requireFacilitatorAccount(db, user.id)
    const boardId = access.board.id
    // A refused start (too soon, or objects that are gone) never costs a snapshot or a cooldown.
    const key = `${boardId}/${user.id}`
    const t = now().getTime()
    const last = lastStart.get(key)
    if (last !== undefined && t >= last && t - last < cooldown)
      throw rateLimited(cooldown - (t - last), 'Everyone was just shown something. Wait a moment.')
    const refs = [...new Set(input.refs)]
    // Every object must be on the board now, as the canvas authority (sync) has it: a deleted one is gone.
    const map = await shapes.get(boardId, { maxAgeMs: 0 })
    const missing = refs.filter((r) => !map.has(r)).length
    if (missing > 0)
      throw badRequest(
        missing === 1
          ? 'refs: one of the objects is not on this board any more'
          : `refs: ${missing} of the objects are not on this board any more`,
      )
    lastStart.set(key, t)
    if (lastStart.size > 5_000) lastStart.delete(lastStart.keys().next().value as string)
    const spotlight = registry.start(
      boardId,
      { id: user.id, name: user.name },
      { refs, bringEveryone: input.bringEveryone },
    )
    return body(spotlight)
  })

  app.post('/api/boards/:bid/spotlight/end', async (req) => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    // Anyone who can see the board may ask; only the starter or an owner is let through below.
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const boardId = access.board.id
    const starter = registry.starterOf(boardId)
    if (starter !== null && starter !== user.id) {
      await requireBoardAction(db, boardId, user.id, 'manage_access')
      registry.end(boardId, { id: user.id, name: user.name }, true)
    } else if (starter !== null) {
      registry.end(boardId, { id: user.id, name: user.name }, false)
    }
    return body(registry.get(boardId))
  })
}
