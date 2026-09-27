// Canvas overlay for the workshops feature (rendered inside <Tldraw>, so it sits in the editor's
// container and uses viewport coordinates): my vote dots, the +/- control on the selected object,
// revealed counts, the join/skip prompt, the voting bar, the "you're following" toast, the time's-up
// flash and a read-only timer while presenting (FAC-03: visible in presentation mode too).

import { isVoteEligible, type VoteEligibilityRule } from '@draftroom/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type TLEventInfo, type TLShapeId, useValue } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import { formatClock, timerPhase, timerRemainingMs } from './countdown.ts'
import { editorLookup, useNow, useWorkshop } from './hooks.ts'
import type { WorkshopStore } from './store.ts'
import { shapeLabel } from './voting.ts'
import { StopwatchIcon } from './WorkshopBar.tsx'

interface Placed {
  shapeId: string
  x: number
  y: number
  n: number
  rank?: number
  label?: string
}

const CLICK_SLOP_PX = 5
const SAME_SHAPE_DEBOUNCE_MS = 300

/** Screen positions (top-right corner) of shapes on the current page, recomputed with the camera. */
function usePlacements(
  ctx: FeatureContext,
  counts: Record<string, { n: number; rank?: number }>,
  testKey: string,
) {
  const editor = ctx.editor
  const key = useValue(`dr-wk-placements-${testKey}`, () => {
    const page = editor.getCurrentPageId()
    const out: Placed[] = []
    for (const [shapeId, c] of Object.entries(counts)) {
      const s = editor.getShape(shapeId as TLShapeId)
      if (!s || editor.getAncestorPageId(s) !== page) continue
      const b = editor.getShapePageBounds(s)
      if (!b) continue
      const pt = editor.pageToViewport({ x: b.maxX, y: b.minY })
      out.push({ shapeId, x: Math.round(pt.x), y: Math.round(pt.y), n: c.n, rank: c.rank })
    }
    return JSON.stringify(out)
  }, [editor, counts])
  return useMemo(() => JSON.parse(key) as Placed[], [key])
}

/**
 * The present-export feature marks a running presentation with this attribute on <html> (see
 * features/present-export/present-session.ts PRESENTING_ATTR); it hides the top bar and the notices.
 */
const PRESENTING_ATTR = 'data-dr-presenting'

function isPresentingNow(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.hasAttribute(PRESENTING_ATTR)) return true
  // Full screen without the top bar (e.g. the browser's own full screen on the canvas).
  const fs = document.fullscreenElement
  const pill = document.querySelector('[data-testid="timer-pill"]')
  return !!fs && !(pill && fs.contains(pill))
}

/** Whether the board is being presented (top bar hidden), kept current with the DOM. */
export function usePresenting(): boolean {
  const [presenting, setPresenting] = useState(isPresentingNow)
  useEffect(() => {
    const update = () => setPresenting(isPresentingNow())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [PRESENTING_ATTR] })
    document.addEventListener('fullscreenchange', update)
    update()
    return () => {
      mo.disconnect()
      document.removeEventListener('fullscreenchange', update)
    }
  }, [])
  return presenting
}

export function WorkshopOverlay({ ctx }: { ctx: FeatureContext }) {
  const { store, snap } = useWorkshop(ctx)
  const presenting = usePresenting()
  const vote = snap.vote
  const open = vote?.session.status === 'open'
  const joined = open && snap.participation === 'joined'
  // While presenting, the slides stay clean: no prompts or controls (the presentation shields clicks).
  const voting = joined && !vote?.done && !presenting

  return (
    <>
      <div className="dr-wk-layer" data-testid="workshop-overlay">
        {joined && snap.ballot && <MyDots ctx={ctx} store={store} myVotes={snap.ballot.myVotes} />}
        {voting && <ClickToVote ctx={ctx} store={store} />}
        {voting && <SelectedStepper ctx={ctx} store={store} />}
        {vote?.session.status === 'revealed' && vote.results && snap.showResults && (
          <ResultBadges ctx={ctx} />
        )}
        {!presenting && open && snap.participation === null && <JoinPrompt ctx={ctx} store={store} />}
        {!presenting && joined && <VotingBar ctx={ctx} store={store} />}
        {!presenting && snap.summonedBy && <FollowToast ctx={ctx} store={store} />}
      </div>
      {/* Above the presentation overlay (z-index 10000), so the timer and its end signal stay visible. */}
      <div className="dr-wk-top">
        <TimerFlash seq={snap.alertSeq} />
        {presenting && <PresentingTimer store={store} />}
      </div>
    </>
  )
}

