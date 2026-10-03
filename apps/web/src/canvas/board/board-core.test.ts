// The board page's pure pieces: the change classifier (on('change')), the joined undo step
// (transact joinPrevious), the peer store (presence.peers) and the local settings.
import type { RosterEntry, ServerMessage } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../api/feature.ts'
import type { ContentHandlerSpec } from '../api/registries.ts'
import type { HistEl, Scene } from '../history/diff.ts'
import { LobbyHistory } from '../history/stack.ts'
import { createRegistries } from '../registries.ts'
import { ChangeClassifier, type ChangeElement } from './changes.ts'
import { contentOf, dispatchContent, handlersFor } from './content.ts'
import { joinInto, joinMark } from './history-join.ts'
import { type PeerSource, PeerStore } from './peers.ts'
import { SETTINGS_KEY, SettingsStore } from './settings.ts'
import { onUploads, trackUpload, uploadsInFlight } from './uploads.ts'

describe('ChangeClassifier', () => {
  const lookup = (m: Map<string, ChangeElement>) => (id: string) => m.get(id)

  it('reports remote installs at once and skips them in the next scan; history and local are split', () => {
    const els = new Map<string, ChangeElement>([['a', { id: 'a', version: 1, isDeleted: false }]])
    const c = new ChangeClassifier()
    c.seed(els.values())
    // a remote create and a remote update
    els.set('b', { id: 'b', version: 1, isDeleted: false })
    els.set('a', { id: 'a', version: 2, isDeleted: false })
    expect(c.applied(['a', 'b'], lookup(els))).toEqual({
      source: 'remote',
      created: ['b'],
      updated: ['a'],
      deleted: [],
    })
    // the scan after the install: nothing new
    expect(c.scanned(['a', 'b'], lookup(els))).toEqual([])
    // an undo patches a, the user deletes b
    c.markHistory(['a'])
    els.set('a', { id: 'a', version: 3, isDeleted: false })
    els.set('b', { id: 'b', version: 2, isDeleted: true })
    expect(c.scanned(['a', 'b'], lookup(els))).toEqual([
      { source: 'history', created: [], updated: ['a'], deleted: [] },
      { source: 'local', created: [], updated: [], deleted: ['b'] },
    ])
  })

  it('a local edit made after a remote install (before the scan) is local', () => {
    const els = new Map<string, ChangeElement>([['a', { id: 'a', version: 1, isDeleted: false }]])
    const c = new ChangeClassifier()
    c.seed(els.values())
    els.set('a', { id: 'a', version: 2, isDeleted: false })
    c.applied(['a'], lookup(els))
    els.set('a', { id: 'a', version: 3, isDeleted: false })
    expect(c.scanned(['a'], lookup(els))).toEqual([
      { source: 'local', created: [], updated: ['a'], deleted: [] },
    ])
  })

  it('a restore is a create; a tombstone never seen live is not reported', () => {
    const els = new Map<string, ChangeElement>([['a', { id: 'a', version: 1, isDeleted: true }]])
    const c = new ChangeClassifier()
    c.seed(els.values())
    els.set('z', { id: 'z', version: 4, isDeleted: true })
    expect(c.applied(['z'], lookup(els))).toBeNull()
    els.set('a', { id: 'a', version: 2, isDeleted: false })
    expect(c.scanned(['a'], lookup(els))).toEqual([
      { source: 'local', created: ['a'], updated: [], deleted: [] },
    ])
  })
})

describe('joinPrevious (history-join)', () => {
  const el = (id: string, over: Record<string, unknown> = {}): HistEl =>
    ({ id, type: 'text', isDeleted: false, version: 1, versionNonce: 1, x: 0, text: '', ...over }) as HistEl
  const scene = (...els: HistEl[]): Scene => new Map(els.map((e) => [e.id, e]))

  it('folds the derived write into the previous step: one undo reverts both', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a'), el('b')))
    // the user's step: a's text
    h.record(scene(el('a', { text: 'hi', version: 2 }), el('b')))
    const mark = joinMark(h)
    // the derived write: b moves (the mind map's re-layout), a moves too
    h.record(scene(el('a', { text: 'hi', x: 5, version: 3 }), el('b', { x: 40, version: 2 })))
    expect(joinInto(h, mark)).toBe(true)
    expect(h.undoSize).toBe(1)
    const res = h.undo(scene(el('a', { text: 'hi', x: 5, version: 3 }), el('b', { x: 40, version: 2 })))
    expect(res?.patches.get('a')).toEqual({ text: '', x: 0 })
    expect(res?.patches.get('b')).toEqual({ x: 0 })
  })

  it('does not join after an undo, on an empty stack, or when nothing was recorded', () => {
    const h = new LobbyHistory()
    h.reset(scene(el('a')))
    const empty = joinMark(h)
    h.record(scene(el('a', { x: 1, version: 2 })))
    expect(joinInto(h, empty)).toBe(false)
    expect(h.undoSize).toBe(1)
    const same = joinMark(h)
    expect(joinInto(h, same)).toBe(false)
    h.record(scene(el('a', { x: 2, version: 3 })))
    h.undo(scene(el('a', { x: 2, version: 3 })))
    const afterUndo = joinMark(h)
    h.record(scene(el('a', { x: 7, version: 5 })))
    expect(joinInto(h, afterUndo)).toBe(false)
  })
})

