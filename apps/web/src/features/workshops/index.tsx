// Feature module: workshops (docs/FEATURES-M2-CONTRACTS.md, "workshops"). Owned by the workshops
// engineer. Facilitation for live sessions (checklist FAC-01..06, PRF-07):
// - a shared timer (top bar; server end timestamps; chime + flash at zero, mutable per person);
// - anonymous dot voting (setup dialog, click-to-vote dots on the canvas, "I'm done", ranked results);
// - "Gather everyone": others follow the facilitator's view (tldraw follow API) until they move.

import { WORKSHOP_EVENTS, WorkshopSummonEvent } from '@draftroom/contracts'
import { react, type TLEventInfo } from 'tldraw'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { installAudioUnlock } from './chime.ts'
import { followIdFor, isCanvasPress, summonApplies } from './follow.ts'
import { storeFor } from './hooks.ts'
import { HIDE_AUTHORS_ATTR, readSessionSettings } from './session-settings.ts'
import { VotingPanel } from './VotingPanel.tsx'
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

function mountWorkshops(ctx: FeatureContext) {
  const { editor } = ctx
  const store = storeFor(ctx)
  installAudioUnlock()
  const timers = new Set<ReturnType<typeof setTimeout>>()

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
        if (editor.getInstanceState().followingUserId === followId) store.setSummonedBy({ userId, name })
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
  const onStopFollowing = () => store.setSummonedBy(null)
  editor.on('event', onEvent)
  editor.on('stop-following', onStopFollowing)

  // "Hide note authors" (a synced session setting): canvas and Present hide tldraw's note attribution
  // through this <html> attribute (workshops.css); exports strip it in present-export.
  const root = editor.getContainer().ownerDocument.documentElement
  const stopAuthors = react('dr-wk-hide-authors', () => {
    if (readSessionSettings(editor).hideNoteAuthors) root.setAttribute(HIDE_AUTHORS_ATTR, 'true')
    else root.removeAttribute(HIDE_AUTHORS_ATTR)
  })

  return () => {
    stopAuthors()
    root.removeAttribute(HIDE_AUTHORS_ATTR)
    offSummon()
    for (const t of timers) clearTimeout(t)
    editor.off('event', onEvent)
    editor.off('stop-following', onStopFollowing)
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
  ],
  onMount: mountWorkshops,
}