function useRule(store: WorkshopStore): VoteEligibilityRule | null {
  const s = store.getSnapshot().vote?.session
  const types = s?.shapeTypes ? JSON.stringify(s.shapeTypes) : null
  const has = !!s
  const scope = s?.scope
  const frameId = s?.frameId ?? null
  // Stable across refreshes (each refresh brings new objects with the same values).
  return useMemo<VoteEligibilityRule | null>(
    () =>
      has && scope ? { scope, frameId, shapeTypes: types ? (JSON.parse(types) as string[]) : null } : null,
    [has, scope, frameId, types],
  )
}

function useCast(ctx: FeatureContext, store: WorkshopStore) {
  return async (shapeId: string, delta: 1 | -1) => {
    const r = await store.cast(shapeId, delta)
    if (!r.ok && r.error)
      ctx.notify({ key: 'vote-cast', text: r.error, testId: 'vote-toast', timeoutMs: 3500 })
  }
}

function MyDots({
  ctx,
  store,
  myVotes,
}: {
  ctx: FeatureContext
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
  return (
    <>
      {placed.map((p) => {
        const label = shapeLabel(ctx.editor.getShape(p.shapeId as TLShapeId))
        return (
          <button
            key={p.shapeId}
            type="button"
            className="dr-wk-dot"
            data-testid="vote-dot"
            data-shape-id={p.shapeId}
            data-count={p.n}
            style={{ transform: `translate(${p.x - 12}px, ${p.y - 12}px)` }}
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

/** Elements inside the canvas that have their own click behaviour (file-card links, embeds, ...). */
const INTERACTIVE = 'a, button, input, textarea, select, iframe, [contenteditable="true"]'

/**
 * A primary click (no drag) on an eligible object adds a vote. Tools other than select/hand are left
 * alone.
 *
 * With the select tool, the click never reaches tldraw (Miro's voting mode works the same way): a
 * vote click must not SELECT the object, because everyone's selection is shared as presence, so the
 * outline (and the canvas socket) would show others which objects this person voted on (PRF-07). The
 * press is claimed in the capture phase with tldraw's own `markEventAsHandled`, which leaves every
 * non-tldraw listener alone. Presses with modifiers (Shift+drag still moves a note), on empty canvas
 * or on non-eligible objects go to tldraw as usual; plain clicks select, move and edit again after
 * "I'm done", "Skip" or once voting ends.
 * The hand tool never selects, so its clicks are read from the editor's own events.
 */
function ClickToVote({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
  const rule = useRule(store)
  const cast = useCast(ctx, store)
  const castRef = useRef(cast)
  castRef.current = cast
  useEffect(() => {
    if (!rule) return
    const editor = ctx.editor
    const container = editor.getContainer()
    const win = container.ownerDocument.defaultView ?? window
    const lookup = editorLookup(editor)
    const last = { id: '', at: 0 }
    const eligibleAt = (screen: { x: number; y: number }) =>
      editor.getShapeAtPoint(editor.screenToPage(screen), {
        hitInside: true,
        hitLabels: true,
        hitLocked: true,
        filter: (s) => isVoteEligible(s.id, lookup, rule),
      })
    const vote = (shapeId: string) => {
      const t = performance.now()
      if (last.id === shapeId && t - last.at < SAME_SHAPE_DEBOUNCE_MS) return // a double-click is one vote
      last.id = shapeId
      last.at = t
      void castRef.current(shapeId, 1)
    }
    const plain = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
      !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey

    // select tool: claim the press before tldraw sees it
    let pressed: { pointerId: number; x: number; y: number; shapeId: string } | null = null
    const onDown = (e: PointerEvent) => {
      pressed = null
      if (e.button !== 0 || !e.isPrimary || !plain(e)) return
      if (editor.getCurrentToolId() !== 'select' || editor.getEditingShapeId()) return
      const target = e.target instanceof Element ? e.target : null
      if (!target?.closest('.tl-canvas') || target.closest(INTERACTIVE)) return
      const shape = eligibleAt({ x: e.clientX, y: e.clientY })
      if (!shape) return
      editor.markEventAsHandled(e)
      pressed = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, shapeId: shape.id }
      // Voting is "moving" too: it ends following someone (FAC-02), as any canvas click does.
      if (editor.getInstanceState().followingUserId) editor.stopFollowingUser()
    }
    const onUp = (e: PointerEvent) => {
      const p = pressed
      if (!p || e.pointerId !== p.pointerId) return
      pressed = null
      editor.markEventAsHandled(e)
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return
      vote(p.shapeId)
    }
    const onCancel = (e: PointerEvent) => {
      if (pressed?.pointerId === e.pointerId) pressed = null
    }
    container.addEventListener('pointerdown', onDown, true)
    win.addEventListener('pointerup', onUp, true)
    win.addEventListener('pointercancel', onCancel, true)

    // hand tool: a click without a drag votes
    let handDown: { x: number; y: number } | null = null
    const onEvent = (info: TLEventInfo) => {
      if (info.type !== 'pointer' || info.button !== 0) return
      if (info.name === 'pointer_down') {
        handDown = editor.getCurrentToolId() === 'hand' ? { x: info.point.x, y: info.point.y } : null
        return
      }
      if (info.name !== 'pointer_up' || !handDown) return
      const moved = Math.hypot(info.point.x - handDown.x, info.point.y - handDown.y)
      handDown = null
      if (moved > CLICK_SLOP_PX || !plain(info) || editor.getCurrentToolId() !== 'hand') return
      const shape = eligibleAt(info.point)
      if (shape) vote(shape.id)
    }
    editor.on('event', onEvent)
    return () => {
      container.removeEventListener('pointerdown', onDown, true)
      win.removeEventListener('pointerup', onUp, true)
      win.removeEventListener('pointercancel', onCancel, true)
      editor.off('event', onEvent)
    }
  }, [ctx.editor, rule])
  return null
}

/** Keyboard/pointer +/- on the one selected eligible object (the accessible way to vote). */
function SelectedStepper({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
  const rule = useRule(store)
  const editor = ctx.editor
  const key = useValue('dr-wk-selected', () => {
    const s = editor.getOnlySelectedShape()
    if (!s || !rule || !isVoteEligible(s.id, editorLookup(editor), rule)) return ''
    const b = editor.getShapePageBounds(s)
    if (!b) return ''
    const pt = editor.pageToViewport({ x: b.midX, y: b.maxY })
    return JSON.stringify({ shapeId: s.id, x: Math.round(pt.x), y: Math.round(pt.y) })
  }, [editor, rule])
  const cast = useCast(ctx, store)
  if (!key) return null
  const p = JSON.parse(key) as { shapeId: string; x: number; y: number }
  const snap = store.getSnapshot()
  const n = snap.ballot?.myVotes[p.shapeId] ?? 0
  const label = shapeLabel(editor.getShape(p.shapeId as TLShapeId))
  return (
    <fieldset
      className="dr-wk-stepper"
      data-testid="vote-stepper"
      data-shape-id={p.shapeId}
      style={{ transform: `translate(calc(${p.x}px - 50%), ${p.y + 8}px)` }}
      aria-label={`Votes on ${label}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="dr-wk-stepper__btn"
        data-testid="vote-minus"
        aria-label={`Remove a vote from ${label}`}
        disabled={n === 0}
        onClick={() => void cast(p.shapeId, -1)}
      >
        −
      </button>
      <span className="dr-wk-stepper__n" aria-live="polite">
        {n}
      </span>
      <button
        type="button"
        className="dr-wk-stepper__btn"
        data-testid="vote-plus"
        aria-label={`Add a vote to ${label}`}
        disabled={(snap.ballot?.myRemaining ?? 0) <= 0}
        onClick={() => void cast(p.shapeId, 1)}
      >
        +
      </button>
    </fieldset>
  )
}

function ResultBadges({ ctx }: { ctx: FeatureContext }) {
  const { snap } = useWorkshop(ctx)
  const counts = useMemo(
    () =>
      Object.fromEntries((snap.vote?.results ?? []).map((r) => [r.shapeId, { n: r.count, rank: r.rank }])),
    [snap.vote?.results],
  )
  const placed = usePlacements(ctx, counts, 'results')
  return (
    <>
      {placed.map((p) => (
        <div
          key={p.shapeId}
          className={`dr-wk-badge${p.rank && p.rank <= 3 ? ' dr-wk-badge--top' : ''}`}
          data-testid="vote-count"
          data-shape-id={p.shapeId}
          data-rank={p.rank}
          style={{ transform: `translate(${p.x - 18}px, ${p.y - 14}px)` }}
          title={`${p.n} vote${p.n === 1 ? '' : 's'} (rank ${p.rank})`}
        >
          {p.rank && p.rank <= 3 && <span className="dr-wk-badge__rank">#{p.rank}</span>}
          {p.n}
        </div>
      ))}
    </>
  )
}

function JoinPrompt({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
  const vote = store.getSnapshot().vote
  const ref = useRef<HTMLDivElement>(null)
  if (!vote) return null
  const s = vote.session
  return (
    <div
      ref={ref}
      className="dr-wk-prompt"
      role="dialog"
      aria-label="Vote started"
      data-testid="vote-join-prompt"
    >
      <p>
        <strong>{s.title}</strong> — you have {vote.myRemaining} vote{vote.myRemaining === 1 ? '' : 's'} to
        place on
        {s.scope === 'frame' ? ' objects in one frame' : ' objects on the board'}.
      </p>
      <div className="dr-wk-row">
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="vote-join"
          onClick={() => store.setParticipation(s.id, 'joined')}
        >
          Join vote
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="vote-skip"
          onClick={() => {
            store.setParticipation(s.id, 'skipped')
            ctx.notify({
              key: 'vote-skip',
              text: 'You can join later from the voting chip in the top bar.',
              testId: 'vote-toast',
            })
          }}
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function VotingBar({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
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
      {vote.done ? <span>You're done voting.</span> : <span>Click objects to vote</span>}
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

function FollowToast({ ctx, store }: { ctx: FeatureContext; store: WorkshopStore }) {
  const who = store.getSnapshot().summonedBy
  const following = useValue('dr-wk-following', () => ctx.editor.getInstanceState().followingUserId, [
    ctx.editor,
  ])
  if (!who || !following) return null
  return (
    <div className="dr-wk-follow" role="status" data-testid="follow-toast">
      <span>
        Following <strong>{who.name}</strong>. Move, zoom or click to look around on your own.
      </span>
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="follow-stop"
        onClick={() => {
          ctx.editor.stopFollowingUser()
          store.setSummonedBy(null)
        }}
      >
        Stop following
      </button>
    </div>
  )
}

function TimerFlash({ seq }: { seq: number }) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (seq === 0) return
    setShown(seq)
    const t = setTimeout(() => setShown(0), 2600)
    return () => clearTimeout(t)
  }, [seq])
  if (!shown) return null
  return (
    <div key={shown} className="dr-wk-flash" data-testid="timer-flash" aria-hidden="true">
      <span className="dr-wk-flash__text">Time's up</span>
    </div>
  )
}

/** While the board is presented full screen the top bar is gone: show the timer on the canvas instead. */
/** Read-only timer while presenting (the top bar with the pill is hidden then). Top-left, like Miro. */
function PresentingTimer({ store }: { store: WorkshopStore }) {
  const snap = store.getSnapshot()
  const running = snap.timer?.status === 'running'
  const now = useNow(running)
  if (!snap.timer) return null
  const offset = store.serverOffsetMs()
  const phase = timerPhase(snap.timer, now, offset)
  if (phase === 'stopped' || phase === 'idle') return null
  return (
    <div
      className="dr-wk-floating"
      data-testid="timer-floating"
      data-state={phase}
      role="timer"
      aria-live="off"
    >
      <StopwatchIcon />
      {phase === 'finished' ? "Time's up" : formatClock(timerRemainingMs(snap.timer, now, offset))}
    </div>
  )
}
