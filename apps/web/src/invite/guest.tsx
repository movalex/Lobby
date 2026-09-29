// Name-only guests on the web (docs/WAVE3-CONTRACTS.md §2 guests): who is signed in (an account or a
// guest, from GET /api/me's `kind`), joining a guest link, and remembering (for this tab) that the
// person was a guest, so a session that ended shows "your guest access has ended" instead of a
// sign-in form they have no account for.

import {
  BoardGuests,
  GuestJoined,
  InvitationBoardState,
  InvitationEmailLock,
  InvitationGuestAccess,
  InvitationPreview,
  MeKind,
  type UserKind,
} from '@draftroom/contracts'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { z } from 'zod'
import { api } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'

const enc = encodeURIComponent

/** GET /api/invitations/:token, with this feature's `allowGuests`. */
export const GuestAwarePreview = InvitationPreview.extend(InvitationGuestAccess.shape)
  .extend(InvitationEmailLock.shape)
  .extend(InvitationBoardState.shape)
export type GuestAwarePreview = z.infer<typeof GuestAwarePreview>

export const fetchInvitation = (token: string, signal?: AbortSignal) =>
  api.request('GET', `/api/invitations/${enc(token)}`, { schema: GuestAwarePreview, signal })

/** GET /api/boards/:bid/guests: the ids of the name-only guests on a board. */
export const fetchBoardGuests = async (boardId: string, signal?: AbortSignal) =>
  new Set(
    (await api.request('GET', `/api/boards/${enc(boardId)}/guests`, { schema: BoardGuests, signal })).userIds,
  )

/** POST /api/invitations/:token/guest. A signed-in guest sends no name (they keep theirs). */
export const joinAsGuest = (token: string, name?: string) =>
  api.request('POST', `/api/invitations/${enc(token)}/guest`, {
    body: name === undefined ? {} : { name },
    schema: GuestJoined,
  })

// ---- who is signed in ----------------------------------------------------------------------------

/** Kinds already learned, by user id (a join seeds it, so the board opens knowing). */
const known = new Map<string, UserKind>()
const KindContext = createContext<UserKind | null>(null)

/** Tells the app that `userId` is a guest before /api/me says so (right after joining). */
export function seedUserKind(userId: string, kind: UserKind) {
  known.set(userId, kind)
}

/** How often a guest's page checks that the session still lives (it ends with the last board grant). */
const GUEST_SESSION_CHECK_MS = 10_000

/**
 * Provides the signed-in person's kind (null until known, and when signed out). For a guest it also
 * checks the session now and then: once it ends (the link was revoked or expired, they were removed),
 * the 401 signs this tab out and App shows the "guest access has ended" screen.
 */
export function GuestKindProvider({ children }: { children: ReactNode }) {
  const { state } = useSession()
  const userId = state.status === 'signed-in' ? state.me.user.id : null
  const [kind, setKind] = useState<{ userId: string; kind: UserKind } | null>(null)

  useEffect(() => {
    if (!userId) return
    const seeded = known.get(userId)
    if (seeded) setKind({ userId, kind: seeded })
    const controller = new AbortController()
    api.request('GET', '/api/me', { schema: MeKind, signal: controller.signal }).then(
      (r) => {
        known.set(userId, r.kind)
        setKind({ userId, kind: r.kind })
      },
      () => {
        // A 401 signs the tab out through the client. Otherwise (a network blip) the page must not
        // wait forever: assume an account unless a join already said "guest". The server decides
        // every action anyway.
        if (controller.signal.aborted) return
        setKind({ userId, kind: known.get(userId) ?? 'account' })
      },
    )
    return () => controller.abort()
  }, [userId])

  const current = kind && kind.userId === userId ? kind.kind : null
  useEffect(() => {
    if (current === 'guest') rememberGuestTab()
    else if (current === 'account') forgetGuestTab()
  }, [current])

  useEffect(() => {
    if (current !== 'guest') return
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      api.request('GET', '/api/me', { schema: MeKind }).catch(() => {})
    }, GUEST_SESSION_CHECK_MS)
    return () => clearInterval(t)
  }, [current])

  return <KindContext.Provider value={current}>{children}</KindContext.Provider>
}

/** 'guest', 'account', or null while not known (or signed out). */
export const useUserKind = (): UserKind | null => useContext(KindContext)
export const useIsGuest = (): boolean => useUserKind() === 'guest'

/**
 * The kind of `userId` as far as this tab knows right now, for code that cannot use a hook (a dock
 * panel's `visible`): what a join or /api/me said, else 'guest' in a tab a guest signed in to.
 */
export const knownUserKind = (userId: string): UserKind | null =>
  known.get(userId) ?? (wasGuestTab() ? 'guest' : null)

// ---- this tab was a guest's ----------------------------------------------------------------------

const GUEST_TAB_KEY = 'draftroom:guest-tab'

function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function rememberGuestTab() {
  try {
    tabStorage()?.setItem(GUEST_TAB_KEY, '1')
  } catch {}
}

export function forgetGuestTab() {
  try {
    tabStorage()?.removeItem(GUEST_TAB_KEY)
  } catch {}
}

/** True when a guest was signed in in this tab (their session has ended if nobody is signed in now). */
export function wasGuestTab(): boolean {
  try {
    return tabStorage()?.getItem(GUEST_TAB_KEY) === '1'
  } catch {
    return false
  }
}
