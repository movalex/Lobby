// EventHub stream caps (docs/SECURITY-REVIEW-2026-09-27.md authz-003) and the access-changed hook
// (authz-005), without sockets: the hub only keeps handles and decides who stays connected.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STREAM_LIMITS,
  type DeliveredEvent,
  EventHub,
  type StreamEndReason,
  type StreamInfo,
} from '../src/events/hub.ts'

interface Fake {
  userId: string
  sessionId: string
  got: DeliveredEvent[]
  ended: StreamEndReason | null
}

function fake(
  userId: string,
  sessionId = `ses-${userId}`,
): Fake & {
  deliver(e: DeliveredEvent): void
  end(r: StreamEndReason): void
} {
  const f: Fake = { userId, sessionId, got: [], ended: null }
  return Object.assign(f, {
    deliver: (e: DeliveredEvent) => void f.got.push(e),
    end: (r: StreamEndReason) => {
      f.ended = r
    },
  })
}

function open(hub: EventHub, boardId: string, userId: string, sessionId?: string) {
  const handle = fake(userId, sessionId)
  const result = hub.openStream(boardId, handle)
  return { handle, result }
}

describe('EventHub stream caps (authz-003)', () => {
  it('one user opening 2,000 streams on a board keeps only their newest 5, and the owner still gets in', () => {
    const hub = new EventHub()
    const attacker = Array.from({ length: 2_000 }, () => open(hub, 'b-board00001', 'usr_guest'))
    expect(attacker.every((a) => a.result.ok)).toBe(true)
    expect(hub.userStreamCount('usr_guest', 'b-board00001')).toBe(DEFAULT_STREAM_LIMITS.perUserPerBoard)
    // Their own oldest streams were replaced, newest first kept.
    const replaced = attacker.filter((a) => a.handle.ended === 'replaced').length
    expect(replaced).toBe(2_000 - DEFAULT_STREAM_LIMITS.perUserPerBoard)
    expect(attacker.slice(-5).every((a) => a.handle.ended === null)).toBe(true)

    const owner = open(hub, 'b-board00001', 'usr_owner')
    expect(owner.result.ok).toBe(true)
    hub.publish('b-board00001', { type: 'comments.thread', data: { id: 1 } })
    expect(owner.handle.got.map((e) => e.type)).toEqual(['comments.thread'])
    // Replaced streams no longer receive anything.
    expect(attacker[0]?.handle.got).toEqual([])
  })

  it('caps one user across boards: past perUser streams, that user’s oldest stream anywhere is replaced', () => {
    const hub = new EventHub({ limits: { perUser: 3 } })
    const a = open(hub, 'b-board00001', 'usr_guest')
    open(hub, 'b-board00002', 'usr_guest')
    open(hub, 'b-board00003', 'usr_guest')
    const other = open(hub, 'b-board00001', 'usr_other')
    const d = open(hub, 'b-board00004', 'usr_guest')
    expect(d.result.ok).toBe(true)
    expect(a.handle.ended).toBe('replaced')
    expect(other.handle.ended).toBeNull()
    expect(hub.userStreamCount('usr_guest')).toBe(3)
  })

  it('a full board refuses a newcomer but never pushes out other people; a person already on it replaces their own', () => {
    const hub = new EventHub({ limits: { perBoard: 3 } })
    const people = ['usr_a', 'usr_b', 'usr_c'].map((u) => open(hub, 'b-board00001', u))
    const newcomer = open(hub, 'b-board00001', 'usr_d')
    expect(newcomer.result).toEqual({ ok: false, code: 'TOO_MANY_SUBSCRIBERS' })
    expect(people.every((p) => p.handle.ended === null)).toBe(true)
    // usr_b reconnects (a new tab, or a stream the proxy kept half-open): its own old stream goes.
    const again = open(hub, 'b-board00001', 'usr_b')
    expect(again.result.ok).toBe(true)
    expect(people[1]?.handle.ended).toBe('replaced')
    expect(people[0]?.handle.ended).toBeNull()
    expect(people[2]?.handle.ended).toBeNull()
  })

  it('has a process-wide cap with the same rule', () => {
    const hub = new EventHub({ limits: { total: 2 } })
    const a = open(hub, 'b-board00001', 'usr_a')
    const b = open(hub, 'b-board00002', 'usr_b')
    expect(open(hub, 'b-board00003', 'usr_c').result.ok).toBe(false)
    expect(open(hub, 'b-board00003', 'usr_a').result.ok).toBe(true)
    expect(a.handle.ended).toBe('replaced')
    expect(b.handle.ended).toBeNull()
    expect(hub.streamCount()).toBe(2)
  })

  it('a closed stream frees its slot and stops receiving; a throwing stream never affects the others', () => {
    const hub = new EventHub({ limits: { perUserPerBoard: 1 } })
    const a = open(hub, 'b-board00001', 'usr_a')
    if (!a.result.ok) throw new Error('refused')
    a.result.close()
    expect(hub.subscriberCount('b-board00001')).toBe(0)
    const broken = hub.openStream('b-board00001', {
      ...fake('usr_b'),
      deliver: () => {
        throw new Error('socket gone')
      },
    })
    expect(broken.ok).toBe(true)
    const c = open(hub, 'b-board00001', 'usr_c')
    hub.publish('b-board00001', { type: 't', data: null })
    expect(c.handle.got).toHaveLength(1)
    expect(a.handle.got).toHaveLength(0)
  })
})

