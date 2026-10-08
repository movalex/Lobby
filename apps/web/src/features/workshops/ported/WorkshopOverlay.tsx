// OWNER: 3f. The workshops feature's canvas overlays on the Excalidraw page (the tldraw board's
// WorkshopOverlay, rendered inside <Tldraw>): three overlay layers of the board page's overlay root
// (docs/EXCALIDRAW-CONTRACTS.md §3 `featureOverlays`, positioned in overlay pixels through
// `canvas.sceneToOverlay`, which is tldraw's `pageToViewport`):
//
//  - `workshops-marks` (scene, under the top bar's popovers): the revealed counts (round-2 F3);
//  - `workshops` (scene): my vote dots, the +/- stepper on the selected object (also the keyboard way to
//    vote), +1s, and one stacked message region at the bottom (the "you're following" notice above the
//    "Results are in" card above the brainstorm prompt, the join prompt / voting bar, RETRO-11);
//  - `workshops-top` (screen, above the presentation): the time's-up flash, the read-only timer while
//    presenting (FAC-03) and on phones, the raised hands while presenting, and the reaction bursts.
//
// All three stay in focus mode (present mode, `focusMode: 'show'`): as on the tldraw board, my own dots and
// the revealed counts stay on the slides, the timer and hands float over them, and the prompts, +1s and
// the stepper hide themselves while presenting.
//
// Click-to-vote is the input stream (`canvas.on('input')`, capture phase, before the engine): a plain
// primary press on an object the vote accepts is claimed with `handled()`, so Excalidraw never selects
// it (a selection is presence everyone sees, PRF-07), and votes on release when it did not move. The hand
// tool's clicks vote too. A press with a modifier, on empty canvas or on an object the vote does not
// accept goes to the engine as usual. The topmost object under the press decides (W5-03): a click on an
// object the vote does not take casts nothing, even over one it takes, and says so.
import { type VoteEligibilityRule, voteRuleOf } from '@draftroom/contracts'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type CanvasFeatureContext, geometry } from '../../../canvas/api/index.ts'
import { safeColor } from '../../../lib/identity.ts'
import { useValue } from '../../../lib/signals.ts'
import { PHONE_QUERY, useMediaQuery } from '../../../ui/useMedia.ts'
import { announcerFor } from '../../a11y/ported/announcer.ts'
import { formatClock, timerDisplayPhase, timerRemainingMs } from '../countdown.ts'
import { HandToasts, PresentingHands } from '../Hands.tsx'
import type { WorkshopStore } from '../store.ts'
import { badgeScale, clusterBadges, describeVoted, dotInk, revealConfetti, topResults } from '../voting.ts'
import { useIsFacilitator, useNow, useWorkshop } from '../workshop-context.ts'
import { followingNow, stopFollowing, zoomToBounds } from './camera.ts'
import { isEligibleElement, labelOfRef, refOf } from './elements.ts'
import { PlusOnes } from './PlusOnes.tsx'
import { usePresentingHere } from './presenting.ts'
import {
  PrivateNotesFacilitatorBar,
  PrivateNotesReminder,
  PrivateNotesStartPrompt,
} from './private-notes/PrivateNotesBar.tsx'
import { REDUCED_MOTION_QUERY, ReactionBursts } from './Reactions.tsx'
import { useVoted } from './VotingPanel.tsx'
import {
  cornersOf,
  eligibleAt,
  notInVoteNotice,
  plainPress,
  selectEligible,
  selectedEligible,
  voteClickAt,
} from './voting-canvas.ts'
import { StopwatchIcon } from './WorkshopBar.tsx'
import './workshops-ported.css'

type Ctx = CanvasFeatureContext

interface Placed {
  shapeId: string
  x: number
  y: number
  n: number
  rank?: number
}

const CLICK_SLOP_PX = 5
const SAME_SHAPE_DEBOUNCE_MS = 300

/** Overlay positions (top-right corner) of voted objects, recomputed with the camera and the scene. */
function usePlacements(ctx: Ctx, counts: Record<string, { n: number; rank?: number }>, testKey: string) {
  const canvas = ctx.canvas
  const key = useValue(`dr-wk-placements-${testKey}`, () => {
    const out: Placed[] = []
    for (const c of cornersOf(canvas, Object.keys(counts))) {
      const v = counts[c.ref]
      if (v) out.push({ shapeId: c.ref, x: c.x, y: c.y, n: v.n, rank: v.rank })
    }
    return JSON.stringify(out)
  }, [canvas, counts])
  return useMemo(() => JSON.parse(key) as Placed[], [key])
}

/** The vote's eligibility rule, stable across refreshes (each refresh brings new objects with the same values). */
export function useRule(store: WorkshopStore): VoteEligibilityRule | null {
  const s = store.getSnapshot().vote?.session
  const types = s?.shapeTypes ? JSON.stringify(s.shapeTypes) : null
  const picked = s?.selection ? JSON.stringify(s.selection) : null
  const has = !!s
  const scope = s?.scope
  const frameId = s?.frameId ?? null
  return useMemo<VoteEligibilityRule | null>(
    () =>
      has && scope
        ? voteRuleOf({
            scope,
            frameId,
            shapeTypes: types ? (JSON.parse(types) as string[]) : null,
            selection: picked ? (JSON.parse(picked) as string[]) : null,
          })
        : null,
    [has, scope, frameId, types, picked],
  )
}

