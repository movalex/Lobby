// Feature module: workshops (docs/FEATURES-M2-CONTRACTS.md, "workshops"). Owned by the workshops
// engineer. Facilitation for live sessions (checklist FAC-01..06, PRF-07):
// - a shared timer (top bar; server end timestamps; chime + flash at zero, mutable per person);
// - anonymous dot voting (setup dialog, click-to-vote dots on the canvas, "I'm done", ranked results);
// - "Gather everyone": others follow the facilitator's view (tldraw follow API) until they move.
// - Reactions, raise hand and +1 on notes (FAC-08): Reactions.tsx, Hands.tsx, PlusOnes.tsx.

import { WORKSHOP_EVENTS, WorkshopSummonEvent } from '@draftroom/contracts'
import { type Atom, atom, Box, type Editor, react, type TLEventInfo } from 'tldraw'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { installAudioUnlock } from './chime.ts'
import { followIdFor, isCanvasPress, readableFollowViewport, summonApplies } from './follow.ts'
import { storeFor } from './hooks.ts'
import { plusOneIntentsFor, watchPlusOneIntents } from './plus-ones.ts'
import { mountPrivateNotes, privateNotesPanel } from './private-notes/index.tsx'
import { HIDE_AUTHORS_ATTR, readSessionSettings } from './session-settings.ts'
import { VotingPanel } from './VotingPanel.tsx'
import { provideVoteResultsForExport, shownResults } from './vote-export.ts'
import { WorkshopBar } from './WorkshopBar.tsx'
import { WorkshopOverlay } from './WorkshopOverlay.tsx'
import './workshops.css'

const FOLLOW_RETRIES = 10
const FOLLOW_RETRY_MS = 300

function BallotIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="8" cy="9" r="3" fill="currentColor" />
      <circle cx="16" cy="9" r="3" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="16" r="3" fill="currentColor" opacity="0.8" />
    </svg>
  )
}

type FollowBoundsFn = () => Box | null

/**
 * R2-04: tldraw (5.4.2) derives a follower's camera from the private, per-instance-overridable
 * `Editor.getViewportPageBoundsForFollowing` (it fits the leader's whole viewport). While `gathered`
 * is set, a much narrower screen gets `readableFollowViewport` instead; Present and other following
 * keep tldraw's fit. A tldraw without the method leaves following as it is.
 */
function installReadableFollow(editor: Editor, gathered: Atom<boolean>): () => void {
  const target = editor as unknown as { getViewportPageBoundsForFollowing?: FollowBoundsFn }
  const original = target.getViewportPageBoundsForFollowing
  if (typeof original !== 'function') return () => {}
  target.getViewportPageBoundsForFollowing = function readableBounds(this: unknown) {
    const fitted = original.call(editor)
    if (!fitted || !gathered.get()) return fitted
    const leaderId = editor.getInstanceState().followingUserId
    const leader = editor
      .getCollaborators()
      .filter((c) => c.userId === leaderId)
      .sort((a, b) => (b.lastActivityTimestamp ?? 0) - (a.lastActivityTimestamp ?? 0))[0]
    if (!leader?.camera || !leader.screenBounds) return fitted
    const screen = editor.getViewportScreenBounds()
    const v = readableFollowViewport(
      { x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h },
      { camera: leader.camera, screenBounds: leader.screenBounds },
      { w: screen.w, h: screen.h },
    )
    return v ? new Box(v.x, v.y, v.w, v.h) : fitted
  }
  return () => {
    Reflect.deleteProperty(target, 'getViewportPageBoundsForFollowing')
  }
}

function mountWorkshops(ctx: FeatureContext) {
  const { editor } = ctx
  const store = storeFor(ctx)
  installAudioUnlock()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  // R2-04: while gathered, a phone sees the leader's view at a readable zoom (not all of it at 11%).
  const gathered = atom('dr-wk-gathered', false)
  const stopReadableFollow = installReadableFollow(editor, gathered)

  // Gather everyone: follow the summoner's presence. Their presence may arrive a moment after the
  // event (e.g. they just joined), so retry briefly.
  const offSummon = ctx.events.on(WORKSHOP_EVENTS.summon, (data) => {
    const p = WorkshopSummonEvent.safeParse(data)
    if (!p.success || !summonApplies(p.data, ctx.me.user.id)) return
    const { userId, name } = p.data
    const attempt = (n: number) => {
      const followId = followIdFor(editor.getCollaborators(), userId)
      if (followId) {
        editor.startFollowingUser(followId)
        if (editor.getInstanceState().followingUserId === followId) {
          gathered.set(true)
          store.setSummonedBy({ userId, name })
        }
        return
      }
      if (n >= FOLLOW_RETRIES) {
        ctx.notify({
          key: 'summon',
          text: `${name} asked everyone to follow their view, but it isn't available here yet.`,
          testId: 'summon-toast',
        })
        return
      }
      const t = setTimeout(() => {
        timers.delete(t)
        attempt(n + 1)
      }, FOLLOW_RETRY_MS)
      timers.add(t)
    }
    attempt(0)
  })

  // tldraw ends following on wheel, pinch and camera moves; a plain click on the canvas should too
  // (FAC-01/02: any pan, zoom or click is an easy way out).
  const onEvent = (info: TLEventInfo) => {
    if (
      isCanvasPress(info as { type: string; name: string; button?: number }) &&
      editor.getInstanceState().followingUserId
    )
      editor.stopFollowingUser()
  }
  const onStopFollowing = () => {
    gathered.set(false)
    store.setSummonedBy(null)
  }
  editor.on('event', onEvent)
  editor.on('stop-following', onStopFollowing)

  // "Hide note authors" (a synced session setting): canvas and Present hide tldraw's note attribution
  // through this <html> attribute (workshops.css); exports strip it in present-export.
  const root = editor.getContainer().ownerDocument.documentElement
  const stopAuthors = react('dr-wk-hide-authors', () => {
    if (readSessionSettings(editor).hideNoteAuthors) root.setAttribute(HIDE_AUTHORS_ATTR, 'true')
    else root.removeAttribute(HIDE_AUTHORS_ATTR)
  })

  // +1s: re-apply this person's recent +1 when a concurrent write dropped it (plus-ones.ts).
  const stopPlusOnes = watchPlusOneIntents(editor, ctx.me.user.id, plusOneIntentsFor(editor))

  // Private brainstorming: a notice when a session ends; the revealing tab fits the placed notes.
  const stopPrivateNotes = mountPrivateNotes(ctx)

  // Exports draw a revealed vote's result badges, as this person sees them (vote-export.ts, R14).
  const stopVoteExport = provideVoteResultsForExport(editor, () => shownResults(store.getSnapshot()))

  return () => {
    stopVoteExport()
    stopPrivateNotes()
    stopPlusOnes()
    stopAuthors()
    root.removeAttribute(HIDE_AUTHORS_ATTR)
    offSummon()
    for (const t of timers) clearTimeout(t)
    editor.off('event', onEvent)
    editor.off('stop-following', onStopFollowing)
    stopReadableFollow()
  }
}

export const workshopsFeature: BoardFeature = {
  id: 'workshops',
  TopBarItem: WorkshopBar,
  Overlay: WorkshopOverlay,
  panels: [
    {
      id: 'voting',
      label: 'Voting',
      icon: <BallotIcon />,
      Component: VotingPanel,
    },
    privateNotesPanel,
  ],
  onMount: mountWorkshops,
}
