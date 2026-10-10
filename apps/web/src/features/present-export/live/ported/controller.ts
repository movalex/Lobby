// OWNER: 3c. Present to everyone (present-live) on the Excalidraw board page (the tldraw page's ../controller.ts):
// keeps this tab's presentation (3e's presenter, ./presenter.ts) in step with
// the board's live presentation (store.ts, the api's state).
//
// One rule, applied after every change (reconcile): what this tab should be doing follows from the
// api's state, the tab's id and this person's choice.
// - I present, from this tab: presenting (a reload of this tab resumes at the current slide; a
//   hand-off to me turns my following into presenting). My slide changes go to the api.
// - I present from another tab: not presenting here (a chip offers "Present from this tab").
// - I was handed it and no tab has it yet: the visible tab takes it.
// - Someone else presents and I chose to follow: following (their slide, their name); a hand-off
//   away from me makes me a follower.
// - Nobody presents: a follower steps out and is told why; after an api restart followers wait
//   RESTART_WAIT_MS for the presenter's tab to put the same presentation back.
// Ending here: Exit/Esc by the presenter ends it for everyone; Esc/"Stop following" by a follower
// steps out (the top-bar chip rejoins). Leaving the board ends nothing at once: the api's grace does.

import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import { type LivePresentation, type PresentSlide, PresentSlideId } from '@draftroom/contracts'
import type { CanvasFeatureContext, FeatureRegistries } from '../../../../canvas/api/index.ts'
import { type BoardRole, can } from '../../../../lib/permissions.ts'
import { type Atom, atom, react } from '../../../../lib/signals.ts'
import { LOBBY_SIGNALS } from '../../../comments/cells.ts'
import { noteFeedbackMoment } from '../../../feedback/prompt-moments.ts'
import { type LiveResult, LiveStore } from '../store.ts'
import { presenterTabId, sessionStore } from '../tab.ts'
import { endedText, startRefusedText } from '../words.ts'
import { type AgendaLive, mountAgenda } from './agenda-live.ts'
import type { LivePresenter, PresentLeader } from './presenter.ts'

/** A slide's element id as the api names it (`shape:<id>`), or null when it has no api form. */
export function apiSlideId(elementId: string | null): string | null {
  if (!elementId) return null
  const ref = `shape:${elementId}`
  return PresentSlideId.safeParse(ref).success ? ref : null
}

/** The element id of an api slide ref, or null. */
export const elementSlideId = (ref: string | null): string | null => (ref ? fromShapeRef(ref) : null)

/** A message inside the presentation chrome (hand-offs, refusals), shown for FLASH_MS. */
export interface LiveFlash {
  text: string
  seq: number
  /** An action the message offers (e.g. take over from a presenter who dropped out). */
  action?: 'take-over'
}

const FLASH_MS = 6_000

