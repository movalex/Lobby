/**
 * Spike check A15 (plan §8.2): Lobby's undo applier in Node — every case of §2.8 including probe2's
 * (another user's +1 and group survive an undo), recording against `lastLocal` (not the confirmed
 * copy), folding acked `fix` values into their entry, and server fixes and repairs never creating a
 * step. Pure functions over element maps; Excalidraw's history is only used as the negative control.
 *
 * Browser-side cases U1–U10 are spike B2 (three real browsers); the same steps run here on maps.
 */
import {
  ElementsDelta,
  newArrowElement,
  newElement,
  newElementWith,
  newFrameElement,
  newFreeDrawElement,
  newImageElement,
  newLinearElement,
  newStickyNoteElement,
  newTextElement,
  setCustomTextMetricsProvider,
} from '@excalidraw/element'
import { beforeAll, describe, expect, it } from 'vitest'
import type { HistEl } from './diff.ts'
import { unclassifiedFields } from './fields.ts'
import { type Ack, LobbyHistory } from './stack.ts'

beforeAll(() => {
  setCustomTextMetricsProvider({ getLineWidth: (t: string) => t.length * 10 } as never)
})

const base = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

let nonce = 1
const rect = (id: string, extra: Record<string, unknown> = {}): HistEl =>
  ({
    ...newElement({ ...base, type: 'rectangle', id } as never),
    index: `a${id.length}`,
    ...extra,
  }) as unknown as HistEl
const note = (id: string, extra: Record<string, unknown> = {}): HistEl =>
  ({
    ...newStickyNoteElement({ ...base, type: 'stickynote', id, created: null } as never),
    index: 'a1',
    ...extra,
  }) as unknown as HistEl
const text = (id: string, containerId: string | null, extra: Record<string, unknown> = {}): HistEl =>
  ({
    ...newTextElement({ ...base, id, text: 'hello', containerId } as never),
    index: 'a2',
    ...extra,
  }) as unknown as HistEl

type SceneMap = Map<string, HistEl>

const bump = (el: HistEl, patch: Record<string, unknown>): HistEl =>
  ({ ...el, ...patch, version: (el.version ?? 1) + 1, versionNonce: nonce++ }) as HistEl

/** A local edit by this user (A): Excalidraw bumps the version */
const local = (scene: SceneMap, id: string, patch: Record<string, unknown>) => {
  const cur = scene.get(id)
  if (!cur) throw new Error(`no ${id}`)
  scene.set(id, bump(cur, patch))
}
const localCreate = (scene: SceneMap, el: HistEl) => scene.set(el.id, el)

/** A change from the server (another user, a repair), applied with NEVER and absorbed */
const remote = (scene: SceneMap, h: LobbyHistory, id: string, patch: Record<string, unknown>) => {
  const before = scene.get(id)
  if (!before) throw new Error(`no ${id}`)
  const after = bump(before, patch)
  scene.set(id, after)
  h.absorb(before, after)
}
const remoteCreate = (scene: SceneMap, h: LobbyHistory, el: HistEl) => {
  scene.set(el.id, el)
  h.absorb(undefined, el)
}

/** install an undo/redo result like the adapter (updateScene with NEVER, the engine pushes it) */
const install = (scene: SceneMap, res: ReturnType<LobbyHistory['undo']>) => {
  if (!res) return
  for (const [id, patch] of res.patches) {
    const cur = scene.get(id)
    if (cur) scene.set(id, bump(cur, patch))
  }
}