/** "Voted. 2 of 3 left" / "Vote removed. 3 of 3 left", for the screen-reader live region. */
export function castAnnouncement(delta: 1 | -1, left: number, perPerson: number): string {
  return `${delta > 0 ? 'Voted' : 'Vote removed'}. ${left} of ${perPerson} left`
}

/** Casts one vote (+1) or takes one back (-1) on the object an api ref names; says what went wrong. */
export async function castVote(ctx: Ctx, store: WorkshopStore, shapeId: string, delta: 1 | -1) {
  const r = await store.cast(shapeId, delta)
  if (!r.ok && r.error) ctx.notify({ key: 'vote-cast', text: r.error, testId: 'vote-toast', timeoutMs: 3500 })
  const snap = store.getSnapshot()
  if (r.ok && snap.ballot && snap.vote)
    store.announce(castAnnouncement(delta, snap.ballot.myRemaining, snap.vote.session.votesPerPerson))
}

function useCast(ctx: Ctx, store: WorkshopStore) {
  return (shapeId: string, delta: 1 | -1) => castVote(ctx, store, shapeId, delta)
}

/** A click on an object the vote does not take (W5-03): nothing is cast, and the toast says why. */
export function notInVote(ctx: Ctx, rule: VoteEligibilityRule) {
  ctx.notify({
    key: 'vote-cast',
    text: notInVoteNotice(ctx.canvas, rule),
    testId: 'vote-toast',
    timeoutMs: 3500,
  })
}

/** How recently the server must have confirmed this tab's vote for a click to be refused without asking (G1). */
export const REFUSE_CONFIRMED_MS = 2_000

/**
 * A plain click on element `elementId`, which the vote `sessionId` (as this tab knows it) does not take.
 * That copy can be out of date (G1: a participant whose event stream missed the end of a selection vote
 * and the start of a board vote was refused on the board vote's notes), so unless the server confirmed it
 * in the last few seconds it is checked first, and the click is decided again on the vote open now: a vote
 * when that vote takes the object and this person is in it, the "Not part of this vote" notice when it
 * does not, and nothing when voting is over or the open vote is one this person has not joined yet (its
 * join card is showing).
 */
export async function refusedClick(ctx: Ctx, store: WorkshopStore, sessionId: string, elementId: string) {
  await store.confirm(REFUSE_CONFIRMED_MS)
  const snap = store.getSnapshot()
  const vote = snap.vote
  if (vote?.session.status !== 'open' || snap.participation !== 'joined' || vote.done) return
  const rule = voteRuleOf(vote.session)
  const ref = refOf(elementId)
  if (vote.session.id !== sessionId && ref && isEligibleElement(elementId, (id) => ctx.canvas.get(id), rule))
    return castVote(ctx, store, ref, 1)
  notInVote(ctx, rule)
}

/** The board's keyboard back (after Escape in the stepper, or a click on a +1). */
export function focusBoard(ctx: Ctx) {
  ctx.canvas.focus({ preventScroll: true })
}

// ---- the layers -------------------------------------------------------------------------------------------

/** `workshops-marks`: the revealed counts, under the top bar's popovers (round-2 F3). */
export function WorkshopMarksLayer({ ctx }: { ctx: Ctx }) {
  const { snap } = useWorkshop(ctx)
  const vote = snap.vote
  return (
    <div className="dr-wk-marks" data-testid="workshop-marks">
      {vote?.session.status === 'revealed' && vote.results && snap.showResults && <ResultBadges ctx={ctx} />}
    </div>
  )
}

/** `workshops`: dots, the stepper, +1s and the message stack. */
export function WorkshopLayer({ ctx }: { ctx: Ctx }) {
  const { store, snap } = useWorkshop(ctx)
  const presenting = usePresentingHere(ctx.canvas)
  const vote = snap.vote
  const open = vote?.session.status === 'open'
  const joined = open && snap.participation === 'joined'
  // While presenting, the slides stay clean: no prompts or controls.
  const voting = joined && !vote?.done && !presenting
  // K3-1: the banner is for people who may vote here now: an active board, not presenting
  const eligible = ctx.board.status === 'active' && !presenting
  useEffect(() => store.setVoteEligible(eligible), [store, eligible])
  const resultsCard =
    !!snap.resultsNews &&
    vote?.session.status === 'revealed' &&
    !!vote.results &&
    ctx.activePanel !== 'voting'

  return (
    <div className="dr-wk-layer" data-testid="workshop-overlay">
      {/* +1s sit under the vote markers (both are on shapes; votes win while a vote runs). */}
      {!presenting && <PlusOnes ctx={ctx} voting={open} />}
      {joined && snap.ballot && <MyDots ctx={ctx} store={store} myVotes={snap.ballot.myVotes} />}
      {voting && <ClickToVote ctx={ctx} store={store} />}
      {voting && <SelectedStepper ctx={ctx} store={store} />}
      {snap.voteBanner && !presenting && <ClickToOffer ctx={ctx} store={store} />}
      {/* One stack, top to bottom, so messages never cover each other (RETRO-11). */}
      {!presenting && (
        <div className="dr-wk-stack" data-testid="workshop-stack">
          {snap.summonedBy && <FollowToast ctx={ctx} store={store} />}
          <PrivateNotesStartPrompt ctx={ctx} />
          <PrivateNotesReminder ctx={ctx} />
          {resultsCard && <ResultsCard ctx={ctx} store={store} />}
          {snap.voteBanner && <JoinPrompt key={snap.voteBanner.seq} ctx={ctx} store={store} />}
          {joined && <VotingBar ctx={ctx} store={store} />}
          {open && <VoteFacilitatorBar ctx={ctx} store={store} />}
          <PrivateNotesFacilitatorBar ctx={ctx} />
        </div>
      )}
      {joined && (
        <p className="dr-sr-only" aria-live="polite" data-testid="vote-announce">
          {snap.announcement?.text ?? ''}
        </p>
      )}
    </div>
  )
}

