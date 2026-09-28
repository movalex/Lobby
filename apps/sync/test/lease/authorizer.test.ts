import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import { createShapeId, type TLRecord, type TLShape } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { createTextLease, type TextLeaseDenied } from '../../src/lease.ts'
import type { SessionMeta } from '../../src/rooms.ts'
import { note } from './fixtures.ts'

// Typed against the real 5.4.2 option: a signature change upstream fails this file's typecheck.
type ShapeAuthorizer = NonNullable<TLRecordAuthorizers<TLRecord, SessionMeta>['shape']>
type Args = Parameters<ShapeAuthorizer>[0]

const session = (userId: string, n = 1, isReadonly = false): Args['session'] => ({
  sessionId: `${userId}:tab${n}`,
  isReadonly,
  meta: { userId, role: isReadonly ? 'viewer' : 'editor', name: userId, color: '#1d4ed8' },
})
const update = (s: Args['session'], prev: TLShape, next: TLShape): Args => ({
  session: s,
  type: 'update',
  prev,
  next,
})
const del = (s: Args['session'], prev: TLShape): Args => ({ session: s, type: 'delete', prev, next: null })
const create = (s: Args['session'], next: TLShape): Args => ({ session: s, type: 'create', prev: null, next })

function setup(leaseMs = 5_000) {
  let clock = 1_000_000
  const denied: Array<{ sessionId: string; message: TextLeaseDenied }> = []
  const lease = createTextLease({
    leaseMs,
    now: () => clock,
    onDenied: (sessionId, message) => denied.push({ sessionId, message }),
  })
  const authorize = lease.authorizeRecord.shape as ShapeAuthorizer
  return {
    lease,
    authorize,
    denied,
    advance: (ms: number) => {
      clock += ms
    },
    // onDenied is deferred out of the transaction by a microtask
    flush: () => new Promise<void>((r) => queueMicrotask(r)),
  }
}

const alice = session('alice')
const aliceTab2 = session('alice', 2)
const bob = session('bob')
const v0 = note('hello')
const vA = note('hello alice')
const vB = note('hello bob')