export interface LiveController {
  /** The board session this controller was mounted with (canvas, api, events, board, me: stable; not the role). */
  readonly ctx: CanvasFeatureContext
  readonly store: LiveStore
  readonly presenter: LivePresenter
  readonly tab: string
  readonly me: { id: string; name: string }
  /** The caller's board role and board status (UI hints; the api decides). */
  readonly role: Atom<{ role: BoardRole; status: 'active' | 'archived' | 'trashed' }>
  /** Whether the caller is a name-only guest (null while unknown). */
  readonly guest: Atom<boolean | null>
  /** This tab presents the live presentation. */
  readonly presentingLive: Atom<boolean>
  readonly flash: Atom<LiveFlash | null>
  readonly busy: Atom<boolean>
  /** Wave L (L5-1): the run of show while this tab presents to everyone (agenda-live.ts). */
  readonly agenda: AgendaLive
  /** May present to everyone (edit rights and an account): UI only. */
  mayPresent(): boolean
  /** From a local presentation: make it a presentation to everyone. */
  inviteEveryone(opts?: { takeOver?: boolean }): Promise<void>
  /**
   * K3-5: a presentation just started here with Present: offered to everyone on the board at once (their
   * toast: "Chase is presenting · Follow"), when this person may present to everyone, nobody does yet, and
   * someone else is on the board. Nothing is said when it is refused: "Invite everyone" stays in the bar.
   */
  offerToEveryone(): Promise<void>
  /**
   * Wave K.1 (K3-5, follow-up 3): the other people on the board a Present started here would go live to: 0 when
   * nobody else is here, this person may not present to everyone, or a presentation to everyone is running.
   * Present asks first when it is above 0 ("Present to everyone (N here)" or "Just me").
   */
  offerAudience(): number
  /** Follow the live presentation (the invitation's Join, the chip's Rejoin). */
  join(): void
  notNow(): void
  /** A follower's "Stop following". */
  stepOut(): void
  /** The presenter ends it for everyone (Exit / Esc do the same through the presenter). */
  endForEveryone(): void
  handOff(userId: string): Promise<LiveResult>
  /** The presenter's other tab: present from here instead (a click: full screen allowed). */
  presentHere(): Promise<void>
  /** Someone who may present takes over from a presenter who lost the connection. */
  takeOver(): Promise<void>
  dispose(): void
}

const slots = new WeakMap<FeatureRegistries, Atom<LiveController | null>>()
const slotOf = (registries: FeatureRegistries) => {
  let slot = slots.get(registries)
  if (!slot) {
    slot = atom<LiveController | null>('dr-live-controller', null)
    slots.set(registries, slot)
  }
  return slot
}

/**
 * The live controller of this board page once present mode provided its presenter (null before, and in
 * tests). Reactive: read it inside useValue to re-render when it arrives.
 */
export function getLive(registries: FeatureRegistries): LiveController | null {
  return slotOf(registries).get()
}

const slideOf = (presenter: LivePresenter): PresentSlide => {
  const cur = presenter.current()
  return { slideId: apiSlideId(cur.slideId), index: Math.max(0, cur.index), count: cur.count }
}

const leaderOf = (p: LivePresentation): PresentLeader => ({
  userId: p.presenter.userId,
  name: p.presenter.name,
})

