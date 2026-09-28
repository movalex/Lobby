// Present to everyone (docs/WAVE4-CONTRACTS.md "present-live"; checklist PRS-07, PRS-12, FAC-01).
//
// One live presentation per board, kept IN MEMORY (like raised hands: nothing is stored). The api is
// the authority: it decides who presents, the current slide and who follows, and publishes the whole
// state after every change (`present.live`, idempotent to apply, versioned like the hands queue so a
// late response never undoes a newer event). Late joiners GET the same state.
//
// Presence comes from the board event streams the hub admitted (`events.userStreamCount`): a periodic
// sweep marks the presenter offline after PRESENTER_OFFLINE_NOTICE_MS without one (followers see
// "reconnecting"), ends the presentation after PRESENTER_GRACE_MS (a reload comes back well within it)
// and drops followers after FOLLOWER_GRACE_MS. An api restart forgets everything: the presenter's tab
// puts the same presentation back (`resumeId`) and followers re-follow on their resync.
//
// Permissions (every route; the UI only hides controls):
// - GET, follow / step out: `view` (viewers, commenters and name-only guests follow);
// - start, take over, claim a tab: `edit` and an account (a name-only guest never presents to everyone:
//   it takes over everyone's screen, and a guest identity costs nothing but a name);
// - slide and hand over: the presenter (`edit` re-checked), to someone who may present and is on the
//   board now; end: the presenter, or a board owner (`manage_access`).
// Every published payload is safe for every viewer: names already shown on the board, frame ids, counts.
//
// Abuse limits: slides per board, follow toggles per person, start/stop/hand-over per person (429s);
// follower changes are coalesced into at most one event per FOLLOWERS_PUBLISH_MS per board, so a
// room of guests toggling "Follow" cannot flood every open stream.

