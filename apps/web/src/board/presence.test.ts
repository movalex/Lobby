import {
  CameraRecordType,
  createShapeId,
  createTLStore,
  createUserId,
  DocumentRecordType,
  defaultShapeUtils,
  InstancePageStateRecordType,
  PageRecordType,
  PointerRecordType,
  TLDOCUMENT_ID,
  TLINSTANCE_ID,
  type TLInstancePresence,
  TLPOINTER_ID,
  toRichText,
  UserRecordType,
} from 'tldraw'
import { describe, expect, it } from 'vitest'
import { FileCardShapeUtil } from '../file-card/FileCardShapeUtil.tsx'
import {
  getDraftroomPresence,
  holderName,
  parseLeaseDenied,
  presenceUsers,
  remoteEditing,
} from './presence.ts'

const presence = (userId: string, over: Partial<TLInstancePresence> = {}) =>
  ({
    userId: createUserId(userId),
    userName: userId,
    color: '#123456',
    lastActivityTimestamp: 1,
    meta: {},
    ...over,
  }) as TLInstancePresence

describe('presence list', () => {
  it('shows each other person once, never yourself', () => {
    const list = presenceUsers(
      [
        presence('bob', { lastActivityTimestamp: 1 }),
        presence('alice'),
        presence('bob', { lastActivityTimestamp: 5, color: '#ff0000' }), // bob's second tab, more recent
        presence('carol'),
      ],
      'alice',
    )
    expect(list.map((u) => [u.userId, u.color])).toEqual([
      ['bob', '#ff0000'],
      ['carol', '#123456'],
    ])
  })
})

describe('remote editing hints', () => {
  it('lists other users with a string editingShapeId in presence meta', () => {
    const shape = createShapeId('n1')
    const out = remoteEditing(
      [
        presence('bob', { meta: { editingShapeId: shape } }),
        presence('alice', { meta: { editingShapeId: shape } }), // self
        presence('carol', { meta: { editingShapeId: null } }),
        presence('dana', { meta: { editingShapeId: 42 } }), // garbage from a bad client
      ],
      'alice',
    )
    expect(out).toEqual([{ userId: 'bob', name: 'bob', color: '#123456', shapeId: shape }])
  })
})

describe('text-lease-denied', () => {
  it('parses the contract message and ignores anything else', () => {
    expect(
      parseLeaseDenied({
        type: 'text-lease-denied',
        shapeId: 'shape:a',
        holderUserId: 'bob',
        expiresInMs: 4200,
      }),
    ).toEqual({ shapeId: 'shape:a', holderUserId: 'bob', expiresInMs: 4200 })
    expect(parseLeaseDenied({ type: 'text-lease-denied', shapeId: 'shape:a' })).toEqual({
      shapeId: 'shape:a',
      holderUserId: null,
      expiresInMs: null,
    })
    for (const junk of [null, 'x', { type: 'other' }, { type: 'text-lease-denied' }]) {
      expect(parseLeaseDenied(junk)).toBeNull()
    }
  })
  it("names the holder from presence, falling back to their id (or 'Someone')", () => {
    const here = [presence('bob', { userName: 'Bob Builder' })]
    expect(holderName(here, 'bob')).toBe('Bob Builder')
    expect(holderName(here, 'erin')).toBe('erin')
    expect(holderName(here, null)).toBe('Someone')
  })
})

describe('getDraftroomPresence', () => {
  it('reports the rich-text shape this tab is editing in meta.editingShapeId', () => {
    const store = createTLStore({ shapeUtils: [...defaultShapeUtils, FileCardShapeUtil] })
    const pageId = PageRecordType.createId('p1')
    // The minimum a tab has once mounted: document, page, instance, page state, camera, pointer.
    store.put([
      DocumentRecordType.create({ id: TLDOCUMENT_ID }),
      PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' as never }),
      store.schema.types.instance.create({ id: TLINSTANCE_ID, currentPageId: pageId }),
      InstancePageStateRecordType.create({ id: InstancePageStateRecordType.createId(pageId), pageId }),
      CameraRecordType.create({ id: CameraRecordType.createId(pageId) }),
      PointerRecordType.create({ id: TLPOINTER_ID }),
    ])
    const textId = createShapeId('t1')
    const cardId = createShapeId('c1')
    store.put([
      store.schema.types.shape.create({
        id: textId,
        type: 'text',
        parentId: pageId,
        index: 'a1' as never,
        props: {
          color: 'black',
          size: 'm',
          font: 'draw',
          textAlign: 'start',
          w: 100,
          richText: toRichText('hi'),
          scale: 1,
          autoSize: true,
        },
      }),
      store.schema.types.shape.create({
        id: cardId,
        type: 'dr-file-card',
        parentId: pageId,
        index: 'a2' as never,
        props: new FileCardShapeUtil({} as never).getDefaultProps(),
      }),
    ])
    const user = UserRecordType.create({ id: createUserId('alice'), name: 'alice', color: '#000000' })
    const setEditing = (id: typeof textId | null) => {
      const psId = InstancePageStateRecordType.createId(pageId)
      const ps = store.get(psId)
      if (!ps) throw new Error('no page state')
      store.put([{ ...ps, editingShapeId: id }])
    }
    expect(getDraftroomPresence(store, user)?.meta).toEqual({ editingShapeId: null })
    setEditing(textId)
    expect(getDraftroomPresence(store, user)?.meta).toEqual({ editingShapeId: textId })
    expect(getDraftroomPresence(store, user)?.userName).toBe('alice')
    setEditing(cardId) // not a text shape: the lease does not apply, so no hint either
    expect(getDraftroomPresence(store, user)?.meta).toEqual({ editingShapeId: null })
  })
})