describe('EventHub access changes and session ends (authz-005)', () => {
  it('accessChanged hands the affected streams (one user, or the whole board) to the revalidator', async () => {
    const hub = new EventHub()
    const seen: StreamInfo[][] = []
    hub.setRevalidator(async (streams) => {
      seen.push([...streams])
    })
    const a = open(hub, 'b-board00001', 'usr_a')
    const b = open(hub, 'b-board00001', 'usr_b')
    open(hub, 'b-board00002', 'usr_a')
    const before = hub.accessGeneration
    hub.accessChanged({ boardId: 'b-board00001', userId: 'usr_a' })
    hub.accessChanged({ boardId: 'b-board00001' })
    hub.accessChanged({ boardId: 'b-board00009' }) // nobody there: nothing to re-check
    expect(hub.accessGeneration).toBe(before + 3)
    expect(seen.map((s) => s.map((x) => x.userId).sort())).toEqual([['usr_a'], ['usr_a', 'usr_b']])
    if (!a.result.ok || !b.result.ok) throw new Error('refused')
    expect(seen[0]?.[0]).toBe(a.result.stream)
  })

  it('holds the affected streams’ events while the re-check runs: dropped for a revoked person, delivered in order otherwise', async () => {
    const hub = new EventHub()
    let finish: () => void = () => {}
    hub.setRevalidator(
      (streams) =>
        new Promise<void>((resolve) => {
          finish = () => {
            for (const s of streams) if (s.userId === 'usr_revoked') hub.end(s, 'access-lost')
            resolve()
          }
        }),
    )
    const revoked = open(hub, 'b-board00001', 'usr_revoked')
    const kept = open(hub, 'b-board00001', 'usr_kept')
    const elsewhere = open(hub, 'b-board00002', 'usr_revoked')
    hub.accessChanged({ boardId: 'b-board00001' })
    // Published after the change committed, before the re-check answered.
    hub.publish('b-board00001', { type: 'comments.thread', data: { secret: true } })
    hub.publish('b-board00001', { type: 'sharing.changed', data: null })
    hub.publish('b-board00002', { type: 'other.board', data: null })
    expect(revoked.handle.got).toEqual([])
    expect(kept.handle.got).toEqual([])
    expect(elsewhere.handle.got.map((e) => e.type)).toEqual(['other.board'])
    finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(revoked.handle.ended).toBe('access-lost')
    expect(revoked.handle.got).toEqual([])
    expect(kept.handle.got.map((e) => e.type)).toEqual(['comments.thread', 'sharing.changed'])
    hub.publish('b-board00001', { type: 'after', data: null })
    expect(kept.handle.got.map((e) => e.type)).toEqual(['comments.thread', 'sharing.changed', 'after'])
  })

  it('a failing re-check releases the held events (the periodic check decides later)', async () => {
    const hub = new EventHub()
    hub.setRevalidator(async () => {
      throw new Error('database unavailable')
    })
    const a = open(hub, 'b-board00001', 'usr_a')
    const done = hub.revalidate(a.result.ok ? [a.result.stream] : [])
    hub.publish('b-board00001', { type: 'x', data: null })
    expect(a.handle.got).toEqual([])
    await done
    expect(a.handle.got.map((e) => e.type)).toEqual(['x'])
    expect(a.handle.ended).toBeNull()
  })

  it('end() and endSessions() end exactly those streams, with the reason', () => {
    const hub = new EventHub()
    const a1 = open(hub, 'b-board00001', 'usr_a', 'ses-1')
    const a2 = open(hub, 'b-board00002', 'usr_a', 'ses-1')
    const a3 = open(hub, 'b-board00001', 'usr_a', 'ses-2')
    const b = open(hub, 'b-board00001', 'usr_b', 'ses-3')
    expect(hub.endSessions(['ses-1'])).toBe(2)
    expect([a1, a2, a3, b].map((x) => x.handle.ended)).toEqual(['session-ended', 'session-ended', null, null])
    if (!a3.result.ok) throw new Error('refused')
    hub.end(a3.result.stream, 'access-lost')
    hub.end(a3.result.stream, 'session-ended') // already gone: no second end
    expect(a3.handle.ended).toBe('access-lost')
    expect(hub.streamCount()).toBe(1)
  })
})
