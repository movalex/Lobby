import type { TLRecordAuthorizers } from '@tldraw/sync-core'
import { type TLRecord, type TLShape, toRichText } from '@tldraw/tlschema'
import { describe, expect, it, vi } from 'vitest'
import { geoShape, noteShape } from '../test/harness/records.ts'
import {
  AttributionLedger,
  attributionOf,
  createVerdict,
  isEmptyText,
  sameAsDeleted,
  updateVerdict,
  withNoteAttribution,
} from './attribution.ts'
import type { SessionMeta } from './rooms.ts'

const ALICE = 'usr_alice'
const VIC = 'usr_vic'

const note = (text: string, by: string | null, id = 'n1'): TLShape => {
  const n = noteShape(id, text)
  return { ...n, props: { ...n.props, textLastEditedBy: by } } as unknown as TLShape
}
const never = () => false
const always = () => true

describe('attributionOf / isEmptyText', () => {
  it('reads the note prop; other shapes have none', () => {
    expect(attributionOf(note('x', ALICE))).toBe(ALICE)
    expect(attributionOf(note('x', null))).toBeNull()
    expect(attributionOf(geoShape('g') as unknown as TLShape)).toBeUndefined()
  })

  it('matches tldraw 5.4.2 isEmptyRichText', () => {
    expect(isEmptyText(note('', null))).toBe(true)
    expect(isEmptyText(note('x', null))).toBe(false)
    const withDoc = (richText: unknown) => ({
      ...note('', null),
      props: { ...note('', null).props, richText },
    })
    expect(isEmptyText(withDoc({ type: 'doc', content: [] }) as TLShape)).toBe(true)
    expect(
      isEmptyText(withDoc({ type: 'doc', content: [{ type: 'paragraph', content: [] }] }) as TLShape),
    ).toBe(true)
    expect(
      isEmptyText(
        withDoc({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] }) as TLShape,
      ),
    ).toBe(false)
  })
})

describe('updateVerdict', () => {
  const prev = note('Keep the Q3 launch', ALICE)

  it('lets through everything that leaves text and attribution alone', () => {
    expect(updateVerdict(prev, { ...prev, x: 50 } as TLShape, VIC, never)).toBe('unchanged')
    expect(
      updateVerdict(
        geoShape('g') as unknown as TLShape,
        geoShape('g', { x: 9 }) as unknown as TLShape,
        VIC,
        never,
      ),
    ).toBe('unchanged')
  })

  it('a text change stamped with the writer is an own edit; stamped with anyone else it needs a vouch', () => {
    expect(updateVerdict(prev, note('Cancel it', VIC), VIC, never)).toBe('own-edit')
    expect(updateVerdict(prev, note('Cancel it', ALICE), VIC, never)).toBe('forged')
    expect(updateVerdict(prev, note('Cancel it', ALICE), VIC, always)).toBe('vouched')
    expect(updateVerdict(prev, note('Cancel it', null), VIC, never)).toBe('forged')
  })

  it('an attribution change without a text change needs a vouch, even to the writer itself', () => {
    expect(updateVerdict(prev, note('Keep the Q3 launch', VIC), VIC, never)).toBe('forged')
    expect(updateVerdict(prev, note('Keep the Q3 launch', null), VIC, never)).toBe('forged')
    expect(updateVerdict(prev, note('Keep the Q3 launch', 'usr_carol'), VIC, never)).toBe('forged')
    expect(updateVerdict(prev, note('Keep the Q3 launch', VIC), VIC, always)).toBe('vouched')
  })

  it('clearing a note (empty text, no attribution) is allowed', () => {
    expect(updateVerdict(prev, note('', null), VIC, never)).toBe('cleared')
    expect(updateVerdict(note('', ALICE), note('', null), VIC, never)).toBe('cleared')
  })

  it('a shape that becomes a note arrives unattributed unless the writer edits its text', () => {
    const geo = { ...geoShape('n1', { text: 'hello' }) } as unknown as TLShape
    expect(updateVerdict(geo, note('hello', ALICE), VIC, never)).toBe('forged')
    expect(updateVerdict(geo, note('hello again', VIC), VIC, never)).toBe('own-edit')
  })
})

