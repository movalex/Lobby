// OWNER: 3f (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'workshops' feature on the Excalidraw board
// page: facilitation for live sessions (checklist FAC-01..08, PRF-07; plan §4.4), the tldraw board's
// features/workshops/index.tsx on the canvas API:
//  - a shared timer (top bar; server end timestamps; chime + flash at zero, mutable per person);
//  - anonymous dot voting (setup dialog, click-to-vote on the canvas, the stepper and Tab for the
//    keyboard, "I'm done", ranked results, the results card, CSV) and the `vote` pointer tool;
//  - +1 on notes, reactions and raise hand;
//  - private brainstorming (drafts, the "Private ideas" frame, reveal through the api's place-notes);
//  - "Gather everyone": others follow the facilitator's view (3c's follow) until they move;
//  - the session settings "Hide note authors" and "Hide everyone's cursors" (lb_doc `workshop`), and the
//    note-author label they hide (./NoteAuthors.tsx; CR-3F-4: this feature draws the overlays on notes).
//
// Registry entries (docs/EXCALIDRAW-CONTRACTS.md §3): the top-bar item `workshops`, the dock panels
// `voting` and `private-notes`, four overlay layers (./WorkshopOverlay.tsx, ./NoteAuthors.tsx), the `vote`
// tool, the cursor filter while cursors are hidden, and (only while this person votes) a Tab key.
import { WORKSHOP_EVENTS, WorkshopSummonEvent } from '@draftroom/contracts'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  FeatureKeySpec,
  FeatureToolSpec,
  LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { react } from '../../../lib/signals.ts'
import { installAudioUnlock } from '../chime.ts'
import { provideVoteResultsForExport, shownResults } from '../vote-export.ts'
import { storeFor } from '../workshop-context.ts'
import {
  followingNow,
  onFollowChanged,
  readableFollowCamera,
  startFollowing,
  stopFollowing,
} from './camera.ts'
import { NoteAuthorsLayer } from './NoteAuthors.tsx'
import { isPresentingHere } from './presenting.ts'
import { mountPrivateNotes, privateNotesPanel } from './private-notes/index.tsx'
import { HIDE_AUTHORS_ATTR, workshopSettingsOf } from './session-settings.ts'
import { VotingPanel } from './VotingPanel.tsx'
import { selectEligible, selectedEligible, voteClickAt } from './voting-canvas.ts'
import { WorkshopBar } from './WorkshopBar.tsx'
import {
  castVote,
  notInVote,
  stepperTarget,
  WorkshopLayer,
  WorkshopMarksLayer,
  WorkshopTopLayer,
} from './WorkshopOverlay.tsx'
import '../workshops.css'

type Ctx = CanvasFeatureContext

const FOLLOW_RETRIES = 10
const FOLLOW_RETRY_MS = 300
const CLICK_SLOP_PX = 5

function BallotIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="8" cy="9" r="3" fill="currentColor" />
      <circle cx="16" cy="9" r="3" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="16" r="3" fill="currentColor" opacity="0.8" />
    </svg>
  )
}

/** Whether this browser should start following for `event` (never the summoner's own tabs; ../follow.ts). */
export function summonApplies(event: WorkshopSummonEvent, selfUserId: string): boolean {
  if (event.userId === selfUserId) return false
  return event.targetUserId === null || event.targetUserId === selfUserId
}

/** The session to follow for a Lobby user id: one of their tabs whose cursor streams (not idle) first. */
export function followSidFor(canvas: LobbyCanvas, userId: string): string | null {
  let best: { sid: string; idle: boolean } | null = null
  for (const p of canvas.presence.peers()) {
    if (p.uid !== userId) continue
    if (!best || (best.idle && !p.idle)) best = { sid: p.sid, idle: p.idle }
  }
  if (best) return best.sid
  return canvas.collaborators().find((c) => c.uid === userId)?.sid ?? null
}

/** This person is casting votes right now: an open vote they joined and are not done with, not presenting. */
function votingNow(ctx: Ctx): boolean {
  const snap = storeFor(ctx).getSnapshot()
  const vote = snap.vote
  return (
    vote?.session.status === 'open' &&
    snap.participation === 'joined' &&
    !vote.done &&
    !isPresentingHere(ctx.canvas)
  )
}

/** The rule of the open vote (the eligibility of an object). */
function ruleNow(ctx: Ctx) {
  const s = storeFor(ctx).getSnapshot().vote?.session
  return s ? { scope: s.scope, frameId: s.frameId ?? null, shapeTypes: s.shapeTypes ?? null } : null
}

/**
 * Tab on the board while this person votes (RETRO-06): into the selected object's stepper, or, with
 * nothing selected, to the first object of the vote. Anything else selected (an object the vote does
 * not accept) keeps the browser's own Tab. Registered only while voting (as the tldraw board's capture
 * listener existed only then), so it is in no static key table: Tab is no feature's shortcut.
 */