const lobby = (el: HistEl | undefined) =>
  (el?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby

const start = (...els: HistEl[]) => {
  const scene: SceneMap = new Map(els.map((e) => [e.id, e]))
  const h = new LobbyHistory()
  h.reset(scene)
  return { scene, h }
}

describe('A15 negative control: probe2 on Excalidraw deltas (why D6)', () => {
  it("Excalidraw's delta undo drops Bob's +1 and Bob's outer group", () => {
    const n0 = { ...rect('N'), customData: { lobby: { 'tag:x': true } } }
    const n1 = newElementWith(
      n0 as never,
      { customData: { lobby: { 'tag:x': true, 'plusOne:usr_me': true } } } as never,
    )
    const entry = ElementsDelta.calculate(
      new Map([['N', n0]]) as never,
      new Map([['N', n1]]) as never,
    ).inverse()
    const n2 = newElementWith(n1, {
      customData: { lobby: { 'tag:x': true, 'plusOne:usr_me': true, 'plusOne:usr_bob': true } },
    } as never)
    const [after] = entry.applyTo(new Map([['N', n2]]) as never)
    expect((after.get('N') as unknown as HistEl).customData).toEqual({ lobby: { 'tag:x': true } })
    const g0 = rect('G')
    const g1 = newElementWith(g0 as never, { groupIds: ['mine'] } as never)
    const ge = ElementsDelta.calculate(new Map([['G', g0]]) as never, new Map([['G', g1]]) as never).inverse()
    const g2 = newElementWith(g1, { groupIds: ['mine', 'bobOuter'] } as never)
    const [gAfter] = ge.applyTo(new Map([['G', g2]]) as never)
    expect((gAfter.get('G') as unknown as HistEl).groupIds).toEqual([])
  })
})

describe('A15: §2.8 cases (U1–U10 on element maps)', () => {
  it('U1 +1: my undo removes only my +1; Bob keeps his', () => {
    const { scene, h } = start(rect('N', { customData: { lobby: { 'tag:x': true } } }))
    local(scene, 'N', { customData: { lobby: { 'tag:x': true, 'plusOne:usr_me': true } } })
    h.record(scene)
    remote(scene, h, 'N', {
      customData: { lobby: { 'tag:x': true, 'plusOne:usr_me': true, 'plusOne:usr_bob': true } },
    })
    const res = h.undo(scene)
    install(scene, res)
    expect(lobby(scene.get('N'))).toEqual({ 'tag:x': true, 'plusOne:usr_bob': true })
    expect(res?.kept).toBe(0)
  })

  it('U2 tags: Bob’s #y stays when I undo my #x', () => {
    const { scene, h } = start(rect('N'))
    local(scene, 'N', { customData: { lobby: { 'tag:x': true } } })
    h.record(scene)
    remote(scene, h, 'N', { customData: { lobby: { 'tag:x': true, 'tag:y': true } } })
    install(scene, h.undo(scene))
    expect(lobby(scene.get('N'))).toEqual({ 'tag:y': true })
  })

  it('U3 groups: my inner group goes, Bob’s outer group stays on N, M and P; redo puts mine back innermost', () => {
    const { scene, h } = start(rect('N'), rect('M'), rect('P'))
    local(scene, 'N', { groupIds: ['gA'] })
    local(scene, 'M', { groupIds: ['gA'] })
    h.record(scene)
    remote(scene, h, 'N', { groupIds: ['gA', 'gB'] })
    remote(scene, h, 'M', { groupIds: ['gA', 'gB'] })
    remote(scene, h, 'P', { groupIds: ['gB'] })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')?.groupIds).toEqual(['gB'])
    expect(scene.get('M')?.groupIds).toEqual(['gB'])
    expect(scene.get('P')?.groupIds).toEqual(['gB'])
    expect(res?.kept).toBe(0)
    install(scene, h.redo(scene))
    expect(scene.get('N')?.groupIds).toEqual(['gA', 'gB'])
    expect(scene.get('M')?.groupIds).toEqual(['gA', 'gB'])
  })

  it('U4 move vs remote recolour: N goes back where I found it, Bob’s colour stays', () => {
    const { scene, h } = start(rect('N', { x: 10, y: 20 }))
    local(scene, 'N', { x: 300, y: 400 })
    h.record(scene)
    remote(scene, h, 'N', { backgroundColor: '#ff0000' })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')).toMatchObject({ x: 10, y: 20, backgroundColor: '#ff0000' })
    expect(res?.kept).toBe(0)
  })

  it('U5 same field: my undo keeps Bob’s blue and reports "1 change kept"', () => {
    const { scene, h } = start(rect('N', { backgroundColor: '#ffffff' }))
    local(scene, 'N', { backgroundColor: 'red' })
    h.record(scene)
    remote(scene, h, 'N', { backgroundColor: 'blue' })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')?.backgroundColor).toBe('blue')
    expect(res?.kept).toBe(1)
    expect(res?.skips).toEqual([{ id: 'N', what: 'backgroundColor', reason: 'changed', silent: false }])
  })

  it('U6 remote delete: my undo of my create and my redo never resurrect it', () => {
    const { scene, h } = start()
    localCreate(scene, rect('N'))
    h.record(scene)
    remote(scene, h, 'N', { isDeleted: true })
    const u = h.undo(scene)
    install(scene, u)
    expect(scene.get('N')?.isDeleted).toBe(true)
    expect(u?.skips[0]?.reason).toBe('deleted')
    expect(h.redo(scene)).toBeNull()
    expect(scene.get('N')?.isDeleted).toBe(true)
  })

  it('U7 frame drag: children go back except the one C moved since; B’s colour on child 1 stays', () => {
    const kids = Array.from({ length: 6 }, (_, i) => rect(`k${i}`, { x: i * 10, y: 0, frameId: 'F' }))
    const { scene, h } = start(newFrameElement({ ...base, id: 'F' } as never) as unknown as HistEl, ...kids)
    local(scene, 'F', { x: 500, y: 500 })
    for (let i = 0; i < 6; i++) local(scene, `k${i}`, { x: 500 + i * 10, y: 500 })
    h.record(scene, 'drag frame')
    remote(scene, h, 'k1', { backgroundColor: '#00ff00' })
    remote(scene, h, 'k2', { x: 999 })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('F')).toMatchObject({ x: 0, y: 0 })
    for (const i of [0, 1, 3, 4, 5]) expect(scene.get(`k${i}`)).toMatchObject({ x: i * 10, y: 0 })
    // C moved child 2 (only x changed): its position is one unit, so it stays exactly where C put it
    expect(scene.get('k2')).toMatchObject({ x: 999, y: 500 })
    expect(scene.get('k1')?.backgroundColor).toBe('#00ff00')
    expect(res?.kept).toBe(1)
  })

  it('geometry is compared per group over the recorded fields: my resize undoes although Bob rotated', () => {
    const { scene, h } = start(rect('N', { width: 100, height: 100, angle: 0 }))
    local(scene, 'N', { width: 300, height: 200 })
    h.record(scene)
    remote(scene, h, 'N', { angle: 0.5 }) // same `shape` group, a field my entry did not record
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')).toMatchObject({ width: 100, height: 100, angle: 0.5 })
    expect(res?.kept).toBe(0)
    // but when Bob changed one of my recorded fields, the whole unit stays his
    local(scene, 'N', { width: 300, height: 200 })
    h.record(scene)
    remote(scene, h, 'N', { width: 250 })
    const res2 = h.undo(scene)
    install(scene, res2)
    expect(scene.get('N')).toMatchObject({ width: 250, height: 200 })
    expect(res2?.kept).toBe(1)
  })

  it('independent style fields are compared one by one', () => {
    const { scene, h } = start(rect('N', { backgroundColor: '#fff', strokeColor: '#000' }))
    local(scene, 'N', { backgroundColor: 'red', strokeColor: 'blue' })
    h.record(scene)
    remote(scene, h, 'N', { strokeColor: 'green' })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')).toMatchObject({ backgroundColor: '#fff', strokeColor: 'green' })
    expect(res?.kept).toBe(1)
  })

  it('U8 selection changes are never steps', () => {
    const { scene, h } = start(rect('N', { x: 0 }))
    local(scene, 'N', { x: 50 })
    h.record(scene)
    for (let i = 0; i < 10; i++) expect(h.record(scene, 'select')).toBeNull() // appState only, no element change
    expect(h.undoSize).toBe(1)
    install(scene, h.undo(scene))
    expect(scene.get('N')?.x).toBe(0)
  })

  it('U9 two steps inside one round trip (recorded against lastLocal): each Ctrl+Z undoes one', () => {
    const { scene, h } = start(rect('N', { x: 0, backgroundColor: '#ffffff' }))
    local(scene, 'N', { backgroundColor: 'red' })
    h.record(scene, 'recolour')
    h.markPushed(1, ['N'])
    local(scene, 'N', { x: 200 })
    h.record(scene, 'move')
    h.markPushed(2, ['N'])
    // no ack yet: the confirmed copy is still white at x 0; lastLocal is red
    expect(h.undoEntries[1]?.changes.get('N')?.fields).toEqual({ x: { before: 0, after: 200 } })
    install(scene, h.undo(scene))
    expect(scene.get('N')).toMatchObject({ x: 0, backgroundColor: 'red' })
    install(scene, h.undo(scene))
    expect(scene.get('N')).toMatchObject({ x: 0, backgroundColor: '#ffffff' })
    // the late acks change nothing
    h.onAck({ seq: 1, r: [{ id: 'N', ok: true, v: 5 }] })
    h.onAck({ seq: 2, r: [{ id: 'N', ok: true, v: 6 }] })
    expect(h.redoSize).toBe(2)
  })

  it('U10 fixes and repairs: no "change kept", and the stack length equals my real actions', () => {
    const { scene, h } = start(note('N'))
    // (1) a stroke whose points the server rounds
    const stroke = {
      ...newFreeDrawElement({
        ...base,
        type: 'freedraw',
        id: 'S',
        points: [
          [0, 0],
          [1.23456, 2.34567],
        ],
        simulatePressure: true,
      } as never),
      index: 'a3',
    } as unknown as HistEl
    localCreate(scene, stroke)
    h.record(scene, 'stroke')
    h.markPushed(10, ['S'])
    const rounded = [
      [0, 0],
      [1.23, 2.35],
    ]
    const sBefore = scene.get('S') as HistEl
    scene.set('S', { ...sBefore, points: rounded }) // the engine installs the fix
    h.onAck({ seq: 10, r: [{ id: 'S', ok: true, v: 2, fix: { points: rounded } }] }, scene)
    // (2) a label the server re-keys
    localCreate(scene, text('L', 'N', { index: 'a0' }))
    local(scene, 'N', { boundElements: [{ id: 'L', type: 'text' }] })
    h.record(scene, 'label')
    h.markPushed(11, ['L', 'N'])
    const lBefore = scene.get('L') as HistEl
    scene.set('L', { ...lBefore, index: 'a1V' })
    h.onAck(
      {
        seq: 11,
        r: [
          { id: 'L', ok: true, v: 2, fix: { index: 'a1V' } },
          { id: 'N', ok: true, v: 3 },
        ],
      },
      scene,
    )
    // (3) an arrow bound to a note B deleted meanwhile: the server nulls the binding (fix)
    remoteCreate(scene, h, note('B2', { index: 'a4' }))
    remote(scene, h, 'B2', { isDeleted: true })
    const arrow = {
      ...newArrowElement({ ...base, type: 'arrow', id: 'A' } as never),
      index: 'a5',
    } as unknown as HistEl
    localCreate(scene, arrow)
    h.record(scene, 'arrow')
    // binding moves the arrow's end point too (Excalidraw snaps it to the target)
    local(scene, 'A', {
      startBinding: { elementId: 'B2', fixedPoint: [0.5, 0.5], mode: 'orbit' },
      points: [
        [0, 0],
        [120, 5],
      ],
    })
    h.record(scene, 'bind')
    h.markPushed(12, ['A'])
    const aBefore = scene.get('A') as HistEl
    scene.set('A', { ...aBefore, startBinding: null })
    h.onAck({ seq: 12, r: [{ id: 'A', ok: true, v: 3, fix: { startBinding: null } }] }, scene)
    // (4) a repair from someone else's clock: B deletes N, the server cascades nothing onto mine here
    // but rewrites A's endBinding to null as a repair (arrives as changes)
    remote(scene, h, 'A', { endBinding: null })
    expect(h.record(scene)).toBeNull()
    expect(h.undoSize).toBe(4) // stroke, label, arrow, bind
    const kept: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = h.undo(scene)
      install(scene, res)
      kept.push(res?.kept ?? -1)
    }
    expect(kept).toEqual([0, 0, 0, 0])
    expect(scene.get('S')?.isDeleted).toBe(true)
    expect(scene.get('L')?.isDeleted).toBe(true)
    expect(scene.get('N')?.boundElements ?? null).toBeNull()
    expect(scene.get('A')?.isDeleted).toBe(true)
  })
})

