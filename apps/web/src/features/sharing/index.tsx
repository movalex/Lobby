// Feature module: sharing (docs/FEATURES-M2-CONTRACTS.md, dashboard-share). The board header badge
// (PRS-03): Private / Workspace: view|edit / Link: comment · until <date>, plus a count of pending
// access requests for owners. Clicking it opens the Share dialog (BoardPage listens for
// `draftroom:open-share`).

import type { ShareState } from '@draftroom/contracts'
import { useEffect, useState } from 'react'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { openShareDialog, SHARE_CHANGED_EVENT, sharingApi } from './api.ts'
import { shareBadge } from './model.ts'
import './sharing.css'

const REFRESH_MS = 30_000

function ShareBadge({ ctx }: { ctx: FeatureContext }) {
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
    sharingApi(api)
      .shareState(board.id, controller.signal)
      .then(setState)
      .catch(() => {}) // keep the last known state; the Share button still works
    return () => controller.abort()
  }, [api, board.id, board.visibility, tick])

  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const offEvent = events.on('sharing.changed', bump)
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
  const label = `${badge.description}${requests ? ` ${requests} pending access ${requests === 1 ? 'request' : 'requests'}.` : ''} Open sharing settings.`

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

export const sharingFeature: BoardFeature = { id: 'sharing', TopBarItem: ShareBadge }