/** `workshops-top`: above everything, the presentation included. */
export function WorkshopTopLayer({ ctx }: { ctx: Ctx }) {
  const { store, snap } = useWorkshop(ctx)
  const presenting = usePresentingHere(ctx.canvas)
  // Phones: the timer pill sits in the top bar's "⋯" menu, so a running timer also floats on the
  // canvas, read-only (final review R2).
  const phone = useMediaQuery(PHONE_QUERY)
  return (
    <>
      <div className="dr-wk-top" data-testid="workshop-top">
        <TimerFlash seq={snap.alertSeq} />
        <RevealConfetti seq={snap.resultsNews?.seq ?? null} />
        {(presenting || phone) && <PresentingTimer store={store} corner={presenting ? 'left' : 'right'} />}
        {presenting && <PresentingHands snap={snap} />}
        <ReactionBursts ctx={ctx} store={store} />
      </div>
      <HandToasts ctx={ctx} store={store} />
    </>
  )
}

// ---- my ballot ----------------------------------------------------------------------------------------------

function MyDots({
  ctx,
  store,
  myVotes,
}: {
  ctx: Ctx
  store: WorkshopStore
  myVotes: Record<string, number>
}) {
  const counts = useMemo(
    () => Object.fromEntries(Object.entries(myVotes).map(([id, n]) => [id, { n }])),
    [myVotes],
  )
  const placed = usePlacements(ctx, counts, 'mine')
  const cast = useCast(ctx, store)
  const open = store.getSnapshot().vote?.session.status === 'open'
  const get = (id: string) => ctx.canvas.get(id)
  // K3-5: my dots in my presence colour (the colour others see my cursor in), with an ink that reads on it
  const fill = safeColor(ctx.me.user.color, ctx.me.user.id)
  const colours = { '--dot': fill, '--dot-ink': dotInk(fill) } as CSSProperties
  return (
    <>
      {placed.map((p) => {
        const label = labelOfRef(p.shapeId, get)
        return (
          <button
            key={p.shapeId}
            type="button"
            className="dr-wk-dot"
            data-testid="vote-dot"
            data-shape-id={p.shapeId}
            data-count={p.n}
            style={{ ...colours, transform: `translate(${p.x - 12}px, ${p.y - 12}px)` }}
            aria-label={`Your votes on ${label}: ${p.n}.${open ? ' Remove one.' : ''}`}
            title={open ? 'Your votes (click to take one back)' : 'Your votes'}
            disabled={!open}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void cast(p.shapeId, -1)}
          >
            {p.n}
          </button>
        )
      })}
    </>
  )
}

/**
 * A primary click (no drag) on an eligible object adds a vote. With the select tool the press never
 * reaches the engine (Miro's voting mode works the same way): a vote click must not SELECT the object,
 * because everyone's selection is shared as presence (PRF-07; the sync server also drops `sel` while a
 * vote is open). A double-click on it is one vote and never opens the note's editor. The hand tool pans
 * as usual, and its clicks without a drag vote. Presses with modifiers (Shift+drag still moves a note), on
 * empty canvas or on objects the vote does not accept go to the engine as usual; plain clicks select,
 * move and edit again after "I'm done", "Skip" or once voting ends.
 *
 * The object a click lands on is the topmost one under it (W5-03). When the vote does not take it (a note
 * outside the vote's frame on top of one inside, a shape over a note in a notes-only vote), the click
 * casts nothing, never a vote for the object hidden underneath, and a click without a drag says "Not part
 * of this vote".
 */