describe('PeerStore', () => {
  function source() {
    let listener: ((e: { kind: string; message?: ServerMessage }) => void) | null = null
    const roster = new Map<string, RosterEntry>([
      ['s1', { sid: 's1', uid: 'u1', name: 'Me', color: '#111', role: 'editor', guest: false }],
      ['s2', { sid: 's2', uid: 'u2', name: 'Bob', color: '#222', role: 'viewer', guest: true }],
    ])
    const src: PeerSource = {
      on: (l) => {
        listener = l
        return () => {
          listener = null
        }
      },
      roster: () => roster,
      sid: 's1',
    }
    return { src, send: (message: ServerMessage) => listener?.({ kind: 'message', message }) }
  }

  it('keeps each peer frame with its view, joins identity from the roster, and leaves out this tab', async () => {
    const s = source()
    const store = new PeerStore(s.src)
    let bumps = 0
    store.subscribe(() => bumps++)
    s.send({
      type: 'presence',
      peers: [
        {
          sid: 's2',
          pointer: { x: 1, y: 2 },
          button: 'up',
          sel: ['a'],
          view: { x: 0, y: 0, w: 100, h: 50 },
          idle: false,
          editing: null,
        },
        { sid: 's1', pointer: null, button: 'up', sel: [], view: null, idle: false, editing: null },
      ],
    } as ServerMessage)
    expect(store.peers()).toEqual([
      {
        sid: 's2',
        uid: 'u2',
        name: 'Bob',
        color: '#222',
        guest: true,
        point: { x: 1, y: 2 },
        view: { x: 0, y: 0, width: 100, height: 50 },
        selection: ['a'],
        idle: false,
        editing: null,
      },
    ])
    expect(store.peer('s2')?.name).toBe('Bob')
    await Promise.resolve()
    expect(bumps).toBe(1)
    s.send({ type: 'presence', peers: [], off: ['s2'] } as ServerMessage)
    expect(store.peers()).toEqual([])
    await Promise.resolve()
    expect(bumps).toBe(2)
  })
})

describe('SettingsStore', () => {
  it('remembers grid, snapping and the wheel preference, never focus mode, and survives a throwing storage', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
    const a = new SettingsStore(storage)
    let n = 0
    a.subscribe(() => n++)
    a.set({ grid: true, focusMode: true })
    a.set({ grid: true })
    expect(n).toBe(1)
    expect(JSON.parse(data.get(SETTINGS_KEY) ?? '{}')).toEqual({ grid: true, snap: false, wheel: 'auto' })
    expect(new SettingsStore(storage).get()).toEqual({
      grid: true,
      snap: false,
      focusMode: false,
      wheel: 'auto',
    })
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const b = new SettingsStore(broken)
    expect(b.get().grid).toBe(false)
    b.set({ snap: true })
    expect(b.get().snap).toBe(true)
  })
})