import { randomInt } from 'node:crypto'
import {
  FOLLOWER_GRACE_MS,
  FollowPresentationInput,
  HandOffPresentationInput,
  type LivePresentation,
  PRESENT_FOLLOWERS_LISTED,
  PRESENT_LIVE_EVENTS,
  PRESENTER_GRACE_MS,
  PRESENTER_OFFLINE_NOTICE_MS,
  type PresentChange,
  type PresentChangeKind,
  type PresentEndReason,
  type PresentLiveEvent,
  type PresentLiveState,
  type PresentLiveVersion,
  type PresentSlide,
  PresentSlideInput,
  StartPresentationInput,
  StopPresentationInput,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { ApiError, conflict, parse } from '../../errors.ts'
import { rateLimited, SlidingWindowLimiter } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `prs_` + 20 random base62 characters (the id shape of @draftroom/db ids, with its own prefix). */
export function newPresentationId(): string {
  let body = ''
  for (let i = 0; i < 20; i++) body += BASE62[randomInt(BASE62.length)]
  return `prs_${body}`
}

/** Ended presentation ids remembered (so none is "resumed"); ids are random, so this only bounds memory. */
const ENDED_IDS_KEPT = 5_000

/** Follower changes on one board are published at most this often (one event carries them all). */
export const FOLLOWERS_PUBLISH_MS = 300

/** Read when an app is built: tests lower or switch them off first. */
export const presentationSettings: {
  /** How often every presentation is swept without a request (0 = only on reads/writes). */
  sweepMs: number
  followersPublishMs: number
  /** Slide changes per board per second (holding an arrow key is coalesced by the client first). */
  slidesPerSecond: number
  /** Follow / step-out toggles per person per board, per 10 s. */
  followsPer10s: number
  /** Start / stop / hand-over / claim per person per board, per 10 s. */
  controlsPer10s: number
} = {
  sweepMs: 1_000,
  followersPublishMs: FOLLOWERS_PUBLISH_MS,
  slidesPerSecond: 30,
  followsPer10s: 12,
  controlsPer10s: 12,
}

export interface Actor {
  id: string
  name: string
}

interface Follower {
  name: string
  guest: boolean
  /** When their last event stream on the board ended (null while they have one). */
  goneSince: number | null
}

interface Session {
  id: string
  presenter: Actor
  tab: string | null
  slide: PresentSlide
  startedAt: Date
  presenterOnline: boolean
  presenterGoneSince: number | null
  followers: Map<string, Follower>
}

/** A request the rules refuse (the route maps the code to 409, or 403 for GUEST_ACCOUNT_REQUIRED). */
export class PresentRuleError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const ended = () => new PresentRuleError('NOT_PRESENTING', 'This presentation has ended.')

export interface PresentationRegistryOptions {
  now: () => Date
  /** Receives every change (already applied): publish it to the board. */
  publish(boardId: string, event: PresentLiveEvent): void
  /** Whether the person has an open event stream on the board right now. */
  online(boardId: string, userId: string): boolean
  offlineNoticeMs?: number
  graceMs?: number
  followerGraceMs?: number
  /** Coalescing window for follower changes (0 = publish each one at once). */
  followersPublishMs?: number
}

export class PresentationRegistry {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number
  private readonly publishFn: PresentationRegistryOptions['publish']
  private readonly online: PresentationRegistryOptions['online']
  private readonly offlineNoticeMs: number
  private readonly graceMs: number
  private readonly followerGraceMs: number
  private readonly followersPublishMs: number
  /** Boards with follower changes not published yet, and when each board last published them. */
  private readonly pendingFollowers = new Map<string, ReturnType<typeof setTimeout> | null>()
  private readonly lastFollowersPublish = new Map<string, number>()
  /** Presentations that ended in this process (oldest first, at most ENDED_IDS_KEPT). */
  private readonly endedIds = new Set<string>()
  private readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  private changes = 0

  constructor(opts: PresentationRegistryOptions) {
    this.now = () => opts.now().getTime()
    this.publishFn = opts.publish
    this.online = opts.online
    this.offlineNoticeMs = opts.offlineNoticeMs ?? PRESENTER_OFFLINE_NOTICE_MS
    this.graceMs = opts.graceMs ?? PRESENTER_GRACE_MS
    this.followerGraceMs = opts.followerGraceMs ?? FOLLOWER_GRACE_MS
    this.followersPublishMs = opts.followersPublishMs ?? FOLLOWERS_PUBLISH_MS
  }

  /** The version of every state handed out now (states taken later are never older). */
  version(): PresentLiveVersion {
    return { epoch: this.epoch, n: this.changes }
  }

  /** The board's presentation after sweeping it (null when nobody presents). */
  get(boardId: string): LivePresentation | null {
    this.sweep(boardId)
    return this.view(boardId)
  }

  /** How many boards have a presentation (diagnostics, tests). */
  size(): number {
    return this.sessions.size
  }

  /**
   * Present to everyone from `tab`. The presenter again: moves it to this tab (a reload lost the old
   * one's id, a hand-off left it unclaimed, "Present from this tab"). Someone else's: refused unless
   * they have been offline and `takeOver` is set. None: a new one (or `resumeId` after an api restart).
   */
  start(
    boardId: string,
    actor: Actor,
    input: { tab: string; slide: PresentSlide; resumeId?: string; takeOver?: boolean },
  ): LivePresentation {
    this.sweep(boardId)
    const s = this.sessions.get(boardId)
    const at = this.now()
    if (s && s.presenter.id === actor.id) {
      const moved = s.tab !== input.tab
      const slid =
        s.slide.slideId !== input.slide.slideId ||
        s.slide.index !== input.slide.index ||
        s.slide.count !== input.slide.count
      const back = !s.presenterOnline
      s.tab = input.tab
      s.slide = { ...input.slide }
      s.presenter = actor
      this.markPresenterOnline(s)
      if (moved) this.emit(boardId, 'claimed', null, actor)
      else if (slid) this.emit(boardId, 'slide', null, actor)
      else if (back) this.emit(boardId, 'presenter-online', null, null)
      return this.view(boardId) as LivePresentation
    }
    if (s) {
      if (s.presenterOnline) {
        throw new PresentRuleError(
          'ALREADY_PRESENTING',
          `${s.presenter.name} is presenting. Ask them to hand over, or wait until they end it.`,
        )
      }
      if (!input.takeOver) {
        throw new PresentRuleError(
          'PRESENTER_AWAY',
          `${s.presenter.name} lost the connection while presenting. You can take over the presentation.`,
        )
      }
      // Take over: the same presentation (followers keep following), a new presenter.
      s.presenter = actor
      s.tab = input.tab
      s.slide = { ...input.slide }
      s.followers.delete(actor.id)
      this.markPresenterOnline(s)
      this.emit(boardId, 'handoff', null, actor)
      return this.view(boardId) as LivePresentation
    }
    const resumed = !!input.resumeId && !this.endedIds.has(input.resumeId)
    const session: Session = {
      id: resumed && input.resumeId ? input.resumeId : newPresentationId(),
      presenter: actor,
      tab: input.tab,
      slide: { ...input.slide },
      startedAt: new Date(at),
      presenterOnline: true,
      presenterGoneSince: null,
      followers: new Map(),
    }
    this.sessions.set(boardId, session)
    this.emit(boardId, resumed ? 'resumed' : 'started', null, actor)
    return this.view(boardId) as LivePresentation
  }

  /** Throws unless `actorId` presents `id` from `tab` (the slide route asks before its rate limit). */
  assertPresentingTab(boardId: string, actorId: string, id: string, tab: string): void {
    this.sweep(boardId)
    this.presentingTab(boardId, actorId, id, tab)
  }

  /** The presenting tab moved to another slide. Returns whether anything changed. */
  slide(boardId: string, actorId: string, input: { id: string; tab: string; slide: PresentSlide }): boolean {
    this.sweep(boardId)
    const s = this.presentingTab(boardId, actorId, input.id, input.tab)
    this.markPresenterOnline(s)
    const same =
      s.slide.slideId === input.slide.slideId &&
      s.slide.index === input.slide.index &&
      s.slide.count === input.slide.count
    if (same) return false
    s.slide = { ...input.slide }
    this.emit(boardId, 'slide', null, s.presenter)
    return true
  }

  /** Ends it for everyone: the presenter, or (`asOwner`) a board owner. Idempotent for a gone id. */
  stop(boardId: string, actor: Actor, id: string, asOwner: boolean): boolean {
    this.sweep(boardId)
    const s = this.sessions.get(boardId)
    if (!s || s.id !== id) return false
    const presenter = s.presenter.id === actor.id
    if (!presenter && !asOwner) {
      throw new PresentRuleError('NOT_PRESENTER', 'Only the presenter or a board owner can end it.')
    }
    this.end(boardId, presenter ? 'stopped' : 'ended-by-owner', actor)
    return true
  }

  /** Makes `to` the presenter (the route checked that they may present and are on the board). */
  handOff(boardId: string, actor: Actor, id: string, to: Actor): LivePresentation {
    this.sweep(boardId)
    const s = this.presenterSession(boardId, actor.id, id)
    if (to.id === actor.id) return this.view(boardId) as LivePresentation
    // The old presenter keeps watching: they follow from now on.
    s.followers.delete(to.id)
    s.followers.set(actor.id, { name: actor.name, guest: false, goneSince: null })
    s.presenter = to
    s.tab = null
    this.markPresenterOnline(s)
    this.emit(boardId, 'handoff', null, actor)
    return this.view(boardId) as LivePresentation
  }

  /** Follow (or step out of) the presentation `id`. Returns whether anything changed. */
  follow(
    boardId: string,
    actor: Actor & { guest: boolean },
    id: string,
    following: boolean,
  ): { changed: boolean } {
    this.sweep(boardId)
    const s = this.sessions.get(boardId)
    if (!s || s.id !== id) {
      if (following) throw ended()
      return { changed: false }
    }
    if (s.presenter.id === actor.id) return { changed: false }
    const had = s.followers.get(actor.id)
    if (following) {
      if (had) {
        had.goneSince = null
        return { changed: false }
      }
      s.followers.set(actor.id, { name: actor.name, guest: actor.guest, goneSince: null })
    } else {
      if (!had) return { changed: false }
      s.followers.delete(actor.id)
    }
    this.followersChanged(boardId)
    return { changed: true }
  }

  /** Applies the presence rules to one board, or to every board with a presentation. */
  sweep(boardId?: string): void {
    const boards = boardId === undefined ? [...this.sessions.keys()] : [boardId]
    const at = this.now()
    for (const b of boards) {
      const s = this.sessions.get(b)
      if (!s) continue
      if (this.online(b, s.presenter.id)) {
        s.presenterGoneSince = null
        if (!s.presenterOnline) {
          s.presenterOnline = true
          this.emit(b, 'presenter-online', null, null)
        }
      } else {
        s.presenterGoneSince ??= at
        const gone = at - s.presenterGoneSince
        if (gone >= this.graceMs) {
          this.end(b, 'presenter-left', null)
          continue
        }
        if (gone >= this.offlineNoticeMs && s.presenterOnline) {
          s.presenterOnline = false
          this.emit(b, 'presenter-offline', null, null)
        }
      }
      let dropped = false
      for (const [userId, f] of s.followers) {
        if (this.online(b, userId)) {
          f.goneSince = null
          continue
        }
        f.goneSince ??= at
        if (at - f.goneSince >= this.followerGraceMs) {
          s.followers.delete(userId)
          dropped = true
        }
      }
      if (dropped) this.followersChanged(b)
    }
  }

  /** Sweeps every `intervalMs` (unref'd); returns the stop function (which also drops pending timers). */
  startSweeper(intervalMs: number): () => void {
    const t = intervalMs > 0 ? setInterval(() => this.sweep(), intervalMs) : null
    t?.unref?.()
    return () => {
      if (t) clearInterval(t)
      for (const timer of this.pendingFollowers.values()) if (timer) clearTimeout(timer)
      this.pendingFollowers.clear()
    }
  }

  // ---- internals ------------------------------------------------------------------------------------

  private presenterSession(boardId: string, actorId: string, id: string): Session {
    const s = this.sessions.get(boardId)
    if (!s || s.id !== id) throw ended()
    if (s.presenter.id !== actorId) {
      throw new PresentRuleError('NOT_PRESENTER', `${s.presenter.name} is presenting now.`)
    }
    return s
  }

  private presentingTab(boardId: string, actorId: string, id: string, tab: string): Session {
    const s = this.presenterSession(boardId, actorId, id)
    if (s.tab !== tab) throw new PresentRuleError('OTHER_TAB', 'You are presenting from another tab.')
    return s
  }

  private markPresenterOnline(s: Session) {
    s.presenterGoneSince = null
    s.presenterOnline = true
  }

  private end(boardId: string, reason: PresentEndReason, by: Actor | null) {
    const s = this.sessions.get(boardId)
    if (!s) return
    this.sessions.delete(boardId)
    // Never "resumed" (only a restart loses a presentation): its followers would be pulled back in.
    this.endedIds.add(s.id)
    if (this.endedIds.size > ENDED_IDS_KEPT)
      this.endedIds.delete(this.endedIds.values().next().value as string)
    this.emit(boardId, 'ended', reason, by)
  }

  private followersChanged(boardId: string) {
    if (this.pendingFollowers.has(boardId)) return
    const since = this.now() - (this.lastFollowersPublish.get(boardId) ?? Number.NEGATIVE_INFINITY)
    if (this.followersPublishMs <= 0 || since >= this.followersPublishMs) {
      this.emit(boardId, 'followers', null, null)
      return
    }
    // Real time (not the app clock): only the delivery is delayed, never a decision.
    const timer = setTimeout(() => {
      this.pendingFollowers.delete(boardId)
      if (this.sessions.has(boardId)) this.emit(boardId, 'followers', null, null)
    }, this.followersPublishMs - since)
    timer.unref?.()
    this.pendingFollowers.set(boardId, timer)
  }

  private view(boardId: string): LivePresentation | null {
    const s = this.sessions.get(boardId)
    if (!s) return null
    // Map order = the order people started following (following again puts them last).
    const followers = [...s.followers.entries()].map(([userId, f]) => ({
      userId,
      name: f.name,
      guest: f.guest,
    }))
    return {
      id: s.id,
      presenter: { userId: s.presenter.id, name: s.presenter.name },
      tab: s.tab,
      slideId: s.slide.slideId,
      index: s.slide.index,
      count: s.slide.count,
      startedAt: s.startedAt.toISOString(),
      presenterOnline: s.presenterOnline,
      followers: followers.slice(0, PRESENT_FOLLOWERS_LISTED),
      followerCount: followers.length,
    }
  }

  private emit(boardId: string, kind: PresentChangeKind, reason: PresentEndReason | null, by: Actor | null) {
    this.changes++
    // Any event carries the followers as they are now: nothing is pending for this board any more.
    const pending = this.pendingFollowers.get(boardId)
    if (pending) clearTimeout(pending)
    this.pendingFollowers.delete(boardId)
    this.lastFollowersPublish.set(boardId, this.now())
    if (!this.sessions.has(boardId)) this.lastFollowersPublish.delete(boardId)
    const change: PresentChange = { kind, reason, byUserId: by?.id ?? null, byName: by?.name ?? null }
    this.publishFn(boardId, { presentation: this.view(boardId), change, version: this.version() })
  }
}

// ---- routes -------------------------------------------------------------------------------------------

const GUEST_PRESENT =
  'Guests can’t present to everyone. Sign in with an account to do that, or follow the presenter.'

/** The rules' refusals are 409s with their own code (the client says what to do next). */
const toApi = (e: unknown) => (e instanceof PresentRuleError ? conflict(e.code, e.message) : e)

function run<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw toApi(e)
  }
}