describe('A15: recording, fix folding, rejects, repairs', () => {
  it('an entry that a fix turned into a no-op is dropped (the stack never grows from a fix)', () => {
    const { scene, h } = start(rect('T'), {
      ...(newArrowElement({ ...base, type: 'arrow', id: 'A' } as never) as unknown as HistEl),
      index: 'a9',
    } as HistEl)
    remote(scene, h, 'T', { isDeleted: true })
    local(scene, 'A', { startBinding: { elementId: 'T', fixedPoint: [0.5, 0.5], mode: 'orbit' } })
    h.record(scene)
    h.markPushed(1, ['A'])
    scene.set('A', { ...(scene.get('A') as HistEl), startBinding: null })
    h.onAck({ seq: 1, r: [{ id: 'A', ok: true, v: 3, fix: { startBinding: null } }] }, scene)
    expect(h.undoSize).toBe(0)
  })

  it('an index fix is folded into `after`, so the undo applies with no false skip', () => {
    const { scene, h } = start(rect('N', { index: 'a1' }))
    local(scene, 'N', { index: 'a5' }) // bring to front
    h.record(scene)
    h.markPushed(1, ['N'])
    scene.set('N', { ...(scene.get('N') as HistEl), index: 'a4V' })
    h.onAck({ seq: 1, r: [{ id: 'N', ok: true, v: 3, fix: { index: 'a4V' } }] }, scene)
    expect(h.undoEntries[0]?.changes.get('N')?.fields.index).toEqual({ before: 'a1', after: 'a4V' })
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')?.index).toBe('a1')
    expect(res?.kept).toBe(0)
  })

  it('a fix also corrects a later entry that was recorded against the unfixed value', () => {
    const { scene, h } = start(rect('N', { index: 'a1' }))
    local(scene, 'N', { index: 'a5' })
    h.record(scene)
    h.markPushed(1, ['N'])
    local(scene, 'N', { index: 'a7' }) // before the ack
    h.record(scene)
    scene.set('N', { ...(scene.get('N') as HistEl) }) // the engine keeps the newer local a7
    h.onAck({ seq: 1, r: [{ id: 'N', ok: true, v: 3, fix: { index: 'a4V' } }] }, scene)
    expect(h.undoEntries[1]?.changes.get('N')?.fields.index).toEqual({ before: 'a4V', after: 'a7' })
  })

  it('a fix folded into a REDO entry leaves the undo entries alone (LEAD-foldFix-indexOf)', () => {
    // three steps on x: 10 -> 0, 0 -> 10, 10 -> 20; the third is undone (x written back to 10), and the
    // server fixes that push's x to 10.5. Before, the "later entries" repair looked the redo entry up in the
    // undo stack (indexOf: -1), took every undo entry as later, and rewrote the first step's `before`
    // (10, the same value) to 10.5: undoing all the way restored 10.5 instead of 10
    const { scene, h } = start(rect('N', { x: 10 }))
    let seq = 0
    const stepAcked = (patch: Record<string, unknown>) => {
      local(scene, 'N', patch)
      h.record(scene)
      h.markPushed(++seq, ['N'])
      h.onAck({ seq, r: [{ id: 'N', ok: true }] }, scene)
    }
    stepAcked({ x: 0 })
    stepAcked({ x: 10 })
    stepAcked({ x: 20 })
    install(scene, h.undo(scene))
    expect(scene.get('N')?.x).toBe(10)
    h.markPushed(++seq, ['N'])
    scene.set('N', { ...(scene.get('N') as HistEl), x: 10.5 }) // the engine installs the fix
    h.onAck({ seq, r: [{ id: 'N', ok: true, fix: { x: 10.5 } }] }, scene)
    // folded into the redo entry that carried it
    expect(h.redoEntries[0]?.changes.get('N')?.fields.x).toEqual({ before: 10.5, after: 20 })
    // the undo entries are untouched
    expect(h.undoEntries.map((e) => e.changes.get('N')?.fields.x)).toEqual([
      { before: 10, after: 0 },
      { before: 0, after: 10 },
    ])
    // and the redo still applies from the fixed value
    const r = h.redo(scene)
    expect(r?.kept).toBe(0)
    install(scene, r)
    expect(scene.get('N')?.x).toBe(20)
    expect(h.undoEntries[0]?.changes.get('N')?.fields.x).toEqual({ before: 10, after: 0 })
  })

  it('the client’s own index re-key of an unacknowledged element (E2) folds in and is no step', () => {
    const { scene, h } = start(rect('C', { index: 'a1' }))
    localCreate(scene, rect('X', { index: 'a1' }))
    h.record(scene)
    scene.set('X', { ...(scene.get('X') as HistEl), index: 'a1V' }) // pre-pass
    h.foldLocalFix('X', { index: 'a1V' }, scene)
    expect(h.record(scene)).toBeNull()
    expect(h.undoSize).toBe(1)
  })

  it('a rejected op leaves its entry; a denied group leaves only that group', () => {
    const { scene, h } = start(
      rect('N', { backgroundColor: '#fff' }),
      text('L', null, { originalText: 'a', text: 'a' }),
    )
    local(scene, 'N', { backgroundColor: 'red' })
    h.record(scene)
    h.markPushed(1, ['N'])
    h.onAck({ seq: 1, r: [{ id: 'N', ok: false, code: 'LOCKED' }] })
    expect(h.undoSize).toBe(0)
    local(scene, 'L', { x: 99, originalText: 'b', text: 'b' })
    h.record(scene)
    h.markPushed(2, ['L'])
    h.onAck({
      seq: 2,
      r: [{ id: 'L', ok: true, v: 4, denied: { groups: ['text', 'layout', 'life'], code: 'LEASED' } }],
    })
    expect(Object.keys(h.undoEntries[0]?.changes.get('L')?.fields ?? {})).toEqual(['x'])
  })

  it('a server repair (label cascade after a remote container delete) creates no entry', () => {
    const { scene, h } = start(note('N', { boundElements: [{ id: 'L', type: 'text' }] }), text('L', 'N'))
    remote(scene, h, 'N', { isDeleted: true })
    remote(scene, h, 'L', { isDeleted: true })
    expect(h.record(scene)).toBeNull()
    expect(h.undoSize).toBe(0)
  })

  it('a local change not recorded yet survives an absorb of a remote change to another field', () => {
    const { scene, h } = start(rect('N', { x: 0, backgroundColor: '#fff' }))
    local(scene, 'N', { x: 40 }) // not recorded yet (mid one-shot action)
    remote(scene, h, 'N', { backgroundColor: 'blue' })
    const e = h.record(scene)
    expect(e?.changes.get('N')?.fields).toEqual({ x: { before: 0, after: 40 } })
  })

  it('a text-editor session is one entry (originalText and layout), whatever was pushed meanwhile', () => {
    const { scene, h } = start(
      note('N', { boundElements: [{ id: 'L', type: 'text' }] }),
      text('L', 'N', { originalText: 'old', text: 'old' }),
    )
    for (const t of ['o', 'ol', 'new text']) {
      local(scene, 'L', { originalText: t, text: t })
      h.markPushed(20, ['L']) // typing pushes: no entry yet, nothing to mark
    }
    h.record(scene, 'text edit')
    expect(h.undoSize).toBe(1)
    install(scene, h.undo(scene))
    expect(scene.get('L')).toMatchObject({ originalText: 'old', text: 'old' })
  })
})

