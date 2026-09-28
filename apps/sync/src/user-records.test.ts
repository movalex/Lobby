import type { TLUser } from '@tldraw/tlschema'
import { describe, expect, it, vi } from 'vitest'
import { geoShape } from '../test/harness/records.ts'
import { InboundFrames, type PresenceIdentity, presenceIdentity } from './presence.ts'
import type { SessionMeta } from './rooms.ts'
import { authorizeUserRecord, userRecordOpsAllowed } from './user-records.ts'

const VIC: PresenceIdentity = presenceIdentity({ uid: 'usr_vic', name: 'Vic (guest)', color: '#047857' })

const user = (over: Partial<TLUser> = {}): TLUser =>
  ({
    id: 'user:usr_vic',
    typeName: 'user',
    name: 'Vic (guest)',
    color: '#047857',
    imageUrl: '',
    meta: {},
    ...over,
  }) as TLUser
const alice = (over: Partial<TLUser> = {}) =>
  user({ id: 'user:usr_alice' as TLUser['id'], name: 'Alice Adams', color: '#1d4ed8', ...over })

const allowed = (diff: unknown) => userRecordOpsAllowed(diff, VIC)

describe('userRecordOpsAllowed (the wire check, before the room)', () => {
  it("lets through the session's own record exactly as the ticket says, whatever its meta", () => {
    expect(allowed({ 'user:usr_vic': ['put', user()] })).toBe(true)
    expect(allowed({ 'user:usr_vic': ['put', user({ meta: { anything: [1, 2] } })] })).toBe(true)
    expect(allowed({ 'user:usr_vic': ['patch', { meta: ['put', { a: 1 }] }] })).toBe(true)
    // a no-op put of the pinned values is what diffRecord never sends, but it is harmless
    expect(
      allowed({ 'user:usr_vic': ['patch', { name: ['put', 'Vic (guest)'], color: ['put', '#047857'] }] }),
    ).toBe(true)
    expect(allowed({ 'user:usr_vic': ['patch', { imageUrl: ['put', ''] }] })).toBe(true)
    expect(allowed({ 'user:usr_vic': ['remove'] })).toBe(true)
  })

  it("refuses the session's own record with any other name, color or image", () => {
    for (const over of [
      { name: 'Alice Adams' },
      { name: 'Vic' },
      { color: '#ff00ff' },
      { imageUrl: 'https://example.com/a.png' },
    ])
      expect(allowed({ 'user:usr_vic': ['put', user(over)] }), JSON.stringify(over)).toBe(false)
    for (const field of [
      { name: ['put', 'Alice Adams'] },
      { name: ['append', ' Adams', 11] },
      { name: ['patch', {}] },
      { color: ['put', '#ff00ff'] },
      { imageUrl: ['put', 'https://example.com/a.png'] },
      { id: ['put', 'user:usr_alice'] },
      { id: ['put', 'user:usr_vic'] },
      { typeName: ['put', 'shape'] },
    ])
      expect(allowed({ 'user:usr_vic': ['patch', field] }), JSON.stringify(field)).toBe(false)
  })

  it('refuses a user record sent under any key but its own id, and anything else sent under a user id', () => {
    expect(allowed({ 'user:usr_alice': ['put', user()] })).toBe(false)
    expect(allowed({ 'user:usr_vic': ['put', alice()] })).toBe(false)
    expect(allowed({ 'shape:x': ['put', user()] })).toBe(false)
    expect(allowed({ 'user:usr_carol': ['put', geoShape('x')] })).toBe(false)
    expect(allowed({ 'user:usr_carol': ['put', null] })).toBe(false)
    // an array diff is read by index by the room: key "0"
    expect(allowed([['put', user()]])).toBe(false)
  })

  it("leaves other people's records to the room's authorizer (a paste carries them; they are skipped there)", () => {
    expect(allowed({ 'user:usr_alice': ['put', alice()] })).toBe(true)
    expect(allowed({ 'user:usr_alice': ['put', alice({ name: 'Chase Boyajian' })] })).toBe(true)
    expect(allowed({ 'user:usr_alice': ['patch', { name: ['put', 'Chase Boyajian'] }] })).toBe(true)
    expect(allowed({ 'user:usr_alice': ['remove'] })).toBe(true)
  })

  it('ignores everything that is not a user record, and diffs the room would not read', () => {
    const shape = geoShape('a', { text: 'the user: record of a user' })
    expect(
      allowed({ [shape.id]: ['put', shape], 'shape:b': ['remove'], 'shape:c': ['patch', { x: ['put', 1] }] }),
    ).toBe(true)
    for (const diff of [
      undefined,
      null,
      'user:usr_alice',
      42,
      { 'user:usr_alice': 'put' },
      { 'user:usr_vic': [] },
    ])
      expect(allowed(diff), JSON.stringify(diff)).toBe(true)
  })
})