export const VOTE_TAB_KEY: FeatureKeySpec = {
  id: 'workshops.vote-tab',
  scope: 'canvas',
  chords: ['tab'],
  match: (_e, ctx) => votingNow(ctx),
  handle: (_e, ctx) => {
    const rule = ruleNow(ctx)
    if (!rule) return false
    const canvas = ctx.canvas
    const target = selectedEligible(canvas, rule) ? stepperTarget(document) : null
    if (target) {
      target.focus()
      return true
    }
    if (canvas.selection.length > 0) return false
    if (!selectEligible(canvas, rule, 1)) return false
    // The stepper mounts on the next render.
    requestAnimationFrame(() => stepperTarget(document)?.focus())
    return true
  },
}

/** Where the vote tool's press started: the scene point, and the pointer on screen then. */
let toolPress: { point: { x: number; y: number }; screen: { x: number; y: number } | null } | null = null

/**
 * The `vote` pointer tool (docs/EXCALIDRAW-CONTRACTS.md §3: comment, vote and open-card are Lobby's
 * custom tools, also for read-only roles): a click on an object casts one of my dots, and never selects
 * it. The select and hand tools vote the same way while this person votes (./WorkshopOverlay.tsx
 * ClickToVote), so the tool has no toolbar button: other UI (a phone sheet) may pick it. A drag is not a
 * click: the engine reports a custom tool's release at its press, so the move is read from the pointer.
 */
export const VOTE_TOOL: FeatureToolSpec = {
  id: 'vote',
  label: 'Vote',
  readOnlyAllowed: true,
  cursor: 'pointer',
  onPointerDown(e, ctx) {
    toolPress = { point: { x: e.point.x, y: e.point.y }, screen: ctx.canvas.pointer()?.screen ?? null }
  },
  onPointerUp(_e, ctx) {
    const p = toolPress
    toolPress = null
    if (!p) return
    const now = ctx.canvas.pointer()?.screen ?? null
    if (!p.screen || !now || Math.hypot(now.x - p.screen.x, now.y - p.screen.y) > CLICK_SLOP_PX) return
    const rule = ruleNow(ctx)
    if (!rule || !votingNow(ctx)) return
    // The topmost object decides (W5-03): one the vote does not take casts nothing, whatever is under it.
    const click = voteClickAt(ctx.canvas, p.point, rule)
    if (click.kind === 'vote') void castVote(ctx, storeFor(ctx), `shape:${click.target.id}`, 1)
    else if (click.kind === 'not-in-vote') notInVote(ctx, rule)
  },
  onExit() {
    toolPress = null
  },
}