describe('A15: create, delete, children, orphans, leases', () => {
  it('undo of my create is refused while someone else’s child is in my frame, or someone bound to my note', () => {
    const { scene, h } = start()
    localCreate(scene, newFrameElement({ ...base, id: 'F' } as never) as unknown as HistEl)
    localCreate(scene, note('N'))
    h.record(scene)
    remoteCreate(scene, h, rect('child', { frameId: 'F' }))
    remoteCreate(scene, h, {
      ...(newArrowElement({ ...base, type: 'arrow', id: 'arr' } as never) as unknown as HistEl),
      startBinding: { elementId: 'N', fixedPoint: [0.5, 0.5], mode: 'orbit' },
    } as HistEl)
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('F')?.isDeleted).toBe(false)
    expect(scene.get('N')?.isDeleted).toBe(false)
    expect(res?.skips.map((s) => [s.id, s.reason])).toEqual([
      ['F', 'has-foreign-children'],
      ['N', 'has-foreign-children'],
    ])
  })

  it('undo of my create of a note and its label deletes both (the label is mine, not foreign)', () => {
    const { scene, h } = start()
    localCreate(scene, note('N', { boundElements: [{ id: 'L', type: 'text' }] }))
    localCreate(scene, text('L', 'N'))
    h.record(scene)
    const res = h.undo(scene)
    install(scene, res)
    expect(scene.get('N')?.isDeleted).toBe(true)
    expect(scene.get('L')?.isDeleted).toBe(true)
    expect(res?.kept).toBe(0)
  })

  it('undo of my delete revives; a label whose container someone deleted is an orphan; a purged id is gone', () => {
    const { scene, h } = start(
      note('C', { boundElements: [{ id: 'L', type: 'text' }] }),
      text('L', 'C'),
      rect('R'),
    )
    local(scene, 'R', { isDeleted: true })
    h.record(scene)
    install(scene, h.undo(scene))
    expect(scene.get('R')?.isDeleted).toBe(false)
    local(scene, 'L', { isDeleted: true })
    h.record(scene)
    remote(scene, h, 'C', { isDeleted: true })
    const res = h.undo(scene)
    expect(res?.skips).toEqual([{ id: 'L', what: 'element', reason: 'orphan', silent: false }])
    local(scene, 'R', { isDeleted: true })
    h.record(scene)
    scene.delete('R') // purged after 14 days
    h.absorb(undefined, undefined)
    expect(h.undo(scene)?.skips[0]?.reason).toBe('orphan')
  })

  it('a label leased by someone else keeps its text and layout; my other fields in the entry still apply', () => {
    const { scene, h } = start(
      note('N', { boundElements: [{ id: 'L', type: 'text' }] }),
      text('L', 'N', { originalText: 'a', text: 'a' }),
    )
    local(scene, 'L', { originalText: 'mine', text: 'mine', strokeColor: '#ff0000' })
    h.record(scene)
    const res = h.undo(scene, { isLeasedByOther: (id) => id === 'N' })
    install(scene, res)
    expect(scene.get('L')).toMatchObject({ originalText: 'mine', text: 'mine', strokeColor: '#1e1e1e' })
    expect(res?.skips.map((s) => [s.what, s.reason]).sort()).toEqual([
      ['originalText', 'locked'],
      ['text', 'locked'],
    ])
  })

  it('DEF-W3-2: undo of my create of a locked element unlocks it in the same patch (the room refuses a locked delete); redo locks it again', () => {
    const { scene, h } = start()
    // a template insert: a locked heading, a locked note with its label, an unlocked rectangle
    localCreate(scene, rect('H', { locked: true }))
    localCreate(scene, note('N', { locked: true, boundElements: [{ id: 'L', type: 'text' }] }))
    localCreate(scene, text('L', 'N'))
    localCreate(scene, rect('R'))
    h.record(scene)
    const res = h.undo(scene)
    expect(res?.patches.get('H')).toEqual({ isDeleted: true, locked: false })
    expect(res?.patches.get('N')).toEqual({ isDeleted: true, locked: false })
    // a label follows its container's lock; an unlocked element keeps its patch as before
    expect(res?.patches.get('L')).toEqual({ isDeleted: true })
    expect(res?.patches.get('R')).toEqual({ isDeleted: true })
    install(scene, res)
    expect(scene.get('H')).toMatchObject({ isDeleted: true, locked: false })
    const back = h.redo(scene)
    expect(back?.patches.get('H')).toEqual({ isDeleted: false, locked: true })
    expect(back?.patches.get('R')).toEqual({ isDeleted: false })
    install(scene, back)
    expect(scene.get('H')).toMatchObject({ isDeleted: false, locked: true })
    expect(scene.get('N')).toMatchObject({ isDeleted: false, locked: true })
  })

  it('redo mirrors undo, and redo of my create after my own undo revives it', () => {
    const { scene, h } = start()
    localCreate(scene, rect('N'))
    h.record(scene)
    install(scene, h.undo(scene))
    expect(scene.get('N')?.isDeleted).toBe(true)
    install(scene, h.redo(scene))
    expect(scene.get('N')?.isDeleted).toBe(false)
    expect(h.undoSize).toBe(1)
  })

  it('an undo that is a no-op for a field (already back) is not a skip and is not redone', () => {
    const { scene, h } = start(rect('N', { x: 0 }))
    local(scene, 'N', { x: 10 })
    h.record(scene)
    remote(scene, h, 'N', { x: 0 }) // Bob moved it back
    const res = h.undo(scene)
    expect(res?.kept).toBe(0)
    expect(res?.patches.size).toBe(0)
    expect(h.redoSize).toBe(0)
  })

  it('recompute touches only the entry’s elements and never a leased label', () => {
    const { scene, h } = start(
      note('N', { x: 0, boundElements: [{ id: 'L', type: 'text' }] }),
      text('L', 'N'),
      rect('Q'),
    )
    local(scene, 'N', { x: 100 })
    h.record(scene)
    let touched: readonly string[] = []
    const res = h.undo(scene, {
      isLeasedByOther: (id) => id === 'N',
      recompute: (ids) => {
        touched = ids
        return new Map([
          ['L', { x: 5, text: 'relaid' }],
          ['A', { x: 1 }],
        ])
      },
    })
    expect(touched).toEqual(['N'])
    expect(res?.patches.get('L')).toBeUndefined() // the leased label's layout is not written
    expect(res?.patches.get('N')).toEqual({ x: 0 })
  })

  it('every key of every element type Lobby uses is classified (coverage for this module)', () => {
    const els = [
      newElement({ ...base, type: 'rectangle' } as never),
      newElement({ ...base, type: 'ellipse' } as never),
      newElement({ ...base, type: 'diamond' } as never),
      newStickyNoteElement({ ...base, type: 'stickynote' } as never),
      newTextElement({ ...base, text: 'x' } as never),
      newTextElement({ ...base, text: 'x', containerId: 'c' } as never),
      newArrowElement({ ...base, type: 'arrow' } as never),
      newArrowElement({ ...base, type: 'arrow', elbowed: true } as never),
      newLinearElement({ ...base, type: 'line' } as never),
      newFreeDrawElement({ ...base, type: 'freedraw', simulatePressure: true } as never),
      newImageElement({ ...base, type: 'image' } as never),
      newFrameElement({ ...base } as never),
    ] as unknown as (HistEl & Record<string, unknown>)[]
    const missing = Object.fromEntries(
      els.map((e) => [e.type + (e.containerId ? ':label' : ''), unclassifiedFields(e)]),
    )
    expect(Object.values(missing).flat()).toEqual([])
  })

  it('record() at 20,000 elements with one change', () => {
    const els = Array.from({ length: 20_000 }, (_, i) => rect(`e${i}`))
    const { scene, h } = start(...els)
    local(scene, 'e123', { x: 5 })
    const t0 = performance.now()
    const e = h.record(scene)
    const ms = performance.now() - t0
    expect(e?.changes.size).toBe(1)
    console.info(`A15 record() at 20,000 elements: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(200)
  })

  it('ack parsing: an ack for an unknown seq is harmless', () => {
    const { h } = start(rect('N'))
    const ack: Ack = { seq: 999, r: [{ id: 'N', ok: false, code: 'INVALID' }] }
    expect(() => h.onAck(ack)).not.toThrow()
  })
})