export function mountLive(ctx: CanvasFeatureContext, presenter: LivePresenter): () => void {
  const { registries } = ctx
  slotOf(registries).get()?.dispose()
  const me = { id: ctx.me.user.id, name: ctx.me.user.name }
  const tab = presenterTabId()
  const store = new LiveStore({
    signals: LOBBY_SIGNALS,
    boardId: ctx.board.id,
    userId: me.id,
    tab,
    request: ctx.api.request,
    events: ctx.events,
    storage: sessionStore(),
  })
  const role = atom('dr-live-role', { role: ctx.role, status: ctx.board.status })
  const guest = atom<boolean | null>('dr-live-guest', null)
  const presentingLive = atom('dr-live-presenting', false)
  const flash = atom<LiveFlash | null>('dr-live-flash', null)
  const busy = atom('dr-live-busy', false)
  // L5-1: records the sections of a run of show and starts their timers as the live slide moves
  const agenda = mountAgenda(ctx, {
    presenter,
    presentingLive,
    presentationId: () => store.presentation.get()?.id ?? null,
  })
  let disposed = false
  let flashSeq = 0
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  /** The presenter's name of the presentation last seen (for "Chase ended the presentation"). */
  let lastPresenter: string | null = null
  /** and the user id of that presenter (M2-1: "You ended the presentation.") */
  let lastPresenterId: string | null = null
  /** Claims already asked for (one per presentation id and tab). */
  let claiming: string | null = null
  /** Who handed this person the presentation (said once the tab has taken it). */
  let handedBy: string | null = null
  let resuming: string | null = null
  /**
   * The presentation this tab ended (Exit / Esc) while the api has not confirmed it yet: never resumed
   * here, and asked to end again (a lost request) until the api's state no longer has it.
   */
  let ending: string | null = null
  let stopping = false
  /**
   * K3-5 (wave K integration, the K3 review): a Present's offer to everyone is on its way (`offering`), and
   * this tab left present mode before it landed (`offerWithdrawn`: Esc right after Present on a slow
   * network). The late presentation is then ended at once and never puts this tab back into present mode.
   */
  let offering = false
  let offerWithdrawn = false
  const endIt = (id: string) => {
    ending = id
    if (stopping) return
    stopping = true
    void store.stop().finally(() => {
      stopping = false
    })
  }

  const say = (text: string, action?: LiveFlash['action']) => {
    if (flashTimer) clearTimeout(flashTimer)
    flash.set({ text, seq: ++flashSeq, ...(action ? { action } : {}) })
    flashTimer = setTimeout(() => flash.set(null), FLASH_MS)
  }

  const notify = (text: string, testId = 'live-toast') =>
    ctx.notify({ key: 'present-live', text, testId, timeoutMs: 7000 })

  const mayPresent = () => {
    const r = role.get()
    return can(r.role, 'edit', r.status) && guest.get() !== true
  }

  const withBusy = async <T>(fn: () => Promise<T>): Promise<T> => {
    busy.set(true)
    try {
      return await fn()
    } finally {
      busy.set(false)
    }
  }

  // ---- reconcile ---------------------------------------------------------------------------------------

  const reconcile = () => {
    if (disposed) return
    const p = store.presentation.get()
    const local = presenter.state.get()
    if (p) {
      lastPresenter = p.presenter.name
      lastPresenterId = p.presenter.userId
    }

    if (!p) {
      ending = null
      const lost = store.restartLost.get()
      if (lost) {
        // The api restarted: the presenting tab puts the same presentation back; followers wait.
        if (lost.presenter.userId === me.id && lost.tab === tab && local?.role === 'presenter') {
          if (resuming !== lost.id) {
            resuming = lost.id
            void store.start({ slide: slideOf(presenter), resumeId: lost.id }).then(() => {
              resuming = null
            })
          }
          return
        }
        if (local?.role === 'follower') return
      }
      if (local?.role === 'follower') {
        presenter.stop({ reason: 'remote', view: 'here' })
        notify(endedText(store.lastChange.get(), lastPresenter, me.id, lastPresenterId), 'live-ended-toast')
      }
      if (presentingLive.get()) {
        presentingLive.set(false)
        const change = store.lastChange.get()
        if (change?.kind === 'ended' && change.byUserId !== me.id && local?.role === 'presenter')
          say(`${endedText(change, me.name)} You are still presenting here, to yourself.`)
      }
      return
    }

    if (ending && ending !== p.id) ending = null
    if (p.presenter.userId === me.id) {
      if (p.tab === tab) {
        claiming = null
        if (ending === p.id) {
          // Ended here; the api has not said so yet (or the request was lost): ask again, never resume.
          if (!local) endIt(p.id)
          return
        }
        if (!local && offering && offerWithdrawn) {
          // K3-5: the offer landed after this tab left present mode: end it, do not resume it here.
          endIt(p.id)
          return
        }
        if (!local) {
          // This tab presents (a reload, or it just took a hand-off): back to the current slide.
          const r = presenter.start({
            role: 'presenter',
            slideId: elementSlideId(p.slideId),
            index: p.index,
            fullscreen: false,
          })
          if (!r.ok && r.reason !== 'already') {
            void store.stop()
            notify('Your presentation to everyone ended: this board has no frames to present.')
            return
          }
        } else if (local.role === 'follower') {
          presenter.setRole('presenter')
        }
        if (handedBy) {
          say(`${handedBy} handed the presentation to you. Use ← and → to change slides.`)
          handedBy = null
        }
        presentingLive.set(true)
        return
      }
      if (p.tab === null) {
        // Handed to me: the tab in front takes it (the others follow the one that did).
        const by = store.lastChange.get()
        if (by?.kind === 'handoff' && by.byUserId && by.byUserId !== me.id) handedBy = by.byName
        if (document.visibilityState === 'visible' && claiming !== p.id) {
          claiming = p.id
          void store.start({ slide: { slideId: p.slideId, index: p.index, count: p.count } }).then((r) => {
            if (!r.ok) claiming = null
          })
        }
        return
      }
      // Another tab of mine presents.
      if (local && (presentingLive.get() || local.role === 'follower')) {
        presentingLive.set(false)
        presenter.stop({ reason: 'remote', view: local.role === 'follower' ? 'here' : 'restore' })
        notify('You are presenting from another tab now.')
      }
      presentingLive.set(false)
      return
    }

    // Someone else presents.
    if (presentingLive.get()) {
      // Handed over (or taken over) from this tab: keep watching as a follower.
      presentingLive.set(false)
      store.setIntent(p.id, 'following')
      if (local?.role === 'presenter') say(`${p.presenter.name} is presenting now. You are following.`)
    }
    const intent = store.intentFor(p.id)
    if (intent === 'following') {
      const leader = leaderOf(p)
      if (!local) {
        const r = presenter.start({
          role: 'follower',
          slideId: elementSlideId(p.slideId),
          index: p.index,
          leader,
        })
        if (!r.ok && r.reason !== 'already') {
          store.setIntent(p.id, 'declined')
          void store.follow(false)
          notify(`You can’t follow ${p.presenter.name}’s presentation here: this page has no frames.`)
          return
        }
      } else {
        presenter.setRole('follower', leader)
      }
      presenter.follow(elementSlideId(p.slideId), p.index)
    } else if (local?.role === 'follower') {
      presenter.stop({ reason: 'remote', view: 'here' })
    }
  }

  let scheduled = false
  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      reconcile()
    })
  }

  const stopWatch = react('dr-live-watch', () => {
    store.presentation.get()
    store.restartLost.get()
    store.intent.get()
    presenter.state.get()
    schedule()
  })

  // The presenting tab's slide, as it changes (coalesced in the store).
  const stopSlides = react('dr-live-slides', () => {
    if (!presentingLive.get()) return
    const local = presenter.state.get()
    if (local?.role !== 'presenter') return
    store.sendSlide(slideOf(presenter))
  })

  const offStop = presenter.onStop(({ role: was, reason }) => {
    const p = store.presentation.get()
    if (was === 'presenter' && offering) offerWithdrawn = true
    if (was === 'presenter' && presentingLive.get()) {
      presentingLive.set(false)
      // Exit / Esc ends it for everyone. Leaving the board does not: the api ends it after its grace
      // unless this tab comes back (a reload resumes it).
      if (reason === 'local' && p && p.presenter.userId === me.id && p.tab === tab) {
        endIt(p.id)
        // M2-5: the person whose presentation it was is asked how it went (a moment of theirs: ./feedback/prompt.ts)
        noteFeedbackMoment(ctx.canvas, 'presentation-stop')
      }
    }
    // Stepping out while the api restarts ("Reconnecting…") counts too: the presentation it puts back
    // has the same id, and must not pull this person back in.
    const left = p ?? store.restartLost.get()
    if (was === 'follower' && left && reason !== 'remote') {
      if (reason === 'local') store.setIntent(left.id, 'declined')
      void store.follow(false)
    }
  })

  const onVisible = () => schedule()
  document.addEventListener('visibilitychange', onVisible)

  // ---- actions -----------------------------------------------------------------------------------------

  const join = () => {
    const p = store.presentation.get()
    if (!p || p.presenter.userId === me.id) return
    store.setIntent(p.id, 'following')
    void store.follow(true).then((r) => {
      if (r.ok) return
      store.setIntent(p.id, 'declined')
      notify(r.message)
    })
  }

  const controller: LiveController = {
    ctx,
    store,
    presenter,
    tab,
    me,
    role,
    guest,
    presentingLive,
    flash,
    busy,
    agenda,
    mayPresent,
    inviteEveryone: (opts = {}) =>
      withBusy(async () => {
        if (!presenter.isPresenting()) return
        const r = await store.start({ slide: slideOf(presenter), takeOver: opts.takeOver })
        if (r.ok) {
          say('Everyone on the board can now join your presentation.')
          return
        }
        say(startRefusedText(r.code, r.message), r.code === 'PRESENTER_AWAY' ? 'take-over' : undefined)
      }),
    join,
    offerAudience: () => {
      if (presenter.isPresenting() || presentingLive.get() || !mayPresent()) return 0
      if (store.presentation.get()) return 0
      return new Set(
        ctx.canvas
          .collaborators()
          .map((c) => c.uid)
          .filter((uid) => uid !== me.id),
      ).size
    },
    offerToEveryone: async () => {
      if (presenter.role() !== 'presenter' || presentingLive.get() || !mayPresent()) return
      if (store.presentation.get()) return
      if (!ctx.canvas.collaborators().some((c) => c.uid !== me.id)) return
      offering = true
      offerWithdrawn = false
      try {
        const r = await withBusy(() => store.start({ slide: slideOf(presenter) }))
        // K3-5: left present mode while the offer was on its way: the presentation it made ends now
        const p = store.presentation.get()
        if (
          r.ok &&
          offerWithdrawn &&
          !presenter.isPresenting() &&
          p?.presenter.userId === me.id &&
          p.tab === tab
        )
          endIt(p.id)
      } finally {
        offering = false
        offerWithdrawn = false
      }
    },
    notNow() {
      const p = store.presentation.get()
      if (p) store.setIntent(p.id, 'declined')
    },
    stepOut() {
      if (presenter.role() === 'follower') presenter.stop({ reason: 'local', view: 'here' })
    },
    endForEveryone() {
      if (presenter.role() === 'presenter') presenter.stop({ reason: 'local' })
      else void store.stop()
    },
    handOff: (userId) =>
      withBusy(async () => {
        const r = await store.handOff(userId)
        if (!r.ok) say(r.message)
        return r
      }),
    presentHere: () =>
      withBusy(async () => {
        const p = store.presentation.get()
        if (!p || p.presenter.userId !== me.id) return
        // Full screen needs this click: start here first, then take the presentation.
        const startedHere = !presenter.isPresenting()
        if (startedHere) {
          const s = presenter.start({
            role: 'presenter',
            slideId: elementSlideId(p.slideId),
            index: p.index,
          })
          if (!s.ok && s.reason !== 'already') return notify('There is nothing to present on this page.')
        }
        const r = await store.start({ slide: slideOf(presenter) })
        if (!r.ok) {
          if (startedHere) presenter.stop({ reason: 'remote' })
          notify(r.message)
        }
      }),
    takeOver: () =>
      withBusy(async () => {
        const p = store.presentation.get()
        if (!p || p.presenter.userId === me.id) return
        // From the board (a click: full screen allowed) this tab starts presenting first; a follower
        // turns into the presenter once the api agrees (reconcile).
        const startedHere = !presenter.isPresenting()
        if (startedHere) {
          const s = presenter.start({
            role: 'presenter',
            slideId: elementSlideId(p.slideId),
            index: p.index,
          })
          if (!s.ok && s.reason !== 'already') return notify('There is nothing to present on this page.')
        }
        const r = await store.start({ slide: slideOf(presenter), takeOver: true })
        if (r.ok) return
        if (startedHere) presenter.stop({ reason: 'remote' })
        notify(startRefusedText(r.code, r.message))
      }),
    dispose() {
      if (disposed) return
      disposed = true
      stopWatch()
      stopSlides()
      agenda.dispose()
      offStop()
      document.removeEventListener('visibilitychange', onVisible)
      if (flashTimer) clearTimeout(flashTimer)
      store.dispose()
      if (slotOf(registries).get() === controller) slotOf(registries).set(null)
    },
  }
  slotOf(registries).set(controller)
  // The first state comes with the stream's first resync (events.onResync runs at once when connected).
  return () => controller.dispose()
}
