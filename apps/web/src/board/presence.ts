import {
  createUserId,
  getDefaultUserPresence,
  InstancePageStateRecordType,
  TLINSTANCE_ID,
  type TLInstancePresence,
  type TLPresenceStateInfo,
  type TLShapeId,
  type TLStore,
  type TLUser,
} from 'tldraw'

/** tldraw user ids are `user:<id>`; the server and the contract use the bare dev id. */
export const bareUserId = (id: string) => (id.startsWith('user:') ? id.slice('user:'.length) : id)

/** The shape this tab is text-editing, or null. Only rich-text shapes count (that is what the lease guards). */
export function textEditingShapeId(store: TLStore): TLShapeId | null {
  const instance = store.get(TLINSTANCE_ID)
  if (!instance) return null
  const pageState = store.get(InstancePageStateRecordType.createId(instance.currentPageId))
  const id = pageState?.editingShapeId
  if (!id) return null
  const shape = store.get(id)
  return shape && 'richText' in shape.props ? id : null
}

/** Who this tab is, as everyone else should see it (the signed-in account, never local prefs). */
export interface PresenceIdentity {
  /** Draftroom user id (bare, `usr_…`). */
  id: string
  name: string
  color: string
}

/**
 * useSync's getUserPresence. Runs inside a reactive derivation, so reading the page state here makes
 * presence update when this tab starts/stops editing. `editingShapeId` is a UI hint only; the
 * server-side text lease is the enforcement (contract §4).
 *
 * `identity` stamps the account into presence. It is required for read-only roles: they get
 * `currentUser: null` (so the editor never writes a `user:` record the server would discard, which
 * tldraw 5.4.2 retries forever — docs/research/saved-indicator.md §7), and useSync then hands this
 * function a user built from local tldraw preferences instead.
 */
export function getDraftroomPresence(
  store: TLStore,
  user: TLUser,
  identity?: PresenceIdentity,
): TLPresenceStateInfo | null {
  const presence = getDefaultUserPresence(store, user)
  if (!presence) return null
  const who = identity
    ? { userId: createUserId(identity.id), userName: identity.name, color: identity.color }
    : null
  return { ...presence, ...who, meta: { editingShapeId: textEditingShapeId(store) } }
}

export interface PresenceUser {
  userId: string
  name: string
  color: string
  followId: TLInstancePresence['userId']
}

/** Other people on the board: one entry per user (a user with two tabs is one person), self excluded. */
export function presenceUsers(
  collaborators: readonly TLInstancePresence[],
  selfUserId: string,
): PresenceUser[] {
  const byUser = new Map<string, TLInstancePresence>()
  for (const c of collaborators) {
    const id = bareUserId(c.userId)
    if (id === selfUserId) continue
    const prev = byUser.get(id)
    if (!prev || (c.lastActivityTimestamp ?? 0) > (prev.lastActivityTimestamp ?? 0)) byUser.set(id, c)
  }
  return [...byUser.entries()]
    .map(([userId, c]) => ({ userId, name: c.userName || userId, color: c.color, followId: c.userId }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId))
}

export interface RemoteEditing {
  userId: string
  name: string
  color: string
  shapeId: TLShapeId
}

export function remoteEditing(
  collaborators: readonly TLInstancePresence[],
  selfUserId: string,
): RemoteEditing[] {
  const out: RemoteEditing[] = []
  const seen = new Set<string>()
  for (const c of collaborators) {
    const userId = bareUserId(c.userId)
    const shapeId = c.meta?.editingShapeId
    if (userId === selfUserId || typeof shapeId !== 'string' || !shapeId.startsWith('shape:')) continue
    const key = `${userId}/${shapeId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ userId, name: c.userName || userId, color: c.color, shapeId: shapeId as TLShapeId })
  }
  return out
}

export interface LeaseDenied {
  shapeId: string
  holderUserId: string | null
  expiresInMs: number | null
}

/** Validates the server's custom message (contract §4). Anything else is ignored. */
export function parseLeaseDenied(data: unknown): LeaseDenied | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type !== 'text-lease-denied' || typeof d.shapeId !== 'string') return null
  return {
    shapeId: d.shapeId,
    holderUserId: typeof d.holderUserId === 'string' ? d.holderUserId : null,
    expiresInMs: typeof d.expiresInMs === 'number' && Number.isFinite(d.expiresInMs) ? d.expiresInMs : null,
  }
}

/** Display name for the lease holder: presence name if they are here, else their id. */
export function holderName(
  collaborators: readonly TLInstancePresence[],
  holderUserId: string | null,
): string {
  if (!holderUserId) return 'Someone'
  const match = collaborators.find((c) => bareUserId(c.userId) === bareUserId(holderUserId))
  return match?.userName || bareUserId(holderUserId)
}
