// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'sharing' feature on the Excalidraw board page:
// the board header badge (PRS-03: Private / Workspace: view|edit / Link: comment · until <date>, plus a
// count of pending access requests for owners; a click opens the Share dialog through the
// `draftroom:open-share` window event the board page listens for) and the export-policy sync
// (export-control: ./export-policy.ts is current for everything that shows export, copy and download
// entries). Same behaviour and copy as the tldraw page's ../index.tsx.
import type { ShareState } from '@draftroom/contracts'
import { useEffect, useState } from 'react'
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import { openStateOrRoute } from '../../../lib/open-state.ts'
import { useValue } from '../../../lib/signals.ts'
import { announceRemoteShareChange, openShareDialog, SHARE_CHANGED_EVENT, sharingApi } from '../api.ts'
import { shareBadge, shareBadgeName, showsShareBadge } from '../model.ts'
import { exportAllowedOn, exportStateOf, syncExportPolicy } from './export-policy.ts'
import '../sharing.css'

const REFRESH_MS = 30_000

/**
 * R2-11 / F14: the badge describes the board's links ("Link: edit · until 8:39 AM"): how other people
 * got in, not what this person can do. A viewer, a commenter or a name-only guest reads it as their own
 * access, so they do not get it (their role pill says what they can do).
 */
function ShareBadgeItem({ ctx }: { ctx: CanvasFeatureContext }) {
  const kind = useUserKind()
  if (!showsShareBadge(ctx.role, kind === 'guest')) return null
  return <ShareBadge ctx={ctx} />
}

function ShareBadge({ ctx }: { ctx: CanvasFeatureContext }) {
  const { board, workspace, events } = ctx
  const [state, setState] = useState<ShareState | null>(null)
  const [tick, setTick] = useState(0)
  const api = ctx.api

  // Refetch on: the board changing (visibility), a sharing event on the board stream, a change made
  // in this tab's Share dialog, and every stream (re)connect.
  useEffect(() => {
    void tick
    void board.visibility
    const controller = new AbortController()
    // wave M (M5-1): the first fetch takes the board-open read's part, once (lib/open-state.ts); later ones read the route
    openStateOrRoute(
      board.id,
      'sharing',
      () => sharingApi(api).shareState(board.id, controller.signal),
      controller.signal,
    )
      .then(setState)
      .catch(() => {}) // keep the last known state; the Share button still works
    return () => controller.abort()
  }, [api, board.id, board.visibility, tick])

  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const offEvent = events.on('sharing.changed', () => {
      bump()
      announceRemoteShareChange(board.id) // an open Share dialog refetches too
    })
    const offResync = events.onResync(bump)
    const onWindow = (e: Event) => {
      const detail = (e as CustomEvent<{ boardId?: string }>).detail
      if (!detail?.boardId || detail.boardId === board.id) bump()
    }
    window.addEventListener(SHARE_CHANGED_EVENT, onWindow)
    // Events are hints: a slow refresh while the tab is visible covers a missed or dead stream
    // (and access requests from people who are not on the board).
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') bump()
    }, REFRESH_MS)
    return () => {
      offEvent()
      offResync()
      window.removeEventListener(SHARE_CHANGED_EVENT, onWindow)
      clearInterval(poll)
    }
  }, [events, board.id])

  const badge = state
    ? shareBadge(state, workspace.name)
    : shareBadge(
        { visibility: board.visibility, links: [], directCount: 0, pendingRequests: null },
        workspace.name,
      )
  const requests = badge.requests
  const label = shareBadgeName(badge)

  return (
    <button
      type="button"
      className="dr-sharebadge"
      data-testid="share-badge"
      data-kind={badge.kind}
      data-requests={requests}
      aria-label={label}
      title={label}
      onClick={openShareDialog}
    >
      <BadgeIcon kind={badge.kind} />
      <span className="dr-sharebadge__text">{badge.label}</span>
      {requests > 0 && (
        <span className="dr-sharebadge__dot" aria-hidden="true">
          {requests > 9 ? '9+' : requests}
        </span>
      )}
    </button>
  )
}

function BadgeIcon({ kind }: { kind: 'private' | 'workspace' | 'link' }) {
  const d =
    kind === 'private'
      ? 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z'
      : kind === 'workspace'
        ? 'M3 21V8l9-5 9 5v13M9 21v-6h6v6'
        : 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Set on the board's canvas region while exporting is off for this person (F2-04: file cards' CSS). */
export const EXPORT_OFF_ATTR = 'data-dr-export-off'

/**
 * Mounted for the whole board session (an overlay layer that stays in focus mode, drawing nothing):
 * keeps the export policy store current with the policy, the role (which changes live, without
 * remounting features) and whether this person is a name-only guest (limited under 'editors' whatever
 * their role).
 */
function ExportPolicySync({ ctx }: { ctx: CanvasFeatureContext }) {
  const { board, api, events, role, canvas } = ctx
  const kind = useUserKind()
  useEffect(() => syncExportPolicy({ boardId: board.id, api, events }), [board.id, api, events])
  useEffect(() => {
    exportStateOf(board.id).role.set(role)
  }, [board.id, role])
  useEffect(() => {
    exportStateOf(board.id).guest.set(kind === null ? null : kind === 'guest')
  }, [board.id, kind])
  const exportOff = useValue('lobby-export-off-attr', () => !exportAllowedOn(board.id), [board.id])
  useEffect(() => {
    const container = canvas.container()
    if (!exportOff || !container) return
    container.setAttribute(EXPORT_OFF_ATTR, 'true')
    return () => container.removeAttribute(EXPORT_OFF_ATTR)
  }, [canvas, exportOff])
  return null
}

export const feature: CanvasFeature = {
  id: 'sharing',
  topBar: [{ id: 'sharing', order: 50, overflowCaption: 'Sharing', component: ShareBadgeItem }],
  overlays: [
    {
      id: 'sharing.export-policy',
      layer: 'screen',
      order: 0,
      focusMode: 'show',
      component: ExportPolicySync,
    },
  ],
}