export function registerPresentation(app: FastifyInstance, ctx: FeatureContext): PresentationRegistry {
  const { db, now, events } = ctx
  const settings = { ...presentationSettings }
  const registry = new PresentationRegistry({
    now,
    publish: (boardId, data) => events.publish(boardId, { type: PRESENT_LIVE_EVENTS.changed, data }),
    // Only streams the hub admitted count (after their access check), across every tab of the person.
    online: (boardId, userId) => events.userStreamCount(userId, boardId) > 0,
    followersPublishMs: settings.followersPublishMs,
  })
  const stopSweeper = registry.startSweeper(settings.sweepMs)
  app.addHook('onClose', async () => stopSweeper())

  const slideLimit = new SlidingWindowLimiter(settings.slidesPerSecond, 1_000)
  const followLimit = new SlidingWindowLimiter(settings.followsPer10s, 10_000)
  const controlLimit = new SlidingWindowLimiter(settings.controlsPer10s, 10_000)

  // The version is read right after the state (same tick), so it describes that state.
  const body = (boardId: string, presentation = registry.get(boardId)): PresentLiveState => ({
    presentation,
    version: registry.version(),
    serverNow: now().toISOString(),
  })

  /** Counts one take for `key`; a refused take does not count. */
  const take = (limit: SlidingWindowLimiter, key: string, message: string) => {
    const t = now().getTime()
    if (!limit.take(key, t)) throw rateLimited(limit.retryAfterMs(key, t), message)
  }

  const boardOf = (req: { params: unknown }) => (req.params as Params).bid ?? ''

  app.get('/api/boards/:bid/presentation', async (req) => {
    const user = await ctx.requireUser(req)
    const access = await requireBoardAction(db, boardOf(req), user.id, 'view')
    return body(access.board.id)
  })

  app.post('/api/boards/:bid/presentation', async (req) => {
    const user = await ctx.requireUser(req)
    const input = parse(StartPresentationInput, req.body)
    const access = await requireBoardAction(db, boardOf(req), user.id, 'edit')
    if ((await userKind(db, user.id)) === 'guest')
      throw new ApiError(403, 'GUEST_ACCOUNT_REQUIRED', GUEST_PRESENT)
    const boardId = access.board.id
    take(controlLimit, `${boardId}/${user.id}`, 'That is a lot of presenting. Wait a moment.')
    const { tab, resumeId, takeOver, slideId, index, count } = input
    const presentation = run(() =>
      registry.start(
        boardId,
        { id: user.id, name: user.name },
        { tab, slide: { slideId, index, count }, resumeId, takeOver },
      ),
    )
    return body(boardId, presentation)
  })

  app.post('/api/boards/:bid/presentation/slide', async (req) => {
    const user = await ctx.requireUser(req)
    const input = parse(PresentSlideInput, req.body)
    const access = await requireBoardAction(db, boardOf(req), user.id, 'edit')
    const boardId = access.board.id
    const { id, tab, slideId, index, count } = input
    // Refused requests (someone else, another tab) never use up the presenting tab's budget.
    run(() => registry.assertPresentingTab(boardId, user.id, id, tab))
    take(slideLimit, boardId, 'The slides are changing too fast. Wait a moment.')
    run(() => registry.slide(boardId, user.id, { id, tab, slide: { slideId, index, count } }))
    return body(boardId)
  })

  app.post('/api/boards/:bid/presentation/stop', async (req) => {
    const user = await ctx.requireUser(req)
    const { id } = parse(StopPresentationInput, req.body)
    // The presenter may always end their own (even after losing edit); anyone else must own the board.
    const access = await requireBoardAction(db, boardOf(req), user.id, 'view')
    const boardId = access.board.id
    const current = registry.get(boardId)
    let asOwner = false
    if (current?.id === id && current.presenter.userId !== user.id) {
      await requireBoardAction(db, boardId, user.id, 'manage_access')
      asOwner = true
    }
    take(controlLimit, `${boardId}/${user.id}`, 'Wait a moment and try again.')
    run(() => registry.stop(boardId, { id: user.id, name: user.name }, id, asOwner))
    return body(boardId)
  })

  app.post('/api/boards/:bid/presentation/handoff', async (req) => {
    const user = await ctx.requireUser(req)
    const input = parse(HandOffPresentationInput, req.body)
    const access = await requireBoardAction(db, boardOf(req), user.id, 'edit')
    const boardId = access.board.id
    const current = registry.get(boardId)
    if (!current || current.id !== input.id) throw conflict('NOT_PRESENTING', 'This presentation has ended.')
    if (current.presenter.userId !== user.id)
      throw conflict('NOT_PRESENTER', `${current.presenter.name} is presenting now.`)
    take(controlLimit, `${boardId}/${user.id}`, 'Wait a moment and try again.')
    // The new presenter: someone with an account who may edit this board and is on it right now.
    const cannot = () =>
      conflict('CANNOT_PRESENT', 'That person can’t present on this board. Pick someone who can edit it.')
    const target = await db.maybeOne<{ id: string; name: string; kind: string }>(
      'SELECT id, name, kind FROM users WHERE id = $1',
      [input.userId],
    )
    if (!target) throw cannot()
    try {
      await requireBoardAction(db, boardId, target.id, 'edit')
    } catch {
      throw cannot()
    }
    if (target.kind === 'guest')
      throw conflict('GUEST_CANNOT_PRESENT', 'Guests can’t present. Pick someone with an account.')
    if (events.userStreamCount(target.id, boardId) === 0)
      throw conflict('NOT_ON_BOARD', `${target.name} isn’t on the board right now.`)
    const presentation = run(() =>
      registry.handOff(boardId, { id: user.id, name: user.name }, input.id, {
        id: target.id,
        name: target.name,
      }),
    )
    return body(boardId, presentation)
  })

  app.post('/api/boards/:bid/presentation/follow', async (req) => {
    const user = await ctx.requireUser(req)
    const { id, following } = parse(FollowPresentationInput, req.body)
    const access = await requireBoardAction(db, boardOf(req), user.id, 'view')
    const boardId = access.board.id
    take(followLimit, `${boardId}/${user.id}`, 'That is a lot of following and stopping. Wait a moment.')
    const guest = (await userKind(db, user.id)) === 'guest'
    run(() => registry.follow(boardId, { id: user.id, name: user.name, guest }, id, following))
    return body(boardId)
  })

  return registry
}