describe('text lease authorizer', () => {
  it('allows creates (even with text) without taking a lease', () => {
    const { authorize, lease } = setup()
    expect(authorize(create(bob, vB))).toBe(vB)
    expect(lease.holderOf(vB.id)).toBeNull()
    expect(authorize(update(alice, vB, vA))).toBe(vA) // bob's create did not lock the text
  })

  it('the first text change takes the lease; another user is vetoed and told who holds it', async () => {
    const { authorize, lease, denied, flush, advance } = setup(5_000)
    expect(authorize(update(alice, v0, vA))).toBe(vA)
    expect(lease.holderOf(v0.id)).toMatchObject({ userId: 'alice' })
    advance(1_500)
    expect(authorize(update(bob, vA, vB))).toBeNull()
    expect(denied).toEqual([]) // never sent from inside the transaction
    await flush()
    expect(denied).toEqual([
      {
        sessionId: 'bob:tab1',
        message: { type: 'text-lease-denied', shapeId: v0.id, holderUserId: 'alice', expiresInMs: 3_500 },
      },
    ])
  })

  it('renews on every text change by the holder, from any of their tabs', async () => {
    const { authorize, advance } = setup(5_000)
    expect(authorize(update(alice, v0, vA))).toBe(vA)
    advance(4_000)
    const vA2 = note('hello alice!')
    expect(authorize(update(aliceTab2, vA, vA2))).toBe(vA2) // same user, other tab: shares the lease
    advance(4_000) // 8 s after the first edit, 4 s after the renewal: still held
    expect(authorize(update(bob, vA2, vB))).toBeNull()
  })

  it('expires: after leaseMs without a text change another user may edit and takes over', () => {
    const { authorize, lease, advance } = setup(5_000)
    authorize(update(alice, v0, vA))
    advance(4_999)
    expect(authorize(update(bob, vA, vB))).toBeNull()
    advance(1) // exactly leaseMs after alice's last change
    expect(authorize(update(bob, vA, vB))).toBe(vB)
    expect(lease.holderOf(v0.id)).toMatchObject({ userId: 'bob' })
    expect(authorize(update(alice, vB, vA))).toBeNull()
  })

  it('moves, resizes and style changes that leave richText untouched pass while held', () => {
    const { authorize } = setup()
    authorize(update(alice, v0, vA))
    const moved = note('hello alice', { x: 400, y: -20, rotation: 1 })
    expect(authorize(update(bob, vA, moved))).toBe(moved)
    const restyled = note('hello alice')
    restyled.props = { ...restyled.props, color: 'red', growY: 40 } as TLShape['props']
    expect(authorize(update(bob, moved, restyled))).toBe(restyled)
    // a structurally equal but freshly built richText object is not a text change
    expect(authorize(update(bob, vA, note('hello alice', { x: 9 })))).not.toBeNull()
  })

  it('a move combined with a text change is vetoed as a whole (record-level veto)', () => {
    const { authorize } = setup()
    authorize(update(alice, v0, vA))
    expect(authorize(update(bob, vA, note('hello bob', { x: 42 })))).toBeNull()
  })

  it('vetoes a delete by another user while held, and tells that session', async () => {
    const { authorize, denied, flush } = setup()
    authorize(update(alice, v0, vA))
    expect(authorize(del(bob, vA))).toBeNull()
    await flush()
    expect(denied.map((d) => [d.sessionId, d.message.type, d.message.holderUserId])).toEqual([
      ['bob:tab1', 'text-lease-denied', 'alice'],
    ])
  })

  it('a delete by the holder is allowed and drops the lease (a same-id re-create is free)', () => {
    const { authorize, lease } = setup()
    authorize(update(alice, v0, vA))
    expect(authorize(del(alice, vA))).toBe(vA)
    expect(lease.holderOf(v0.id)).toBeNull()
    // undo of the delete re-creates the same id; nobody holds its text now
    expect(authorize(create(alice, vA))).toBe(vA)
    expect(authorize(update(bob, vA, vB))).toBe(vB)
  })

  it('an unheld or expired lease never blocks a delete, and the delete clears it', () => {
    const { authorize, lease, advance } = setup(1_000)
    expect(authorize(del(bob, v0))).toBe(v0)
    authorize(update(alice, v0, vA))
    advance(1_000)
    expect(authorize(del(bob, vA))).toBe(vA)
    expect(lease.holderOf(v0.id)).toBeNull()
  })

  it('releaseUser frees only that user’s leases', () => {
    const { authorize, lease } = setup()
    const other = note('x', { id: createShapeId('n2') })
    const otherB = note('x by bob', { id: createShapeId('n2') })
    authorize(update(alice, v0, vA))
    authorize(update(bob, other, otherB))
    lease.releaseUser('alice')
    expect(lease.holderOf(v0.id)).toBeNull()
    expect(lease.holderOf(other.id)).toMatchObject({ userId: 'bob' })
    expect(authorize(update(bob, vA, vB))).toBe(vB)
  })

  it('shapes without richText never lease; read-only sessions are refused', () => {
    const { authorize, lease } = setup()
    const card = { ...v0, type: 'dr-file-card', props: { w: 1, h: 1 } } as unknown as TLShape
    const cardMoved = { ...card, x: 5 } as TLShape
    expect(authorize(update(alice, card, cardMoved))).toBe(cardMoved)
    expect(lease.holderOf(card.id)).toBeNull()
    expect(authorize(update(session('carol', 1, true), v0, vA))).toBeNull()
  })

  it('leases are per shape: holding one note does not block another', () => {
    const { authorize } = setup()
    const n2 = note('two', { id: createShapeId('n2') })
    const n2b = note('two by bob', { id: createShapeId('n2') })
    authorize(update(alice, v0, vA))
    expect(authorize(update(bob, n2, n2b))).toBe(n2b)
  })

  it('separate lease instances (rooms) do not share state', () => {
    const a = setup()
    const b = setup()
    a.authorize(update(alice, v0, vA))
    expect(b.authorize(update(bob, vA, vB))).toBe(vB)
  })
})