describe('createVerdict', () => {
  it('nobody or the writer is kept; anyone else needs a vouch', () => {
    expect(createVerdict(note('x', null), VIC, never)).toBe('own-create')
    expect(createVerdict(note('x', VIC), VIC, never)).toBe('own-create')
    expect(createVerdict(geoShape('g') as unknown as TLShape, VIC, never)).toBe('own-create')
    expect(createVerdict(note('x', ALICE), VIC, never)).toBe('forged')
    expect(createVerdict(note('x', ALICE), VIC, always)).toBe('vouched')
  })
})

describe('AttributionLedger', () => {
  it('vouches only for the exact (note, text, attribution) the same user replaced', () => {
    const ledger = new AttributionLedger()
    ledger.replaced(note('Keep the Q3 launch', ALICE), VIC)
    expect(ledger.vouches(note('Keep the Q3 launch', ALICE), VIC)).toBe(true)
    expect(ledger.vouches(note('Keep the Q3 launch', ALICE), 'usr_carol')).toBe(false) // someone else's undo
    expect(ledger.vouches(note('Keep the Q3 launch!', ALICE), VIC)).toBe(false) // other words
    expect(ledger.vouches(note('Keep the Q3 launch', 'usr_carol'), VIC)).toBe(false) // other name
    expect(ledger.vouches(note('Keep the Q3 launch', ALICE, 'n2'), VIC)).toBe(false) // other note
    ledger.replaced(geoShape('g') as unknown as TLShape, VIC) // not attributed: nothing kept
    expect(ledger.size).toBe(1)
  })

  it('compares text by value, whatever order a patch left its keys in', () => {
    const ledger = new AttributionLedger()
    const a = note('Same words', ALICE)
    ledger.replaced(a, VIC)
    const doc = (a.props as { richText: { type: string; content: unknown[] } }).richText
    const reordered = { content: doc.content, type: doc.type }
    expect(ledger.vouches({ ...a, props: { ...a.props, richText: reordered } } as TLShape, VIC)).toBe(true)
  })

  it('is bounded per note and per room, dropping the oldest first', () => {
    const ledger = new AttributionLedger({ perShape: 2, entries: 3 })
    for (const t of ['one', 'two', 'three']) ledger.replaced(note(t, ALICE), VIC)
    expect(ledger.vouches(note('one', ALICE), VIC)).toBe(false)
    expect(ledger.vouches(note('three', ALICE), VIC)).toBe(true)
    ledger.replaced(note('x', ALICE, 'n2'), VIC)
    ledger.replaced(note('y', ALICE, 'n3'), VIC) // 5 > 3: n1 (least recently written) goes
    expect(ledger.size).toBe(2)
    expect(ledger.vouches(note('three', ALICE), VIC)).toBe(false)
    expect(ledger.vouches(note('y', ALICE, 'n3'), VIC)).toBe(true)
    ledger.replaced(note('y', ALICE, 'n3'), VIC) // the same pair again is not a second entry
    expect(ledger.size).toBe(2)
  })
})

describe('sameAsDeleted', () => {
  const row = (shape: TLShape, deletedBy = VIC) => ({ state: JSON.stringify(shape), deletedBy })
  it('vouches for what this user deleted from this note, word for word', () => {
    const hers = note('Keep the Q3 launch', ALICE)
    expect(sameAsDeleted(hers, VIC, row(hers))).toBe(true)
    expect(sameAsDeleted(hers, VIC, row(hers, 'usr_carol'))).toBe(false)
    expect(sameAsDeleted(note('Cancel it', ALICE), VIC, row(hers))).toBe(false)
    expect(sameAsDeleted(hers, VIC, row(note('Keep the Q3 launch', ALICE, 'n2')))).toBe(false)
    expect(sameAsDeleted(hers, VIC, null)).toBe(false)
    expect(sameAsDeleted(hers, VIC, { state: '{not json', deletedBy: VIC })).toBe(false)
  })
})