function mountWorkshops(ctx: Ctx) {
  const { canvas, registries } = ctx
  const store = storeFor(ctx)
  installAudioUnlock()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const offs: (() => void)[] = []

  // Gather everyone: follow the summoner's view (3c's follow). Their presence may arrive a moment after
  // the event (e.g. they just joined), so retry briefly. R2-04: while gathered, a much narrower screen
  // (a phone) sees the summoner's view centre at a readable zoom, not all of it at 11 % (./camera.ts
  // readableFollowCamera, from the canvas size the summon carries).
  offs.push(
    ctx.events.on(WORKSHOP_EVENTS.summon, (data) => {
      const p = WorkshopSummonEvent.safeParse(data)
      if (!p.success || !summonApplies(p.data, ctx.me.user.id)) return
      const { userId, name } = p.data
      const camera = readableFollowCamera(p.data.screen)
      const unavailable = () =>
        ctx.notify({
          key: 'summon',
          text: `${name} asked everyone to follow their view, but it isn't available here yet.`,
          testId: 'summon-toast',
        })
      const attempt = (n: number) => {
        const sid = followSidFor(canvas, userId)
        if (sid) {
          if (!startFollowing(canvas, sid, { camera })) return unavailable()
          if (followingNow(canvas) === sid) store.setSummonedBy({ userId, name })
          return
        }
        if (n >= FOLLOW_RETRIES) return unavailable()
        const t = setTimeout(() => {
          timers.delete(t)
          attempt(n + 1)
        }, FOLLOW_RETRY_MS)
        timers.add(t)
      }
      attempt(0)
    }),
  )

  // A plain click on the canvas ends following (FAC-01/02: any pan, zoom or click is an easy way out).
  offs.push(
    canvas.on('input', (e) => {
      if (e.type === 'pointer-down' && e.button === 0 && followingNow(canvas)) stopFollowing(canvas)
    }),
  )
  offs.push(
    onFollowChanged(canvas, (sid) => {
      if (!sid) store.setSummonedBy(null)
    }),
  )

  // "Hide note authors" (a synced session setting): the note-author layer (./NoteAuthors.tsx) stops
  // drawing, and whatever else draws note attribution hides it through this <html> attribute.
  const root = canvas.container()?.ownerDocument.documentElement ?? document.documentElement
  offs.push(
    react('dr-wk-hide-authors', () => {
      if (workshopSettingsOf(canvas).hideNoteAuthors) root.setAttribute(HIDE_AUTHORS_ATTR, 'true')
      else root.removeAttribute(HIDE_AUTHORS_ATTR)
    }),
  )
  offs.push(() => root.removeAttribute(HIDE_AUTHORS_ATTR))

  // "Hide everyone's cursors": nobody's cursor is drawn while it is on. The cursor filter has one
  // provider at a time (present mode provides one too, 3e): while the setting is on, this feature
  // provides again whenever another provider took the slot or let it go (a change request asks for a
  // combined filter, docs/research/excalidraw/wave3/3F.md).
  let unprovide: (() => void) | null = null
  const hidden = () => false
  const syncCursors = () => {
    const on = workshopSettingsOf(canvas).hideCursors
    if (!on) {
      unprovide?.()
      unprovide = null
      return
    }
    if (!unprovide || registries.cursorVisible.call('?') !== false) {
      unprovide?.()
      unprovide = registries.cursorVisible.provide(hidden)
    }
  }
  offs.push(react('dr-wk-hide-cursors', syncCursors))
  offs.push(registries.subscribe(() => queueMicrotask(syncCursors)))
  offs.push(() => {
    unprovide?.()
    unprovide = null
  })

  // Tab into the stepper, only while this person votes (see VOTE_TAB_KEY).
  let offTab: (() => void) | null = null
  const syncTab = () => {
    const on = votingNow(ctx)
    if (on && !offTab) {
      const offSpec = registries.featureKeys.register(VOTE_TAB_KEY)
      const offKey = registries.keys.register({
        id: `key:${VOTE_TAB_KEY.id}`,
        scope: 'canvas',
        match: (e) =>
          e.key === 'Tab' &&
          !e.shiftKey &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !!VOTE_TAB_KEY.match?.(e, ctx),
        handle: (e) => VOTE_TAB_KEY.handle(e, ctx),
      })
      offTab = () => {
        offKey()
        offSpec()
      }
    } else if (!on && offTab) {
      offTab()
      offTab = null
    }
  }
  offs.push(store.subscribe(syncTab))
  // also when present mode starts or ends (votingNow reads the canvas's focus mode)
  offs.push(react('dr-wk-vote-tab', syncTab))
  offs.push(() => {
    offTab?.()
    offTab = null
  })

  // Private brainstorming: a notice when a session ends; the revealing tab shows the placed notes.
  offs.push(mountPrivateNotes(ctx))

  // Exports draw a revealed vote's result badges, as this person sees them (../vote-export.ts, R14):
  // present-export reads them with `voteResultsForExport(canvas)` on this page.
  offs.push(provideVoteResultsForExport(canvas, () => shownResults(store.getSnapshot())))

  return () => {
    for (const t of timers) clearTimeout(t)
    for (const off of offs.reverse()) off()
  }
}

export const feature: CanvasFeature = {
  id: 'workshops',
  // tldraw's BOARD_FEATURES order (W5-50, ./chrome-order.test.ts): the workshop items before Present and
  // export (30) and Sharing (50); the Voting and Private notes panels after Comments and the navigation
  // panels, before History (70)
  topBar: [{ id: 'workshops', order: 25, overflowCaption: 'Timer and voting', component: WorkshopBar }],
  panels: [
    { id: 'voting', label: 'Voting', icon: BallotIcon, order: 40, component: VotingPanel },
    privateNotesPanel,
  ],
  overlays: [
    // who last edited each note: part of the note's face, so under every other layer (tags' Show only
    // veil and search's dimming included); shown while presenting, as tldraw's note face was
    {
      id: 'workshops-authors',
      layer: 'scene',
      order: 4,
      pointer: 'none',
      focusMode: 'show',
      component: NoteAuthorsLayer,
    },
    // the revealed counts sit under the top bar's popovers; the rest above the canvas's own chrome
    {
      id: 'workshops-marks',
      layer: 'scene',
      order: 15,
      pointer: 'none',
      focusMode: 'show',
      component: WorkshopMarksLayer,
    },
    {
      id: 'workshops',
      layer: 'scene',
      order: 249,
      pointer: 'none',
      focusMode: 'show',
      component: WorkshopLayer,
    },
    // above everything, the presentation included (the tldraw board's z-index 10001)
    {
      id: 'workshops-top',
      layer: 'screen',
      order: 10001,
      pointer: 'none',
      focusMode: 'show',
      component: WorkshopTopLayer,
    },
  ],
  tools: [VOTE_TOOL],
  onMount: mountWorkshops,
}