describe('InboundFrames with user records', () => {
  const frames = () => new InboundFrames(VIC, () => 1_800_000_000_000)
  const push = (diff: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'push', clientClock: 1, diff, ...extra })

  it('refuses a push that forges the own record, even next to honest ops, escaped or chunked', () => {
    const f = frames()
    const shape = geoShape('a')
    expect(
      f.accept(push({ 'user:usr_vic': ['put', user({ name: 'Alice Adams' })], [shape.id]: ['put', shape] })),
    ).toEqual({ kind: 'forged-user' })
    const escaped = push({ 'user:usr_vic': ['put', user({ name: 'Alice Adams' })] }).replaceAll(
      'user',
      '\\u0075ser',
    )
    expect(escaped).not.toContain('user')
    expect(f.accept(escaped)).toEqual({ kind: 'forged-user' })
    const text = push({ 'user:usr_alice': ['put', user()] })
    const n = Math.ceil(text.length / 40)
    const parts = Array.from({ length: n }, (_, i) => `${n - 1 - i}_${text.slice(i * 40, (i + 1) * 40)}`)
    for (const p of parts.slice(0, -1)) expect(f.accept(p)).toEqual({ kind: 'partial' })
    expect(f.accept(parts.at(-1) as string)).toEqual({ kind: 'forged-user' })
  })

  it('hands honest pushes to the room verbatim; a push that cannot hold a user record is not parsed', () => {
    const f = frames()
    const own = push({ 'user:usr_vic': ['put', user()] })
    expect(f.accept(own)).toEqual({ kind: 'deliver', text: own })
    const theirs = push({ 'user:usr_alice': ['remove'] })
    expect(f.accept(theirs)).toEqual({ kind: 'deliver', text: theirs })
    const parse = vi.spyOn(JSON, 'parse')
    const shape = geoShape('b', { text: 'hello' })
    const doc = push({ [shape.id]: ['put', shape] })
    expect(f.accept(doc)).toEqual({ kind: 'deliver', text: doc })
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('checks the document diff of a push that also carries presence', () => {
    const f = frames()
    const presence = ['patch', { cursor: ['put', { x: 1, y: 2, type: 'default', rotation: 0 }] }]
    expect(f.accept(push({ 'user:usr_vic': ['put', user({ color: '#000000' })] }, { presence }))).toEqual({
      kind: 'forged-user',
    })
    const ok = push({ 'user:usr_vic': ['put', user()] }, { presence })
    expect(f.accept(ok)).toEqual({ kind: 'deliver', text: ok })
  })
})

type UserArgs = Parameters<typeof authorizeUserRecord>[0]
const session = (isReadonly = false): UserArgs['session'] => ({
  sessionId: 'usr_vic:tab',
  isReadonly,
  meta: {
    userId: 'usr_vic',
    role: isReadonly ? 'viewer' : 'editor',
    name: 'Vic (guest)',
    color: '#047857',
  } satisfies SessionMeta,
})
const create = (next: TLUser, readonly = false) =>
  authorizeUserRecord({ session: session(readonly), type: 'create', prev: null, next })
const update = (prev: TLUser, next: TLUser) =>
  authorizeUserRecord({ session: session(), type: 'update', prev, next })
const remove = (prev: TLUser) => authorizeUserRecord({ session: session(), type: 'delete', prev, next: null })

describe('authorizeUserRecord (in the room: skips, never closes)', () => {
  it("allows the session's own record with the ticket's name and color, and its removal", () => {
    expect(create(user())).toEqual(user())
    expect(update(user({ name: 'Old name' }), user({ meta: { a: 1 } }))).toEqual(user({ meta: { a: 1 } }))
    expect(remove(user())).toEqual(user())
  })

  it("skips someone else's record: create, update or delete", () => {
    expect(create(alice())).toBeNull()
    expect(update(alice(), alice({ name: 'Chase Boyajian' }))).toBeNull()
    expect(remove(alice())).toBeNull()
    // alice's record that the client relabels as its own, and the reverse
    expect(update(alice(), user())).toBeNull()
    expect(update(user(), alice())).toBeNull()
  })

  it("skips the session's own record with anything but the ticket's name, color and no image", () => {
    for (const over of [
      { name: 'Alice Adams' },
      { color: '#ff00ff' },
      { imageUrl: 'https://example.com/a.png' },
    ]) {
      expect(create(user(over)), JSON.stringify(over)).toBeNull()
      expect(update(user(), user(over)), JSON.stringify(over)).toBeNull()
    }
  })

  it('fails closed for read-only sessions (the room skips their writes before any authorizer)', () => {
    expect(create(user(), true)).toBeNull()
  })
})