function ClickToVote({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const rule = useRule(store)
  const cast = useCast(ctx, store)
  const castRef = useRef(cast)
  castRef.current = cast
  useEffect(() => {
    if (!rule) return
    const canvas = ctx.canvas
    const last = { id: '', at: 0 }
    const vote = (elementId: string) => {
      const ref = refOf(elementId)
      if (!ref) return
      const t = performance.now()
      if (last.id === ref && t - last.at < SAME_SHAPE_DEBOUNCE_MS) return // a double-click is one vote
      last.id = ref
      last.at = t
      void castRef.current(ref, 1)
    }
    let pressed: { x: number; y: number; id: string } | null = null
    let other: { x: number; y: number; id: string } | null = null
    // A refused click is decided again on the vote open now (G1): from this vote's id.
    const refuse = (elementId: string) =>
      void refusedClick(ctx, store, store.getSnapshot().vote?.session.id ?? '', elementId)
    let handDown: { x: number; y: number } | null = null
    return canvas.on('input', (e) => {
      if (e.type === 'key-down' || e.type === 'wheel' || e.type === 'pinch') return
      if (e.type === 'pointer-down') {
        pressed = null
        other = null
        handDown = null
        if (e.button !== 0 || !plainPress(e)) return
        const tool = canvas.tool()
        if (tool === 'hand') {
          handDown = { x: e.screen.x, y: e.screen.y }
          return
        }
        if (tool !== 'select' || canvas.editingId()) return
        const click = voteClickAt(canvas, e.scene, rule)
        if (click.kind === 'none') return
        if (click.kind === 'not-in-vote') {
          // The engine selects or moves it as usual; a click without a drag says why nothing was cast.
          other = { x: e.screen.x, y: e.screen.y, id: click.target.id }
          return
        }
        e.handled()
        pressed = { x: e.screen.x, y: e.screen.y, id: click.target.id }
        // Voting is "moving" too: it ends following someone (FAC-02), as any canvas click does.
        stopFollowing(canvas)
        return
      }
      if (e.type === 'pointer-up') {
        const p = pressed
        const o = other
        const h = handDown
        pressed = null
        other = null
        handDown = null
        if (o) {
          if (Math.hypot(e.screen.x - o.x, e.screen.y - o.y) <= CLICK_SLOP_PX) refuse(o.id)
          return
        }
        if (p) {
          e.handled()
          if (Math.hypot(e.screen.x - p.x, e.screen.y - p.y) > CLICK_SLOP_PX) return
          vote(p.id)
          return
        }
        if (!h || e.button !== 0 || !plainPress(e) || canvas.tool() !== 'hand') return
        if (Math.hypot(e.screen.x - h.x, e.screen.y - h.y) > CLICK_SLOP_PX) return
        const click = voteClickAt(canvas, e.scene, rule)
        if (click.kind === 'vote') vote(click.target.id)
        else if (click.kind === 'not-in-vote') refuse(click.target.id)
        return
      }
      // A double-click on an object the vote takes (the second click of it already voted, or was one
      // vote with the first) never opens its editor.
      if (e.type === 'double-click' && plainPress(e) && canvas.tool() === 'select') {
        if (eligibleAt(canvas, e.scene, rule)) e.handled()
      }
    })
  }, [ctx, rule, store])
  return null
}

/** The stepper button that should take the keyboard: +, or − when no votes are left. */
export function stepperTarget(root: ParentNode | null): HTMLButtonElement | null {
  if (!root) return null
  const plus = root.querySelector<HTMLButtonElement>('[data-testid="vote-stepper"] [data-testid="vote-plus"]')
  const minus = root.querySelector<HTMLButtonElement>(
    '[data-testid="vote-stepper"] [data-testid="vote-minus"]',
  )
  if (plus && plus.getAttribute('aria-disabled') !== 'true') return plus
  if (minus && minus.getAttribute('aria-disabled') !== 'true') return minus
  return plus
}

/**
 * +/- on the one selected eligible object: the pointer's and the keyboard's way to vote (RETRO-06).
 * While voting, Tab on the board moves into the stepper (the key is claimed only while this person votes
 * in an open vote: ./index.tsx `VOTE_TAB_KEY`). Enter/Space on + or − add or remove a vote; Tab past the
 * stepper moves to the next object that can be voted on (Shift+Tab: the previous one) and stays on its +;
 * Esc returns to the board. The buttons stay focusable when they cannot act (aria-disabled), so the
 * keyboard is never dropped when the last vote is used. Keys inside never reach the board (the stepper
 * is an overlay: its keys are not the canvas's).
 */
function SelectedStepper({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const rule = useRule(store)
  const canvas = ctx.canvas
  const root = useRef<HTMLFieldSetElement>(null)
  const key = useValue('dr-wk-selected', () => {
    const id = selectedEligible(canvas, rule)
    if (!id || canvas.isHidden(id)) return ''
    const b = canvas.bounds(id)
    const ref = refOf(id)
    if (!b || !ref) return ''
    const pt = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y + b.height })
    return JSON.stringify({ shapeId: ref, x: Math.round(pt.x), y: Math.round(pt.y) })
  }, [canvas, rule])
  const cast = useCast(ctx, store)

  if (!key || !rule) return null
  const p = JSON.parse(key) as { shapeId: string; x: number; y: number }
  const snap = store.getSnapshot()
  const n = snap.ballot?.myVotes[p.shapeId] ?? 0
  const left = snap.ballot?.myRemaining ?? 0
  const label = labelOfRef(p.shapeId, (id) => canvas.get(id))
  const cannotRemove = n === 0
  const cannotAdd = left <= 0

  const onKeyDown = (e: ReactKeyboardEvent<HTMLFieldSetElement>) => {
    // Nothing typed here is a board shortcut.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      focusBoard(ctx)
      return
    }
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.indexOf(e.target as HTMLButtonElement)
    const leaving = e.shiftKey
      ? at <= 0 || buttons[at - 1]?.getAttribute('aria-disabled') === 'true'
      : at === buttons.length - 1
    if (!leaving) return
    // Past the stepper: the next object to vote on, keeping the keyboard on its + (after the last
    // one, Tab moves on as usual, to the voting bar).
    if (!selectEligible(canvas, rule, e.shiftKey ? -1 : 1)) return
    e.preventDefault()
    // The stepper stays mounted (it only moves to the new object), so its + is focused right away:
    // a key pressed before the next frame then already acts on the new object.
    root.current?.querySelector<HTMLButtonElement>('[data-testid="vote-plus"]')?.focus()
  }

  return (
    <fieldset
      ref={root}
      className="dr-wk-stepper"
      data-testid="vote-stepper"
      data-shape-id={p.shapeId}
      style={{ transform: `translate(calc(${p.x}px - 50%), ${p.y + 8}px)` }}
      aria-label={`Votes on ${label}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="dr-wk-stepper__btn"
        data-testid="vote-minus"
        aria-label={`Remove a vote from ${label}`}
        aria-disabled={cannotRemove}
        onClick={() => {
          if (!cannotRemove) void cast(p.shapeId, -1)
        }}
      >
        −
      </button>
      <span className="dr-wk-stepper__n" aria-hidden="true">
        {n}
      </span>
      <button
        type="button"
        className="dr-wk-stepper__btn"
        data-testid="vote-plus"
        aria-label={`Add a vote to ${label} (${n} so far, ${left} left)`}
        aria-disabled={cannotAdd}
        onClick={() => {
          if (!cannotAdd) void cast(p.shapeId, 1)
        }}
      >
        +
      </button>
    </fieldset>
  )
}

// ---- revealed results ---------------------------------------------------------------------------------------

const votesText = (n: number) => `${n} vote${n === 1 ? '' : 's'}`

/** A result badge's figure is drawn at this size (workshops.css .dr-wk-badge). */
const BADGE_TEXT_PX = 13
/** R2-10: at overview zoom the figure never reads smaller than this on screen (px). */
export const MIN_BADGE_TEXT_PX = 11

/**
 * R2-10: the scale of result badges at `zoom`. The overlay draws in screen pixels, so this is a screen
 * size: full from 100% zoom, smaller as the board zooms out, but never below what keeps the figure at
 * MIN_BADGE_TEXT_PX (the badge's rank, which is smaller, then reads about 9 px). Overlapping badges group
 * (voting.ts clusterBadges) instead of shrinking further.
 */
export function resultBadgeScale(zoom: number): number {
  return Math.max(badgeScale(zoom), MIN_BADGE_TEXT_PX / BADGE_TEXT_PX)
}

/**
 * Revealed counts on the voted objects (round-2 F3): full size from 100% zoom, smaller as the board
 * zooms out (down to 85%, so the figure keeps about 11 px: R2-10), and badges that would overlap become one group badge ("#1 +2", the best
 * rank and how many more) that zooms in to them when clicked. They sit in the marks layer, under the
 * top bar's popovers.
 */
function ResultBadges({ ctx }: { ctx: Ctx }) {
  const { snap } = useWorkshop(ctx)
  const canvas = ctx.canvas
  const counts = useMemo(
    () =>
      Object.fromEntries((snap.vote?.results ?? []).map((r) => [r.shapeId, { n: r.count, rank: r.rank }])),
    [snap.vote?.results],
  )
  const placed = usePlacements(ctx, counts, 'results')
  const scale = useValue('dr-wk-badge-scale', () => resultBadgeScale(canvas.viewport.get().zoom), [canvas])
  const groups = useMemo(
    () =>
      clusterBadges(
        placed.map((p) => ({ shapeId: p.shapeId, x: p.x, y: p.y, n: p.n, rank: p.rank ?? 0 })),
        scale,
      ),
    [placed, scale],
  )
  const at = (x: number, y: number) => ({
    transform: `translate(${x}px, ${y}px) scale(${scale}) translate(-18px, -14px)`,
  })
  return (
    <>
      {groups.map((g) => {
        const [first] = g.members
        if (!first) return null
        if (g.members.length === 1)
          return (
            <div
              key={first.shapeId}
              className={`dr-wk-badge${first.rank <= 3 ? ' dr-wk-badge--top' : ''}`}
              data-testid="vote-count"
              data-shape-id={first.shapeId}
              data-rank={first.rank}
              style={at(g.x, g.y)}
              title={`${votesText(first.n)} (rank ${first.rank})`}
            >
              {first.rank <= 3 && <span className="dr-wk-badge__rank">#{first.rank}</span>}
              {first.n}
            </div>
          )
        const label = `${g.members.length} results here, ${votesText(g.votes)} in all, the best ranked ${g.best}. Zoom in to see each.`
        return (
          <button
            type="button"
            key={`group:${first.shapeId}`}
            className={`dr-wk-badge dr-wk-badge--group${g.best <= 3 ? ' dr-wk-badge--top' : ''}`}
            data-testid="vote-count-group"
            data-count={g.members.length}
            data-rank={g.best}
            style={at(g.x, g.y)}
            title={label}
            aria-label={label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() =>
              zoomToRefs(
                ctx,
                g.members.map((m) => m.shapeId),
              )
            }
          >
            {g.best <= 3 && <span className="dr-wk-badge__rank">#{g.best}</span>}
            <span aria-hidden="true">+{g.members.length - 1}</span>
            {/* Each result stays readable to screen readers (and findable by its shape id). */}
            <span className="dr-sr-only">
              {g.members.map((m) => (
                <span key={m.shapeId} data-testid="vote-count" data-shape-id={m.shapeId} data-rank={m.rank}>
                  #{m.rank}: {votesText(m.n)}.{' '}
                </span>
              ))}
            </span>
          </button>
        )
      })}
    </>
  )
}

/** Zooms to what a group badge stands for (at 100% at most), so its badges come apart. */
function zoomToRefs(ctx: Ctx, refs: readonly string[]) {
  const canvas = ctx.canvas
  const boxes = refs.map((ref) => {
    const id = ref.startsWith('shape:') ? ref.slice('shape:'.length) : ref
    return canvas.bounds(id)
  })
  const all = geometry.union(boxes)
  if (!all) return
  zoomToBounds(canvas, all, { maxZoom: 1 })
}

// ---- the message stack -------------------------------------------------------------------------------------

/**
 * K3-6: how to vote with the keyboard, for the prompt's description (screen readers read it with the card
 * and its Join button). On screen the prompt says one short line; the keys took two.
 */
export const VOTE_KEYS_HELP =
  'Keyboard: Tab from the board goes to an object’s +, Enter or Space adds a vote, Tab moves to the next object and Esc returns to the board.'

/** "Fay" from "Fay Facilitator (guest)": the first word, as the note-author label names people. */
const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? name

/**
 * K3-1: the "Vote started" banner (the vote's join card, RETRO-11's stack): who started it, what the vote
 * takes and how many dots this person has, one click to join and vote ("Join and vote"), or, after a click on
 * an object before joining, one click to join and give that object its first dot. Up once per vote for each
 * person who may vote here and has neither joined nor said "Not now" (../store.ts `voteBanner`); the
 * keyboard help is its description (K3-6).
 */
export function JoinPrompt({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const keysId = useId()
  const snap = store.getSnapshot()
  const banner = snap.voteBanner
  const vote = snap.vote
  const offer = snap.joinOffer
  const by = useValue(
    'dr-wk-banner-by',
    () =>
      banner ? (ctx.canvas.collaborators().find((c) => c.uid === banner.createdBy)?.name ?? null) : null,
    [ctx.canvas, banner?.createdBy],
  )
  const [busy, setBusy] = useState(false)
  // K3-1 (wave K integration, the K3 review): the banner takes no focus, so a screen reader is told a vote
  // began, in the board's polite live region (one set of live regions per board), once per banner shown
  const bannerSeq = banner?.seq
  useEffect(() => {
    if (bannerSeq === undefined) return
    const now = store.getSnapshot()
    const b = now.voteBanner
    if (!b || now.vote?.session.id !== b.sessionId) return
    const name =
      b.createdBy !== ctx.me.user.id
        ? ctx.canvas.collaborators().find((c) => c.uid === b.createdBy)?.name
        : null
    const who = name ? `${firstWord(name)} started a vote` : 'Vote started'
    announcerFor(ctx.canvas).sayPolitely(`${who}: ${now.vote.session.title}. Join and vote is on the board.`)
  }, [bannerSeq, ctx, store])
  if (!banner || !vote || vote.session.id !== banner.sessionId) return null
  const s = vote.session
  const left = vote.myRemaining
  const startedBy =
    by && banner.createdBy !== ctx.me.user.id ? `${firstWord(by)} started a vote` : 'Vote started'
  const target = offer ? labelOfRef(offer.shapeId, (id) => ctx.canvas.get(id)) : null
  const joinAndCast = async () => {
    setBusy(true)
    const r = await store.joinAndCast()
    setBusy(false)
    if (r && !r.ok && r.error)
      ctx.notify({ key: 'vote-cast', text: r.error, testId: 'vote-toast', timeoutMs: 3500 })
    const after = store.getSnapshot()
    if (r?.ok && after.ballot && after.vote)
      store.announce(castAnnouncement(1, after.ballot.myRemaining, after.vote.session.votesPerPerson))
  }
  return (
    <div
      className="dr-wk-prompt dr-wk-banner"
      role="dialog"
      aria-label="Vote started"
      aria-describedby={keysId}
      data-testid="vote-join-prompt"
      data-banner-seq={banner.seq}
      data-offer={offer?.shapeId}
    >
      <p className="dr-wk-banner__eyebrow" data-testid="vote-banner-by">
        <span className="dr-wk-chip__dot" aria-hidden="true" />
        {startedBy}
      </p>
      <p>
        <strong>{s.title}</strong> — you have {left} vote{left === 1 ? '' : 's'} to place on
        {s.scope === 'frame'
          ? ' objects in one frame'
          : s.scope === 'selection'
            ? ' the selected frames and objects'
            : ' objects on the board'}
        .
      </p>
      <p className="dr-wk-hint">
        <span className="dr-wk-hint--fine" data-testid="vote-click-hint">
          Click objects to vote; click your dot to take one back.
        </span>
        {/* Touch screens (final review R6): no keyboard to talk about. */}
        <span className="dr-wk-hint--coarse" data-testid="vote-touch-hint">
          Tap objects to vote; tap your dot to take one back.
        </span>
      </p>
      <span id={keysId} className="dr-sr-only" data-testid="vote-keys-hint">
        {VOTE_KEYS_HELP}
      </span>
      <div className="dr-wk-row">
        {offer && target !== null ? (
          <>
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm dr-wk-banner__cast"
              data-testid="vote-join-cast"
              aria-describedby={keysId}
              disabled={busy}
              onClick={() => void joinAndCast()}
            >
              Join and vote for “{target}”
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="vote-join"
              disabled={busy}
              onClick={() => void store.joinVote(s.id)}
            >
              Join
            </button>
          </>
        ) : (
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="vote-join"
            aria-describedby={keysId}
            onClick={() => void store.joinVote(s.id)}
          >
            Join and vote
          </button>
        )}
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="vote-skip"
          onClick={() => {
            store.setParticipation(s.id, 'skipped')
            ctx.notify({
              key: 'vote-skip',
              text: 'You can join later from Voting in the top bar’s Facilitate (or Session) menu.',
              testId: 'vote-toast',
            })
          }}
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/**
 * K3-1: before joining, a plain click (no drag) on an object the open vote takes offers to join and give it
 * a dot (the banner's "Join and vote for …"). The press is not claimed: the object is selected and moves as
 * usual, and nothing is cast until the person joins.
 */
function ClickToOffer({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const rule = useRule(store)
  const sid = store.getSnapshot().voteBanner?.sessionId ?? null
  useEffect(() => {
    if (!rule || !sid) return
    const canvas = ctx.canvas
    let pressed: { x: number; y: number; id: string } | null = null
    return canvas.on('input', (e) => {
      if (e.type === 'pointer-down') {
        pressed = null
        if (e.button !== 0 || !plainPress(e) || canvas.editingId()) return
        const tool = canvas.tool()
        if (tool !== 'select' && tool !== 'hand') return
        const click = voteClickAt(canvas, e.scene, rule)
        if (click.kind === 'vote') pressed = { x: e.screen.x, y: e.screen.y, id: click.target.id }
        return
      }
      if (e.type === 'pointer-up') {
        const p = pressed
        pressed = null
        if (!p || Math.hypot(e.screen.x - p.x, e.screen.y - p.y) > CLICK_SLOP_PX) return
        const ref = refOf(p.id)
        if (ref) store.offerJoin(sid, ref)
      }
    })
  }, [ctx, rule, sid, store])
  return null
}

function VotingBar({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const snap = store.getSnapshot()
  const vote = snap.vote
  const [busy, setBusy] = useState(false)
  if (vote?.session.status !== 'open') return null
  const remaining = snap.ballot?.myRemaining ?? vote.myRemaining
  const setDone = async (done: boolean) => {
    setBusy(true)
    const r = await store.setDone(done)
    setBusy(false)
    if (!r.ok && r.error) ctx.notify({ key: 'vote-done', text: r.error, tone: 'error', testId: 'vote-toast' })
  }
  return (
    <section className="dr-wk-votebar" aria-label="Voting" data-testid="vote-bar">
      <span className="dr-wk-chip__dot" aria-hidden="true" />
      {vote.done ? (
        <span>You're done voting.</span>
      ) : (
        <span title="Keyboard: Tab from the board to an object’s +, then Enter">
          <span className="dr-wk-hint--fine">Click objects to vote</span>
          <span className="dr-wk-hint--coarse">Tap objects to vote</span>
        </span>
      )}
      <span
        className="dr-wk-votebar__left"
        data-testid="vote-remaining"
        data-remaining={remaining}
        aria-live="polite"
      >
        {remaining} of {vote.session.votesPerPerson} left
      </span>
      {vote.done ? (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="vote-undone"
          disabled={busy}
          onClick={() => void setDone(false)}
        >
          Keep voting
        </button>
      ) : (
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="vote-done"
          disabled={busy}
          onClick={() => void setDone(true)}
        >
          I'm done
        </button>
      )}
      <button type="button" className="dr-linkbtn" onClick={() => ctx.openPanel('voting')}>
        Details
      </button>
    </section>
  )
}

/**
 * K3-2: the facilitator's own line for an open vote, on the board: how many of the people here voted, and a
 * clear end ("Show results", the panel's "End and show results"). Not while the Voting panel, which says the
 * same, is open.
 */
export function VoteFacilitatorBar({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const snap = store.getSnapshot()
  const vote = snap.vote
  const facilitator = useIsFacilitator(ctx)
  const castSome = Object.keys(snap.ballot?.myVotes ?? {}).length > 0
  const voted = useVoted(ctx, vote ?? { participants: 0, done: false }, castSome)
  const [busy, setBusy] = useState(false)
  if (!facilitator || vote?.session.status !== 'open' || ctx.activePanel === 'voting') return null
  return (
    <section className="dr-wk-facilbar" aria-label="Your vote" data-testid="vote-facilitator-bar">
      <span className="dr-wk-facilbar__what">{vote.session.title}</span>
      <span
        className="dr-wk-facilbar__count"
        data-testid="vote-bar-voted"
        data-voted={voted.voted}
        data-of={voted.of}
        aria-live="polite"
      >
        {describeVoted(voted)}
      </span>
      <button
        type="button"
        className="dr-btn dr-btn--primary dr-btn--sm"
        data-testid="vote-bar-reveal"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          const r = await store.revealVote()
          setBusy(false)
          if (!r.ok && r.error)
            ctx.notify({ key: 'vote-reveal', text: r.error, tone: 'error', testId: 'vote-toast' })
        }}
      >
        Show results
      </button>
      <button type="button" className="dr-linkbtn" onClick={() => ctx.openPanel('voting')}>
        More
      </button>
    </section>
  )
}

function FollowToast({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const who = store.getSnapshot().summonedBy
  const following = useValue('dr-wk-following', () => followingNow(ctx.canvas), [ctx.canvas])
  if (!who || !following) return null
  // One way out on screen: the people feature's "Stop following" on the "Following …" label at the top of the
  // canvas (3c; the tldraw page's button sat at the top left). This notice explains.
  return (
    <div className="dr-wk-follow" role="status" data-testid="follow-toast">
      <span>
        Following <strong>{who.name}</strong>. Move, zoom or click to look around on your own, or use{' '}
        <em>Stop following</em> at the top.
      </span>
    </div>
  )
}

const RESULTS_CARD_MS = 30_000
const PLACES = ['1st', '2nd', '3rd']

/**
 * "Results are in" for everyone who was on the board when a vote was revealed (RETRO-08): the top 3
 * with their counts and a way to the full ranking in the Voting panel. Not while presenting, not while
 * the Voting panel (which shows the same) is open.
 */
function ResultsCard({ ctx, store }: { ctx: Ctx; store: WorkshopStore }) {
  const snap = store.getSnapshot()
  const vote = snap.vote
  const seq = snap.resultsNews?.seq
  useEffect(() => {
    if (seq === undefined) return
    const t = setTimeout(() => store.dismissResultsNews(), RESULTS_CARD_MS)
    return () => clearTimeout(t)
  }, [seq, store])
  if (!vote?.results) return null
  const top = topResults(vote.results, 3)
  const get = (id: string) => ctx.canvas.get(id)
  return (
    <section className="dr-wk-results-card" aria-label="Vote results" data-testid="vote-results-card">
      <div className="dr-wk-results-card__head">
        <strong>Results are in</strong>
        <span className="dr-muted">{vote.session.title}</span>
        <button
          type="button"
          className="dr-iconbtn dr-wk-results-card__close"
          aria-label="Dismiss the results"
          onClick={() => store.dismissResultsNews()}
        >
          ×
        </button>
      </div>
      {top.length === 0 ? (
        <p className="dr-muted">Nobody voted.</p>
      ) : (
        <ol className="dr-wk-results-card__list">
          {top.map((r) => (
            <li key={r.shapeId} data-testid="vote-results-card-row" data-shape-id={r.shapeId}>
              <span className="dr-wk-rank__place dr-wk-rank__place--top">
                {PLACES[r.rank - 1] ?? `${r.rank}th`}
              </span>
              <span className="dr-wk-results-card__label">{labelOfRef(r.shapeId, get)}</span>
              <span className="dr-wk-rank__count">
                {r.count} <span className="dr-sr-only">vote{r.count === 1 ? '' : 's'}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-btn--primary"
        data-testid="vote-results-card-all"
        onClick={() => {
          store.dismissResultsNews()
          ctx.openPanel('voting')
        }}
      >
        See all results
      </button>
    </section>
  )
}

// ---- the reveal ------------------------------------------------------------------------------------------------

/** How long the reveal's confetti falls (its pieces start within half a second, each falls 1.8 s). */
const CONFETTI_MS = 2_600

/**
 * K3-5: when this tab sees a vote's results come in (the "Results are in" news, ../store.ts resultsNews), a
 * short confetti fall over the board: an overlay that takes no pointer, writes nothing, and is not drawn for
 * people who prefer reduced motion.
 */
export function RevealConfetti({ seq, reduced: forced }: { seq: number | null; reduced?: boolean }) {
  const prefers = useMediaQuery(REDUCED_MOTION_QUERY)
  const reduced = forced ?? prefers
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (seq === null) return
    setShown(seq)
    const t = setTimeout(() => setShown(null), CONFETTI_MS)
    return () => clearTimeout(t)
  }, [seq])
  const at = shown ?? (forced !== undefined ? seq : null)
  if (at === null) return null
  const pieces = revealConfetti(reduced, at)
  if (pieces.length === 0) return null
  return (
    <div className="dr-wk-confetti" data-testid="vote-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          // a fixed list for one reveal
          key={i}
          className="dr-wk-confetti__piece"
          style={
            {
              left: `${p.x}%`,
              background: p.color,
              '--delay': `${p.delayMs}ms`,
              '--drift': `${p.drift}px`,
              '--spin': `${p.spin}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}

// ---- the timer over the canvas -----------------------------------------------------------------------------

/** How long the time's-up flash and its message stay (the pill stays red a little longer). */
const FLASH_MS = 4_000

/** The one time's-up message (RETRO-23a): a flash around the canvas with "Time's up", announced. */
function TimerFlash({ seq }: { seq: number }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (seq === 0) return
    setShown(seq)
    const t = setTimeout(() => setShown(0), FLASH_MS)
    return () => clearTimeout(t)
  }, [seq])
  if (!shown) return null
  return (
    <div key={shown} className="dr-wk-flash" data-testid="timer-flash">
      <span className="dr-wk-flash__text" role="status" data-testid="timer-finished">
        Time's up
      </span>
    </div>
  )
}

/**
 * Read-only timer on the canvas where the top bar's pill cannot be seen: while presenting (the top bar
 * is hidden then; top-left, like Miro), and on phones (the pill is in the "⋯" menu; top-right).
 */
function PresentingTimer({ store, corner }: { store: WorkshopStore; corner: 'left' | 'right' }) {
  const snap = store.getSnapshot()
  const running = snap.timer?.status === 'running'
  const now = useNow(running)
  if (!snap.timer) return null
  const offset = store.serverOffsetMs()
  // Only a live countdown floats over the slides; a finished or stopped timer stays out of the way
  // (the flash still marks zero while presenting).
  const phase = timerDisplayPhase(snap.timer, now, offset)
  if (phase !== 'running' && phase !== 'paused') return null
  return (
    <div
      className={`dr-wk-floating${corner === 'right' ? ' dr-wk-floating--corner' : ''}`}
      data-testid="timer-floating"
      data-state={phase}
      role="timer"
      aria-live="off"
    >
      <StopwatchIcon />
      {formatClock(timerRemainingMs(snap.timer, now, offset))}
    </div>
  )
}