describe('withNoteAttribution (composed with the room authorizer)', () => {
  type Authorizers = TLRecordAuthorizers<TLRecord, SessionMeta>
  type Args = Parameters<NonNullable<Authorizers['shape']>>[0]
  const session = (userId: string, isReadonly = false) => ({
    sessionId: `s-${userId}`,
    isReadonly,
    meta: { userId, role: 'editor', name: userId, color: '#000000' } as SessionMeta,
  })
  const setup = (base: Authorizers = {}) => {
    const ledger = new AttributionLedger()
    const onForged = vi.fn()
    const { shape } = withNoteAttribution(base, { ledger, onForged })
    if (!shape) throw new Error('no shape authorizer')
    const run = (args: Omit<Args, 'session'> & { session?: Args['session'] }) =>
      shape({ session: session(VIC), ...args } as Args)
    return { ledger, onForged, run }
  }

  it('stores a forged create anonymous and reports it; the base authorizer sees the rewritten note', () => {
    const base = vi.fn((args: Args) => (args.type === 'delete' ? args.prev : args.next))
    const { run, onForged } = setup({ shape: base as Authorizers['shape'] })
    const out = run({ type: 'create', prev: null, next: note('Alice: cancel it', ALICE) })
    expect(attributionOf(out as TLShape)).toBeNull()
    expect(attributionOf(base.mock.calls[0]?.[0].next as TLShape)).toBeNull()
    expect(onForged).toHaveBeenCalledWith('create', 'shape:n1', 's-usr_vic')
  })

  it('skips a forged update before the base authorizer (the text lease never takes a lease for it)', () => {
    const base = vi.fn((args: Args) => (args.type === 'delete' ? args.prev : args.next))
    const { run, onForged } = setup({ shape: base as Authorizers['shape'] })
    expect(run({ type: 'update', prev: note('Keep', ALICE), next: note('Cancel', ALICE) })).toBeNull()
    expect(base).not.toHaveBeenCalled()
    expect(onForged).toHaveBeenCalledWith('update', 'shape:n1', 's-usr_vic')
  })

  it("remembers what the writer's own allowed edits and deletes replaced, and only then", () => {
    let veto = true
    const base = vi.fn((args: Args) => (veto ? null : args.type === 'delete' ? args.prev : args.next))
    const { run, ledger } = setup({ shape: base as Authorizers['shape'] })
    const hers = note('Keep', ALICE)
    expect(run({ type: 'update', prev: hers, next: note('Cancel', VIC) })).toBeNull() // lease veto
    expect(ledger.vouches(hers, VIC)).toBe(false)
    veto = false
    expect(run({ type: 'update', prev: hers, next: note('Cancel', VIC) })).not.toBeNull()
    expect(ledger.vouches(hers, VIC)).toBe(true)
    // the undo is now vouched for
    expect(run({ type: 'update', prev: note('Cancel', VIC), next: hers })).not.toBeNull()
    const other = note('Other', ALICE, 'n2')
    expect(run({ type: 'delete', prev: other, next: null })).not.toBeNull()
    expect(run({ type: 'create', prev: null, next: other })).toEqual(other) // undo of the delete, as it was
  })

  it('fails closed for read-only sessions', () => {
    const { run } = setup()
    expect(run({ session: session(VIC, true), type: 'create', prev: null, next: note('x', VIC) })).toBeNull()
  })

  it('uses the "Recently deleted" row when the ledger has nothing (after a restart)', () => {
    const ledger = new AttributionLedger()
    const hers = note('Keep', ALICE)
    const { shape } = withNoteAttribution(
      {},
      {
        ledger,
        deletedRow: (id) => (id === hers.id ? { state: JSON.stringify(hers), deletedBy: VIC } : null),
      },
    )
    const out = shape?.({ session: session(VIC), type: 'create', prev: null, next: hers } as Args)
    expect(attributionOf(out as TLShape)).toBe(ALICE)
    const carols = shape?.({ session: session('usr_carol'), type: 'create', prev: null, next: hers } as Args)
    expect(attributionOf(carols as TLShape)).toBeNull()
  })

  it('an honest note is passed on as it is', () => {
    const { run } = setup()
    expect(run({ type: 'create', prev: null, next: note('', null) })).toEqual(note('', null))
    const edit = {
      ...note('Keep', ALICE),
      props: { ...note('Keep', ALICE).props, richText: toRichText('Keep!') },
    }
    expect(
      run({
        type: 'update',
        prev: note('Keep', ALICE),
        next: { ...edit, props: { ...edit.props, textLastEditedBy: VIC } } as TLShape,
      }),
    ).not.toBeNull()
  })
})