describe('SettingsStore: the wheel preference (W5-33, CR-W5-3A-4)', () => {
  const memory = () => {
    const data = new Map<string, string>()
    return {
      data,
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    }
  }

  it('is auto until it is set, local, remembered, and tells its listeners once', () => {
    const { data, storage } = memory()
    const a = new SettingsStore(storage)
    expect(a.get().wheel).toBe('auto')
    let n = 0
    a.subscribe(() => n++)
    a.set({ wheel: 'mouse' })
    a.set({ wheel: 'mouse' })
    expect(n).toBe(1)
    expect(a.get().wheel).toBe('mouse')
    expect(JSON.parse(data.get(SETTINGS_KEY) ?? '{}').wheel).toBe('mouse')
    // another tab or a reload reads it back
    expect(new SettingsStore(storage).get().wheel).toBe('mouse')
    a.set({ wheel: 'trackpad' })
    expect(new SettingsStore(storage).get().wheel).toBe('trackpad')
    a.set({ wheel: 'auto' })
    expect(new SettingsStore(storage).get().wheel).toBe('auto')
  })

  it('keeps the other settings when only the wheel changes, and the wheel when they change', () => {
    const { storage } = memory()
    const a = new SettingsStore(storage)
    a.set({ wheel: 'mouse', grid: true })
    a.set({ snap: true })
    expect(a.get()).toEqual({ grid: true, snap: true, focusMode: false, wheel: 'mouse' })
    expect(new SettingsStore(storage).get()).toEqual({
      grid: true,
      snap: true,
      focusMode: false,
      wheel: 'mouse',
    })
  })

  it('reads anything it does not know as auto (a hand-edited value, an older save with no wheel)', () => {
    for (const stored of [
      '{"grid":true,"snap":false,"wheel":"touchpad"}',
      '{"grid":true,"snap":false,"wheel":3}',
      '{"grid":true,"snap":false}',
    ]) {
      const { storage, data } = memory()
      data.set(SETTINGS_KEY, stored)
      expect(new SettingsStore(storage).get()).toEqual({
        grid: true,
        snap: false,
        focusMode: false,
        wheel: 'auto',
      })
    }
    const { storage } = memory()
    const a = new SettingsStore(storage)
    a.set({ wheel: 'sideways' as never })
    expect(a.get().wheel).toBe('auto')
  })
})

describe('uploads in flight', () => {
  it('counts each tracked upload until it settles (resolved or rejected), per board page', async () => {
    const r = createRegistries()
    const other = createRegistries()
    const seen: number[] = []
    onUploads(r, () => seen.push(uploadsInFlight(r)))
    let ok: () => void = () => {}
    let fail: (e: Error) => void = () => {}
    const a = trackUpload(r, new Promise<void>((res) => (ok = res)))
    const b = trackUpload(r, new Promise<void>((_, rej) => (fail = rej)))
    expect(uploadsInFlight(r)).toBe(2)
    expect(uploadsInFlight(other)).toBe(0)
    ok()
    await a
    fail(new Error('network'))
    await b.catch(() => {})
    await Promise.resolve()
    expect(uploadsInFlight(r)).toBe(0)
    expect(seen).toEqual([1, 2, 1, 0])
  })
})

describe('paste and drop content', () => {
  const t = (data: Record<string, string>, files: File[] = []) => ({
    files,
    getData: (type: string) => data[type] ?? '',
  })

  it('reads files first, then a lone URL, then text with its HTML', () => {
    const f = new File(['x'], 'a.png', { type: 'image/png' })
    expect(contentOf(t({ 'text/plain': 'ignored' }, [f]))).toEqual({ kind: 'files', files: [f] })
    expect(contentOf(t({ 'text/plain': ' https://example.com/a ' }))).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
    })
    expect(contentOf(t({ 'text/uri-list': '# comment\nhttps://x.test/p' }))).toEqual({
      kind: 'url',
      url: 'https://x.test/p',
    })
    expect(contentOf(t({ 'text/plain': 'a\tb', 'text/html': '<table/>' }))).toEqual({
      kind: 'text',
      text: 'a\tb',
      html: '<table/>',
    })
    expect(contentOf(t({}))).toBeNull()
    expect(contentOf(null)).toBeNull()
  })

  it('runs the handlers for the kind by priority until one takes it; a throwing one is passed over', async () => {
    const ran: string[] = []
    const h = (
      id: string,
      priority: number,
      take: boolean | 'throw',
      kinds: ContentHandlerSpec['kinds'] = ['text'],
    ): ContentHandlerSpec => ({
      id,
      kinds: [...kinds],
      priority,
      handle: () => {
        ran.push(id)
        if (take === 'throw') throw new Error('boom')
        return take
      },
    })
    const handlers = [
      h('low', 1, true),
      h('files', 9, true, ['files']),
      h('high', 5, false),
      h('bad', 7, 'throw'),
    ]
    expect(handlersFor(handlers, { kind: 'text', text: 'x' }).map((x) => x.id)).toEqual([
      'bad',
      'high',
      'low',
    ])
    const orig = console.error
    console.error = () => {}
    try {
      expect(
        await dispatchContent(
          handlers,
          { kind: 'text', text: 'x' },
          {} as CanvasFeatureContext,
          null,
          'paste',
        ),
      ).toBe(true)
    } finally {
      console.error = orig
    }
    expect(ran).toEqual(['bad', 'high', 'low'])
    expect(
      await dispatchContent(
        [h('none', 1, false)],
        { kind: 'text', text: 'x' },
        {} as CanvasFeatureContext,
        null,
        'drop',
      ),
    ).toBe(false)
  })
})
